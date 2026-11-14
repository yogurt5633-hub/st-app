// Uses the actual HTML/JS with an Android bridge and SillyTavern API fixture.
// No real chats, provider requests or credentials are used.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
const root=path.resolve(import.meta.dirname,'../..');
const output=process.env.REVIEW_OUTPUT || '/tmp/tavernka-review/screens';
await fs.mkdir(output,{recursive:true});
let translations=0;
const server=http.createServer(async(req,res)=>{
 const url=new URL(req.url,'http://localhost');
 if(url.pathname==='/fixture.html'){res.setHeader('Content-Type','text/html');res.end('<!doctype html><html><body></body></html>');return;}
 if((url.pathname.startsWith('/api/')&&!url.pathname.includes('/app/'))||url.pathname==='/csrf-token'){
  res.setHeader('Content-Type','application/json');
  if(url.pathname.startsWith('/api/translate/')){ translations++; res.setHeader('Content-Type','text/plain');res.end('Привет, мир.');return; }
  let data={};
  if(url.pathname==='/csrf-token')data={token:'fixture'};
  if(url.pathname.endsWith('/status'))data={version:'0.4.25',remarks:false,connectionCheck:{ok:false,message:'Нет подключения',model:'Test'}};
  if(url.pathname.endsWith('/proposals')||url.pathname.endsWith('/chats'))data={items:[],mode:'recent'};
  if(url.pathname.endsWith('/settings'))data={models:{},translation:{}};
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
 for(const theme of ['dark','light','black','white','brown'])for(const width of [320,390]){
  const context=await browser.newContext({viewport:{width,height:844},isMobile:true,hasTouch:true,colorScheme:['light','white'].includes(theme)?'light':'dark',reducedMotion:'reduce'});
  const page=await context.newPage();observe(page);
  await page.addInitScript(({theme})=>{
   const state={resolvedTheme:theme,theme,accent:'amber',onboardingDone:false,stUp:false,termuxInstalled:true,termuxPermission:true,termuxReady:true,lastCheck:Date.now()};
   window.bridgeState=state;
   window.KorrektorApp=new Proxy({state:()=>JSON.stringify(state),sites:()=>JSON.stringify([]),finishOnboarding:()=>{state.onboardingDone=true;}},{get:(o,k)=>o[k]||(()=>{})});
  },{theme});
  await page.goto(`${origin}/android/app/src/main/assets/home.html`);await decoded(page);
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
  await page.getByText('Оформление',{exact:true}).first().click();
  assert.equal(await page.locator('.settings-group[open]').count(),1);
  if(width===390)await page.screenshot({path:`${output}/home-${theme}.png`,fullPage:true});
  await page.evaluate(()=>document.body.style.fontSize='24px');await noOverflow(page);
  await context.close();
 }
 const context=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true});
 const page=await context.newPage();observe(page);
 await page.goto(`${origin}/api/plugins/korrektor/app/index.html#tools`);
 await page.getByRole('heading',{name:'Подключение к модели'}).waitFor();
 assert.equal(await page.locator('#view .mascot').count(),0,'no cheerful mascot beside a connection error');
 await noOverflow(page);

 await page.waitForFunction(()=>navigator.serviceWorker.controller,null,{timeout:10000});
 assert.ok(await page.evaluate(async()=>Boolean(await caches.match('img/mascot.png'))),'mascot precached');
 await page.goto(`${origin}/api/plugins/korrektor/app/index.html#feed`);await page.getByText('Замечания выключены',{exact:true}).waitFor();await decoded(page);
 await page.screenshot({path:`${output}/feed.png`});
 await context.setOffline(true);await page.reload();
 await page.getByText('Нет связи с SillyTavern',{exact:true}).waitFor();
 assert.equal(await page.locator('#view .mascot').count(),0);
 await context.close();
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
 console.log('PASS: 10 mobile/theme combinations, all onboarding steps, enlarged text, API error, offline cache, manual translation, original restoration, keyboard action, no automatic requests.');
}finally{await browser.close();await new Promise(r=>server.close(r));}
