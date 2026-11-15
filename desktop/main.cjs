const {app, BrowserWindow, WebContentsView, ipcMain, dialog, session} = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const {pathToFileURL} = require('node:url');
const {spawn} = require('node:child_process');
const {serverURL, pageURL, sameOrigin, localConfig} = require('./core.cjs');
let win, child, installer, quitting = false, busy = false, selected = 'home';
let prefs = {url: 'http://127.0.0.1:8000', folder: ''};
let message = 'Выберите установленную Таверну или подключитесь по адресу.';
const views = new Map();
const homeFile = path.join(__dirname, 'ui', 'index.html');
const settingsFile = () => path.join(app.getPath('userData'), 'connection.json');
const snapshot = () => ({...prefs, running: Boolean(child), busy, selected, message});
function announce(text) { if (text) message = text; if (win && !win.isDestroyed()) win.webContents.send('state', snapshot()); }
function save() { fs.writeFileSync(settingsFile(), JSON.stringify(prefs)); }
function layout() {
  if (!win || win.isDestroyed()) return;
  const [width, height] = win.getContentSize();
  for (const [name, view] of views) {
    view.setVisible(name === selected);
    view.setBounds({x: 0, y: 104, width, height: Math.max(0, height - 104)});
  }
}
function clearViews() {
  for (const view of views.values()) { win.contentView.removeChildView(view); view.webContents.close(); }
  views.clear(); selected = 'home'; layout();
}
async function select(name) {
  if (name === 'home') { selected = name; layout(); announce(); return; }
  const target = pageURL(prefs.url, name);
  selected = name;
  if (!views.has(name)) {
    const origin = prefs.url;
    const view = new WebContentsView({webPreferences: {partition: 'persist:tavernka', nodeIntegration: false, contextIsolation: true, sandbox: true}});
    views.set(name, view); win.contentView.addChildView(view);
    const wc = view.webContents;
    wc.setWindowOpenHandler(({url}) => {
      if (sameOrigin(url, origin)) wc.loadURL(url).catch(() => {});
      return {action: 'deny'};
    });
    for (const event of ['will-navigate', 'will-redirect']) wc.on(event, (e, url) => { if (!sameOrigin(url, origin)) e.preventDefault(); });
    wc.on('will-attach-webview', event => event.preventDefault());
    wc.on('did-fail-load', (_e, code, _desc, _url, mainFrame) => {
      if (code === -3 || !mainFrame) return;
      selected = 'home'; layout(); announce('Сервер недоступен. Проверьте адрес, запуск Таверны и доступ по сети. Затем откройте вкладку повторно.');
      views.delete(name); win.contentView.removeChildView(view); wc.close();
    });
    wc.on('render-process-gone', () => { views.delete(name); win.contentView.removeChildView(view); selected = 'home'; layout(); announce('Вкладка закрылась. Откройте её повторно.'); });
    wc.loadURL(target).catch(() => {});
  }
  layout(); announce();
}
function runNode(args, cwd) {
  return spawn(process.execPath, args, {cwd, windowsHide: true, shell: false, env: {...process.env, ELECTRON_RUN_AS_NODE: '1'}, stdio: ['ignore', 'pipe', 'pipe']});
}
async function stop() {
  const owned = child;
  if (!owned) return;
  await new Promise(resolve => {
    const timer = setTimeout(() => { owned.kill('SIGKILL'); }, 5000);
    owned.once('exit', () => { clearTimeout(timer); resolve(); });
    owned.kill();
  });
}
function handle(channel, fn) {
  ipcMain.handle(channel, async (event, ...args) => {
    if (event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame || event.senderFrame.url !== pathToFileURL(homeFile).href) throw new Error('Untrusted sender');
    try { const value = await fn(...args); return {ok: true, value, state: snapshot()}; }
    catch (error) { announce(error.message); return {ok: false, error: error.message, state: snapshot()}; }
  });
}
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
  app.on('login', (event, contents, details, authInfo, callback) => {
    event.preventDefault();
    if (authInfo.isProxy || !sameOrigin(details.url, prefs.url) || ![...views.values()].some(view => view.webContents === contents)) { callback(); return; }
    const auth = new BrowserWindow({parent: win, modal: true, width: 480, height: 440, resizable: false, autoHideMenuBar: true, webPreferences: {preload: path.join(__dirname, 'auth-preload.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true}});
    let completed = false;
    const finish = value => {
      if (completed) return;
      completed = true; ipcMain.removeListener('auth-response', receive);
      if (value && typeof value.username === 'string' && typeof value.password === 'string') callback(value.username, value.password);
      else callback();
      if (!auth.isDestroyed()) auth.close();
    };
    const receive = (e, value) => {
      if (e.sender === auth.webContents && e.senderFrame === auth.webContents.mainFrame) finish(value);
    };
    ipcMain.on('auth-response', receive);
    auth.on('closed', () => finish(null));
    auth.webContents.setWindowOpenHandler(() => ({action:'deny'}));
    auth.webContents.on('will-navigate', e => e.preventDefault());
    auth.webContents.on('did-finish-load', () => auth.webContents.send('auth-host', authInfo.host));
    auth.loadFile(path.join(__dirname, 'ui/auth.html'));
  });
  app.whenReady().then(() => {
    try { const stored = JSON.parse(fs.readFileSync(settingsFile(), 'utf8')); prefs = {url: serverURL(stored.url), folder: String(stored.folder || '')}; } catch {}
    session.fromPartition('persist:tavernka').setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
    session.fromPartition('persist:tavernka').setPermissionCheckHandler(() => false);
    win = new BrowserWindow({width: 1160, height: 820, minWidth: 720, minHeight: 580, title: 'Тавернка', autoHideMenuBar: true, backgroundColor: '#191816', webPreferences: {preload: path.join(__dirname, 'preload.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true}});
    win.webContents.setWindowOpenHandler(() => ({action: 'deny'}));
    win.webContents.on('will-navigate', e => e.preventDefault());
    win.on('resize', layout);
    win.on('close', event => { if (busy) { event.preventDefault(); announce('Дождитесь окончания установки Корректора, затем закройте приложение.'); } });
    handle('state', () => snapshot());
    handle('choose-folder', async () => {
      if (child || busy) throw new Error('Сначала остановите Таверну.');
      const result = await dialog.showOpenDialog(win, {properties: ['openDirectory'], title: 'Папка установленной SillyTavern'});
      if (result.canceled) return;
      const folder = result.filePaths[0]; const config = localConfig(folder);
      prefs = {folder, url: config.url}; save(); clearViews(); announce('Папка выбрана. Установите Корректор, затем запустите Таверну.');
    });
    handle('connect', async url => {
      if (child || busy) throw new Error('Сначала остановите локальную Таверну.');
      prefs.url = serverURL(url); save(); clearViews(); await select('tavern');
    });
    handle('tab', select);
    handle('reload', () => views.get(selected)?.webContents.reload());
    handle('install', async () => {
      if (child || busy) throw new Error('Сначала остановите Таверну.');
      const config = localConfig(prefs.folder);
      const answer = await dialog.showMessageBox(win, {type: 'question', buttons: ['Отмена', 'Установить'], defaultId: 1, cancelId: 0, message: 'Установить Корректор в выбранную Таверну?', detail: 'Закройте её, если она запущена отдельно. Плагин и расширение будут обновлены. Перед этим сохраним их копии и config.yaml.'});
      if (answer.response !== 1) return;
      busy = true; announce('Сохраняю копию и устанавливаю Корректор…');
      try {
        const backup = path.join(prefs.folder, '.tavernka-backups', String(Date.now()));
        fs.mkdirSync(backup, {recursive: true});
        fs.copyFileSync(config.configPath, path.join(backup, 'config.yaml'));
        for (const relative of ['plugins/korrektor', ...(fs.existsSync(path.join(prefs.folder, 'data')) ? fs.readdirSync(path.join(prefs.folder, 'data')) : []).map(user => `data/${user}/extensions/korrektor-sync`)]) {
          const source = path.join(prefs.folder, relative);
          if (fs.existsSync(source)) fs.cpSync(source, path.join(backup, relative), {recursive: true});
        }
        const bundle = app.isPackaged ? path.join(process.resourcesPath, 'bundle') : path.resolve(__dirname, '..');
        await new Promise((resolve, reject) => {
          installer = runNode([path.join(bundle, 'scripts/install.mjs'), prefs.folder], prefs.folder);
          installer.stdout.resume(); installer.stderr.resume();
          installer.once('error', reject);
          installer.once('exit', code => code === 0 ? resolve() : reject(new Error(`Установка завершилась с кодом ${code}. Копия сохранена: ${backup}`)));
        });
        announce('Корректор установлен. Теперь запустите Таверну.');
      } finally { installer = null; busy = false; announce(); }
    });
    handle('start', async () => {
      if (child || busy) throw new Error('Таверна уже запускается или работает.');
      const config = localConfig(prefs.folder);
      if (!fs.existsSync(path.join(prefs.folder, 'node_modules'))) throw new Error('Сначала завершите установку SillyTavern через её Start.bat.');
      prefs.url = config.url; save(); clearViews();
      child = runNode([path.join(prefs.folder, 'server.js'), '--browserLaunchEnabled=false'], prefs.folder);
      const owned = child;
      // Do not forward server logs: they can contain prompts and private data.
      owned.stdout.resume(); owned.stderr.resume();
      owned.once('error', error => { child = null; announce(`Не удалось запустить: ${error.message}`); });
      owned.once('exit', code => { if (child === owned) child = null; announce(`Таверна остановлена${code ? ` (код ${code})` : ''}.`); });
      announce('Таверна запускается. Через несколько секунд откройте вкладку «Таверна».');
    });
    handle('stop', async () => { await stop(); announce('Таверна остановлена.'); });
    win.loadFile(homeFile);
  });
  app.on('before-quit', event => {
    if (busy) { event.preventDefault(); announce('Дождитесь окончания установки Корректора.'); return; }
    if ((!child && !installer) || quitting) return;
    event.preventDefault(); quitting = true;
    installer?.kill(); stop().finally(() => app.quit());
  });
  app.on('window-all-closed', () => app.quit());
}
