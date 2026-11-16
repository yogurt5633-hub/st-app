import {_electron as electron} from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
const root = path.resolve(import.meta.dirname, '../..');
const fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'tavernka-desktop-'));
const screenshots = path.join(root, 'desktop/screens');
await fs.mkdir(screenshots, {recursive:true});
await fs.mkdir(path.join(fixture, 'data/default-user'), {recursive:true});
await fs.mkdir(path.join(fixture, 'node_modules'));
await fs.writeFile(path.join(fixture, 'data/default-user/settings.json'), '{}');
await fs.writeFile(path.join(fixture, 'package.json'), JSON.stringify({name:'SillyTavern',type:'module'}));
await fs.writeFile(path.join(fixture, 'config.yaml'), 'port: 18763\nenableServerPlugins: false\n');
await fs.writeFile(path.join(fixture, 'server.js'), `import http from 'node:http'; http.createServer((req,res)=>{if(req.url==='/auth' && req.headers.authorization!=='Basic '+Buffer.from('fixture:test').toString('base64')){res.writeHead(401,{'WWW-Authenticate':'Basic realm=fixture'});res.end();return;}res.setHeader('Content-Type','text/html'); res.end('<!doctype html><html><body><h1>Tavern fixture</h1><a href="https://example.org/">External</a></body></html>');}).listen(18763,'127.0.0.1');`);
const app = await electron.launch(process.env.TAVERNKA_EXE ? {executablePath:process.env.TAVERNKA_EXE} : {args:[path.join(root,'desktop')],executablePath:path.join(root,'desktop/node_modules/electron/dist',process.platform==='win32'?'electron.exe':'electron')});
try {
  const home = await app.firstWindow();
  await home.getByRole('heading',{name:'Ваши истории, в одном окне'}).waitFor();
  await app.evaluate(({dialog}, folder) => {
    dialog.showOpenDialog = async () => ({canceled:false,filePaths:[folder]});
    dialog.showMessageBox = async () => ({response:1});
  }, fixture);
  await home.getByRole('button',{name:'Выбрать папку',exact:true}).click();
  await home.getByRole('button',{name:'Установить Корректор',exact:true}).click();
  await home.getByText('Корректор установлен. Теперь запустите Таверну.',{exact:true}).waitFor();
  assert.ok((await fs.readFile(path.join(fixture,'config.yaml'),'utf8')).includes('enableServerPlugins: true'));
  assert.ok((await fs.readdir(path.join(fixture,'.tavernka-backups'))).length);
  await fs.access(path.join(fixture,'plugins/korrektor/index.mjs'));
  await fs.access(path.join(fixture,'data/default-user/extensions/korrektor-sync/index.js'));
  await home.getByRole('button',{name:'Запустить',exact:true}).click();
  await home.getByRole('button',{name:'Остановить',exact:true}).waitFor({state:'visible'});
  let ready = false;
  for (let i=0; i<50; i++) { try { ready=(await fetch('http://127.0.0.1:18763')).ok; } catch {} if(ready)break; await new Promise(r=>setTimeout(r,200)); }
  assert.ok(ready,'bundled runtime starts server');
  await home.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  assert.equal(await home.locator('header').evaluate(element => element.getBoundingClientRect().top), 0, 'navigation remains visible when home scrolls');
  await home.evaluate(() => window.scrollTo(0, 0));
  await home.screenshot({path:path.join(screenshots,'windows-home.png')});
  for (const label of ['Таверна','Каталог','Настройки']) {
    await home.getByRole('button',{name:label,exact:true}).click();
    await home.waitForTimeout(500);
  }
  const remote = await app.evaluate(({webContents}) => webContents.getAllWebContents().filter(w=>w.getURL().startsWith('http://127.0.0.1:18763')).map(w=>({url:w.getURL(),prefs:w.getLastWebPreferences()})));
  assert.equal(remote.length,3);
  for(const entry of remote){ assert.equal(entry.prefs.nodeIntegration,false); assert.equal(entry.prefs.sandbox,true); assert.equal(entry.prefs.contextIsolation,true); assert.ok(!entry.prefs.preload); }
  await app.evaluate(async ({webContents}) => {
    for(const wc of webContents.getAllWebContents().filter(w=>w.getURL().startsWith('http://127.0.0.1:18763'))) {
      if(await wc.executeJavaScript('typeof window.tavernka') !== 'undefined')throw new Error('privileged API leaked');
      await wc.executeJavaScript('document.querySelector("a").click()');
    }
  });
  await home.waitForTimeout(300);
  assert.ok((await app.evaluate(({webContents})=>webContents.getAllWebContents().filter(w=>w.getType()==='window').map(w=>w.getURL()))).every(url=>!url.startsWith('https://example.org')));
  const loginOpened = app.waitForEvent('window');
  await app.evaluate(({webContents}) => {
    webContents.getAllWebContents().find(w=>w.getURL().startsWith('http://127.0.0.1:18763')).loadURL('http://127.0.0.1:18763/auth').catch(()=>{});
  });
  const login = await loginOpened;
  await login.getByLabel('Логин',{exact:true}).fill('fixture');
  await login.getByLabel('Пароль',{exact:true}).fill('test');
  await login.getByRole('button',{name:'Войти',exact:true}).click();
  await home.waitForTimeout(500);
  assert.ok(await app.evaluate(async ({webContents}) => {
    const wc=webContents.getAllWebContents().find(w=>w.getURL()==='http://127.0.0.1:18763/auth');
    return wc && (await wc.executeJavaScript('document.body.textContent')).includes('Tavern fixture');
  }), 'password-protected server opens after native login');
  await home.getByRole('button',{name:'Главная',exact:true}).click();
  await home.getByRole('button',{name:'Остановить',exact:true}).click();
  await home.getByText('Таверна остановлена.',{exact:true}).waitFor();
  await home.locator('#url').fill('https://user:secret@example.org');
  await home.getByRole('button',{name:'Подключиться',exact:true}).click();
  await home.getByText('Укажите только адрес сервера и порт, без пароля, пути и параметров.',{exact:true}).waitFor();
  console.log('Packaged app: installer backup, bundled Node, tabs, isolation, navigation, stop, URL validation passed.');
} finally {await app.close(); await fs.rm(fixture,{recursive:true,force:true});}
