// Uses the actual HTML/JS with an Android bridge and SillyTavern API fixture.
// No real chats, provider requests or credentials are used.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { cleanItems } from '../../plugin/lib/catalog.mjs';
import { DEFAULT_SETTINGS } from '../../plugin/lib/store.mjs';
const root=path.resolve(import.meta.dirname,'../..');
const output=process.env.REVIEW_OUTPUT || '/tmp/tavernka-review/screens';
await fs.mkdir(output,{recursive:true});
let translations=0;
let catalogItems=[];
const publications=[];
const repositoryRequests=[];
const uploadRequests=[];
const server=http.createServer(async(req,res)=>{
 const url=new URL(req.url,'http://localhost');
 if(url.pathname==='/fixture.html'){res.setHeader('Content-Type','text/html');res.end('<!doctype html><html><body></body></html>');return;}
 if((url.pathname.startsWith('/api/')&&!url.pathname.includes('/app/'))||url.pathname==='/csrf-token'){
  res.setHeader('Content-Type','application/json');
  if(url.pathname.startsWith('/api/translate/')){ translations++; res.setHeader('Content-Type','text/plain');res.end('Привет, мир.');return; }
  let data={};
  let body={};
  if(req.method==='POST'){
   const chunks=[];for await(const chunk of req)chunks.push(chunk);
   const bytes=Buffer.concat(chunks);
   if(req.headers['content-type']?.includes('json'))body=JSON.parse(bytes.toString()||'{}');
   if(url.pathname.endsWith('/catalog/upload'))uploadRequests.push({type:url.searchParams.get('type'),bytes:bytes.length});
  }
  if(url.pathname.endsWith('/catalog'))data={items:catalogItems};
  if(url.pathname.endsWith('/catalog/local')||url.pathname.endsWith('/cards-health'))data={items:[]};
  if(url.pathname.endsWith('/catalog/admin'))data={hasToken:true,login:'fixture',repo:'owner/fixture'};
  if(url.pathname.endsWith('/catalog/status'))data={installed:{}};
  if(url.pathname.endsWith('/catalog/regex'))data={global:[]};
  if(url.pathname.endsWith('/catalog/upload'))data={upload:'u111',title:'ZIP-расширение',removed:[]};
  if(url.pathname.endsWith('/catalog/upload-repository')){repositoryRequests.push(body);data={upload:'u222',title:'GitHub-расширение',page:body.url};}
  if(url.pathname.endsWith('/catalog/publish')){
   publications.push(body);
   const item=cleanItems({items:[{id:'published-'+publications.length,type:body.type,...body.meta,url:'https://example.org/extension.zip'}]})[0];
   catalogItems.unshift(item);data={item};
  }
  if(url.pathname.endsWith('/usage'))data={total:{roleplay:{input:0,output:0,cost:0,calls:0},korrektor:{input:0,output:0,cost:0}},byDay:[],expensive:[],models:[],chats:[]};
  if(url.pathname==='/csrf-token')data={token:'fixture'};
  if(url.pathname.endsWith('/status'))data={version:'0.4.29',remarks:false,optimizationPaused:true,connectionCheck:{ok:false,message:'Нет подключения',model:'Test'}};
  if(url.pathname.endsWith('/proposals')||url.pathname.endsWith('/chats'))data={items:[],mode:'recent'};
  if(url.pathname.endsWith('/settings'))data=DEFAULT_SETTINGS;
  if(url.pathname.endsWith('/worlds')||url.pathname.endsWith('/extensions/review'))data={items:[]};
  res.end(JSON.stringify(data));return;
 }
 try{
  const publicPath=url.pathname.replace('/api/plugins/korrektor/app/','/plugin/app/');
  const file=path.resolve(root,'.'+publicPath+(publicPath.endsWith('/')?'index.html':''));
  if(!file.startsWith(root+path.sep))throw new Error('outside root');
  const data=await fs.readFile(file);
  res.setHeader('Content-Type',({'html':'text/html','js':'text/javascript','css':'text/css','png':'image/png','webmanifest':'application/manifest+json'})[file.split('.').at(-1)]||'application/octet-stream');
  res.end(data);
 }catch{res.statusCode=404;res.end();}
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const origin=`http://127.0.0.1:${server.address().port}`;
const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||chromium.executablePath(),args:['--no-sandbox']});
const errors=[];
const observe=page=>page.on('pageerror',e=>errors.push(e.message));
async function decoded(page){await page.locator('img').evaluateAll(async imgs=>{await Promise.all(imgs.map(i=>i.decode()));});}
async function noOverflow(page,selector='body'){
 assert.equal(await page.locator(selector).evaluate(e=>e.scrollWidth>innerWidth+1),false,`horizontal overflow: ${selector}`);
}
try{
 const homeBgs=new Map();
 for(const theme of ['dark','light','midnight','mist','brown','system-dark','system-light'])for(const width of [320,390]){
  const context=await browser.newContext({viewport:{width,height:844},isMobile:true,hasTouch:true,colorScheme:['light','mist','system-light'].includes(theme)?'light':'dark',reducedMotion:'reduce'});
  const page=await context.newPage();observe(page);
  await page.addInitScript(({theme})=>{
   const state={resolvedTheme:theme.replace('system-',''),theme:theme.startsWith('system-')?'system':theme,accent:'amber',onboardingDone:false,stUp:false,termuxInstalled:true,termuxPermission:true,termuxReady:true,lastCheck:Date.now()};
   window.bridgeState=state;
   window.KorrektorApp=new Proxy({state:()=>JSON.stringify(state),sites:()=>JSON.stringify([]),finishOnboarding:()=>{state.onboardingDone=true;}},{get:(o,k)=>o[k]||(()=>{})});
  },{theme});
  await page.goto(`${origin}/android/app/src/main/assets/home.html`);await decoded(page);
  if(!theme.startsWith('system-')&&width===390)homeBgs.set(theme,await page.evaluate(()=>getComputedStyle(document.body).backgroundColor));
  assert.equal(await page.locator('.onb .mascot').count(),1);
  assert.equal(await page.locator('.onb .title').textContent(),'Тавернка');
  for(let step=1;step<=5;step++){
   await page.getByText(`Шаг ${step} из 5`,{exact:true}).waitFor();
   await noOverflow(page,'.onb');
   const button=page.locator('.onb-foot .btn.primary');
   assert.ok((await button.boundingBox()).height>=48);
   if(step===1&&width===390)await page.screenshot({path:`${output}/onboarding-${theme}.png`});
   if(step>1)assert.equal(await page.locator('.onb .mascot').count(),0);
   await button.click();
  }
  assert.equal(await page.locator('.onb').count(),0);
  assert.equal(await page.locator('.hello .mascot').count(),0);
  await noOverflow(page);
  assert.equal(await page.locator('.settings-group[open]').count(),0);
  assert.equal(await page.getByLabel('Команда запуска в Termux',{exact:true}).isVisible(),false);
  await page.getByText('Подключение и запуск',{exact:true}).click();
  await page.getByLabel('Команда запуска в Termux',{exact:true}).waitFor();
  await noOverflow(page);
  await page.getByText('Подключение и запуск',{exact:true}).click();
  await page.getByText('Оформление',{exact:true}).first().click();
  assert.equal(await page.locator('.settings-group[open]').count(),1);
  if(width===390)await page.screenshot({path:`${output}/home-${theme}.png`,fullPage:true});
  await page.getByRole('checkbox',{name:'Маскот на главной',exact:true}).uncheck();
  await page.waitForFunction(()=>!document.querySelector('.companion'));
  await page.getByRole('checkbox',{name:'Маскот на главной',exact:true}).check();
  await page.getByLabel('Тавернка: подсказки и реакции').click();
  await page.getByRole('button',{name:'Погладить',exact:true}).click();
  assert.match(await page.locator('.companion-message').textContent(),/Мур/);
  assert.equal(await page.locator('.companion .mascot').evaluate(e=>getComputedStyle(e).animationName),'none');
  await page.evaluate(()=>{window.bridgeState.stUp=true;window.onNative('state');});
  await page.getByRole('button',{name:'Ещё совет',exact:true}).click();
  await page.getByRole('button',{name:'Настройки глоссария',exact:true}).waitFor();
  await noOverflow(page);
  if(width===390)await page.screenshot({path:`${output}/companion-${theme}.png`,fullPage:true});
  await page.evaluate(()=>document.body.style.fontSize='24px');await noOverflow(page);
  await context.close();
 }
 assert.equal(new Set(homeBgs.values()).size,5,'all 5 explicit themes have distinct backgrounds');
 // Inspect every visible mascot placement in each explicit and system theme.
 for(const theme of ['dark','light','midnight','mist','brown','system-dark','system-light']){
  const context=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true,colorScheme:['light','mist','system-light'].includes(theme)?'light':'dark'});
  const page=await context.newPage();observe(page);
  await page.addInitScript(theme=>{if(!theme.startsWith('system-'))localStorage.setItem('korrektor.theme',theme);},theme);
  for(const [route,title] of [['feed','Оптимизация временно отключена'],['tools/catalog','Каталог пока пуст'],['tools/spend','Пока ничего не потрачено'],['tools/cards','Карточек нет'],['tools/muted','Ничего не скрыто']]){
   await page.goto(`${origin}/api/plugins/korrektor/app/index.html#${route}`);
   await page.getByRole('heading',{name:title,exact:true}).waitFor();await decoded(page);await noOverflow(page);
   await page.screenshot({path:`${output}/${route.replace('/','-')}-${theme}.png`,fullPage:true});
  }
  await context.close();
 }
 const context=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true});
 const page=await context.newPage();observe(page);
 await page.goto(`${origin}/api/plugins/korrektor/app/index.html#tools`);
 await page.getByRole('link',{name:/Резервная копия/}).waitFor();
 assert.equal(await page.getByText('Подключение к модели',{exact:true}).count(),0);
 assert.equal(await page.locator('#view .mascot').count(),0,'no cheerful mascot beside a connection error');

 await noOverflow(page);

 await page.waitForFunction(()=>navigator.serviceWorker.controller,null,{timeout:10000});
 assert.ok(await page.evaluate(async()=>Boolean(await caches.match('img/mascot.png'))),'mascot precached');
 await page.goto(`${origin}/api/plugins/korrektor/app/index.html#settings`);
 await page.locator('.settings-group summary').first().waitFor();
 assert.equal(await page.locator('.settings-group[open]').count(),0);
 assert.equal(await page.locator('.settings-group summary').filter({hasText:/^(Проверка|Что искать|Пороги|Резюме и факты)$/}).count(),0);
 await noOverflow(page);
 await page.screenshot({path:`${output}/settings.png`,fullPage:true});
 await page.goto(`${origin}/api/plugins/korrektor/app/index.html#tools/catalog`);
 await page.getByRole('button',{name:'Расширения',exact:true}).click();
 await page.getByText('Проверить установленные расширения',{exact:true}).click();
 await page.getByText('Сторонние расширения пока не установлены',{exact:true}).waitFor();
 assert.equal(await page.locator('.tab[aria-current="page"]').getAttribute('data-tab'),'tools');
 await noOverflow(page);
 await page.screenshot({path:`${output}/extensions.png`,fullPage:true});
 await page.goto(`${origin}/api/plugins/korrektor/app/index.html#tools/import`);
 await page.getByText('Импорт по ссылке временно отключён',{exact:true}).waitFor();
 await page.goto(`${origin}/api/plugins/korrektor/app/index.html#feed`);await page.getByText('Оптимизация временно отключена',{exact:true}).waitFor();await decoded(page);
 assert.equal(await page.locator('#page-title').textContent(),'Оптимизация');
 assert.equal(await page.locator('.tab[aria-current="page"]').getAttribute('data-tab'),'optimization');
 await page.locator('.optimization-switch').getByRole('link',{name:'Чаты',exact:true}).click();
 await page.getByRole('heading',{name:'Чатов пока нет',exact:true}).waitFor();
 assert.equal(await page.locator('.tab[aria-current="page"]').getAttribute('data-tab'),'optimization');
 await page.locator('.tab[data-tab="tavern"]').click();
 await page.getByRole('heading',{name:'Раздел в разработке',exact:true}).waitFor();
 assert.equal(await page.locator('.tab[aria-current="page"]').getAttribute('data-tab'),'tavern');
 await noOverflow(page);
 await page.goto(`${origin}/api/plugins/korrektor/app/index.html#feed`);await page.getByText('Оптимизация временно отключена',{exact:true}).waitFor();await decoded(page);
 await page.screenshot({path:`${output}/feed.png`});
 await page.getByRole('button',{name:'Совет Тавернки',exact:true}).click();
 await page.locator('#sheet').getByRole('link',{name:'Каталог',exact:true}).waitFor();
 await page.goto(`${origin}/api/plugins/korrektor/app/index.html#feed`);
 await context.setOffline(true);await page.reload();
 await page.getByText('Нет связи с SillyTavern',{exact:true}).waitFor();
 assert.equal(await page.locator('#view .mascot').count(),0);
 await context.close();
 // Inside the Android app, the catalog opens as its own bottom-bar tab without the settings tabbar.
 const appContext=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true,userAgent:'Mozilla/5.0 KorrektorApp/1.0'});
 const appPage=await appContext.newPage();observe(appPage);
 await appPage.goto(`${origin}/api/plugins/korrektor/app/index.html#tools/catalog`);
 await appPage.getByRole('heading',{name:'Каталог пока пуст',exact:true}).waitFor();
 assert.equal(await appPage.locator('.tabbar').isVisible(),false);
 assert.equal(await appPage.locator('.back-link').count(),0);
 await appPage.goto(`${origin}/api/plugins/korrektor/app/index.html#settings`);
 await appPage.locator('.settings-group summary').first().waitFor();
 assert.equal(await appPage.locator('.tabbar').isVisible(),true);
 assert.deepEqual(await appPage.locator('.tabbar .tab span:not(.tab-count)').allTextContents(),['Оптимизация','Ещё','Настройки','Таверна']);
 await appContext.close();
 // Catalog filters and the hidden author panel use the actual forms with a fake publishing API.
 catalogItems=cleanItems({items:[
  {id:'en',type:'extension',name:'English extension',url:'https://example.org/en.zip',language:'en',translated:false},
  {id:'ru',type:'card',name:'Русская карточка',url:'https://example.org/ru.png',language:'ru',translated:true},
  {id:'th',type:'preset',name:'Thai preset',url:'https://example.org/th.json',language:'th'},
  {id:'zh',type:'lorebook',name:'Chinese lore',url:'https://example.org/zh.json',language:'zh',translated:false},
 ]});
 const authorContext=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true});
 const author=await authorContext.newPage();observe(author);
 await author.goto(`${origin}/api/plugins/korrektor/app/index.html#tools/catalog`);
 await author.locator('.catalog-item').nth(3).waitFor();
 await author.getByLabel('Все языки',{exact:true}).selectOption('ru');
 await author.getByLabel('Перевод: любой',{exact:true}).selectOption('yes');
 assert.equal(await author.locator('.catalog-item').count(),1);
 await author.getByRole('heading',{name:'Русская карточка',exact:true}).waitFor();
 await author.getByLabel('Все языки',{exact:true}).selectOption('');
 await author.getByLabel('Перевод: любой',{exact:true}).selectOption('no');
 assert.equal(await author.locator('.catalog-item').count(),2);
 await author.getByLabel('Все языки',{exact:true}).selectOption('th');
 assert.equal(await author.locator('.catalog-item').count(),0);
 await author.getByLabel('Перевод: любой',{exact:true}).selectOption('');
 await author.getByRole('heading',{name:'Thai preset',exact:true}).waitFor();
 await author.getByLabel('Все языки',{exact:true}).selectOption('en');
 await author.getByRole('button',{name:'Расширения',exact:true}).click();
 await author.getByRole('heading',{name:'English extension',exact:true}).waitFor();
 await noOverflow(author);
 await author.screenshot({path:`${output}/catalog-languages.png`,fullPage:true});
 const title=await author.locator('#page-title').boundingBox();
 await author.mouse.move(title.x+title.width/2,title.y+title.height/2);await author.mouse.down();await author.waitForTimeout(800);await author.mouse.up();
 await author.getByRole('button',{name:'Расширение',exact:true}).click();
 await author.locator('input[type="file"][accept*="zip"]').setInputFiles({name:'extension.zip',mimeType:'application/zip',buffer:Buffer.from('fixture archive; ZIP validation is covered by server tests')});
 await author.getByText('Файл подходит: extension.zip',{exact:true}).waitFor();
 await author.getByRole('textbox',{name:/^Автор/}).fill('Автор');
 await author.getByLabel('Язык материала',{exact:true}).selectOption('ru');
 await author.getByLabel('Наличие перевода',{exact:true}).selectOption('yes');
 await author.getByRole('checkbox',{name:/Автор разрешил распространять/}).check();
 await noOverflow(author);await author.screenshot({path:`${output}/catalog-author-extension.png`,fullPage:true});
 await author.getByRole('button',{name:'Опубликовать',exact:true}).click();
 await author.getByRole('heading',{name:'ZIP-расширение',exact:true}).waitFor();
 assert.equal(uploadRequests.at(-1).type,'extension');
 assert.equal(publications.at(-1).upload,'u111');
 assert.equal(publications.at(-1).meta.language,'ru');assert.equal(publications.at(-1).meta.translated,true);
 await author.getByRole('button',{name:'Расширение',exact:true}).click();
 await author.getByRole('button',{name:'Ссылка GitHub',exact:true}).click();
 await author.getByLabel('Репозиторий расширения',{exact:true}).fill('https://github.com/author/extension');
 await author.getByRole('button',{name:'Загрузить с GitHub',exact:true}).click();
 await author.getByText('Загружено: GitHub-расширение. Можно публиковать',{exact:true}).waitFor();
 await author.getByRole('textbox',{name:/^Автор/}).fill('Автор');
 await author.getByLabel('Язык материала',{exact:true}).selectOption('zh');
 await author.getByLabel('Наличие перевода',{exact:true}).selectOption('no');
 await author.getByRole('checkbox',{name:/Автор разрешил распространять/}).check();
 await author.getByRole('button',{name:'Опубликовать',exact:true}).click();
 await author.getByRole('heading',{name:'GitHub-расширение',exact:true}).waitFor();
 assert.equal(repositoryRequests.at(-1).url,'https://github.com/author/extension');
 assert.equal(publications.at(-1).upload,'u222');assert.equal(publications.at(-1).type,'extension');
 assert.equal(publications.at(-1).meta.language,'zh');assert.equal(publications.at(-1).meta.translated,false);
 await authorContext.close();
 // Host DOM follows SillyTavern release/public/index.html: .mes_buttons contains .extraMesButtons.
 const chat=await browser.newPage({viewport:{width:390,height:844},isMobile:true,hasTouch:true});observe(chat);
 await chat.goto(`${origin}/fixture.html`);
 await chat.setContent(`<meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="${origin}/st-extension/style.css"><style>.extraMesButtons,#message_template{display:none}.mes_buttons{display:flex}.mes_text{padding:16px}</style><div id="extensionsMenu"></div><select id="translation_auto_mode"><option value="responses" selected>responses</option><option value="none">none</option></select><div id="message_template"><div class="mes" mesid=""><div class="mes_buttons"><div class="extraMesButtons"></div></div></div></div><div id="chat"><div class="mes" mesid="0"><div class="mes_buttons"><div class="extraMesButtons"></div></div><div class="mes_text">Hello world.</div></div></div>`);
 await chat.evaluate(async(origin)=>{
  const handlers={};window.emitFixture=type=>(handlers[type]||[]).forEach(f=>f(0));
  window.saved=0;window.fixtureChat=[{mes:'Hello world.',name:'Test',extra:{}}];
  window.toastr={info(){},success(){},error(){},warning(){}};
  window.jQuery=el=>({val(v){el.value=v;return this;},trigger(){return this;}});
  window.SillyTavern={getContext:()=>({chat:window.fixtureChat,extensionSettings:{},getCurrentChatId:()=> 'fixture',getRequestHeaders:()=>({'Content-Type':'application/json'}),saveChat:async()=>{window.saved++;},updateMessageBlock:(id,m)=>{document.querySelector('.mes_text').textContent=m.extra?.display_text||m.mes;},eventTypes:{CHARACTER_MESSAGE_RENDERED:'render',USER_MESSAGE_RENDERED:'user',CHAT_CHANGED:'chat',MORE_MESSAGES_LOADED:'more',MESSAGE_SWIPED:'swipe'},eventSource:{on:(type,fn)=>(handlers[type]||=[]).push(fn)}})};
  localStorage.setItem('korrektor.translate',JSON.stringify({auto:true,engine:'google',lang:'ru',gradual:false}));
  const mod=await import(`${origin}/st-extension/translate.js`);mod.initTranslate();
  window.fixtureSettings=mod.settings;
  mod.setAuto(true);
 },origin);
 await chat.waitForFunction(()=>document.querySelector('#chat .korrektor_mes_translate'));
 assert.equal(await chat.evaluate(()=>window.fixtureSettings().auto),false);
 assert.equal(await chat.locator('#translation_auto_mode').inputValue(),'none');
 await chat.evaluate(()=>{for(const t of ['render','chat','more','swipe','user'])window.emitFixture(t);});
 await chat.waitForTimeout(100);
 assert.equal(translations,0,'render and chat events never translate automatically');
 assert.equal(await chat.locator('#chat .korrektor_mes_translate').count(),1,'no duplicate actions');
 const action=chat.locator('#chat .korrektor_mes_translate');
 assert.ok((await action.boundingBox()).height>=47.5, '48 CSS px touch target (allow subpixel rounding)');
 await action.focus();await chat.keyboard.press('Enter');
 await chat.waitForFunction(()=>window.saved===1);assert.equal(translations,1);
 assert.equal(await chat.locator('.mes_text').textContent(),'Привет, мир.');
 assert.equal(await chat.evaluate(()=>window.fixtureChat[0].mes),'Hello world.');
 await action.focus();await chat.keyboard.press('Space');
 await chat.getByRole('button',{name:'Показать оригинал',exact:true}).click();
 await chat.waitForFunction(()=>window.saved===2);
 assert.equal(await chat.locator('.mes_text').textContent(),'Hello world.');
 await chat.close();
 assert.deepEqual(errors,[]);
 console.log('PASS: 14 mobile/theme combinations, all mascot screens, catalog languages and ZIP/GitHub author uploads, all onboarding steps, enlarged text, API error, offline cache, manual translation, original restoration, keyboard action, no automatic requests.');
}finally{await browser.close();await new Promise(r=>server.close(r));}
