const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app, dialog, BrowserWindow } = require('electron');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lily-recovery-ui-'));
app.setPath('userData', path.join(root,'profile'));
app.disableHardwareAcceleration();
let ui;
const timer = setTimeout(()=>finish(1),30000);
function finish(code) {
  clearTimeout(timer);ui?.dispose();
  try { require('./lib/electron-test-cleanup.cjs')(root); } catch { code=1; }
  app.exit(code);
}
app.whenReady().then(async()=>{
  const { openDatabaseRecoveryWindow } = require('../src/main/database-recovery-window');
  let consent=false, healthy=false;const calls=[];
  const service={run:async(action,id)=>{
    calls.push({action,id});
    if(action==='inspect')return {ok:healthy,reason:'corrupt'};
    if(action==='prepare')return {ok:true,candidates:[{id:'backup',createdAt:Date.now(),messageCount:25,sessionCount:2,sourceKind:'auto_backup'}]};
    if(action==='restore'){healthy=true;return {ok:true,receipt:{id:'restored'}};}
  }};
  ui=await openDatabaseRecoveryWindow({service,locale:'zh-CN',confirm:async()=>consent});
  const evaluate=code=>ui.window.webContents.executeJavaScript(code);
  const until=async code=>{for(let i=0;i<100;i++){if(await evaluate(code))return;await new Promise(r=>setTimeout(r,20));}throw Error('UI did not reach '+code);};
  await until("document.body.dataset.phase==='blocked'");
  const foreign=new BrowserWindow({show:false,webPreferences:{preload:path.resolve(__dirname,'../src/recovery-preload.js'),contextIsolation:true,sandbox:true}});
  try {
    await foreign.loadFile(path.resolve(__dirname,'../src/renderer/recovery/index.html'));
    const denied=await foreign.webContents.executeJavaScript("window.databaseRecovery.act('prepare')");
    assert.equal(denied.reason,'forbidden','another local renderer has no repair authority');
    assert.equal(calls.some(c=>c.action==='prepare'),false);
  } finally { foreign.destroy(); }
  assert.equal(await evaluate("document.querySelector('#version').textContent"), app.getVersion());
  assert.match(await evaluate("document.querySelector('#detail').textContent"),/损坏/);
  await new Promise(resolve=>setTimeout(resolve,100));
  fs.writeFileSync(path.join(os.tmpdir(),'lily-database-recovery-blocked.png'),(await ui.window.webContents.capturePage()).toPNG());
  await evaluate("document.querySelector('#prepare').click()");
  await until("document.querySelectorAll('#candidates option').length===1");
  assert.match(await evaluate("document.querySelector('#candidates').textContent"),/25/);
  for(const locale of ['en','ar','zh-CN']) {
    const dictionary=require('../src/renderer/i18n/locales/'+locale+'.json');
    const strings=Object.fromEntries(Object.entries(dictionary).filter(([key])=>key.startsWith('databaseRecovery.')).map(([key,value])=>[key.slice('databaseRecovery.'.length),value]));
    await evaluate(`render({...state,locale:${JSON.stringify(locale)},strings:${JSON.stringify(strings)}})`);
    assert.equal(await evaluate("document.documentElement.dir"),locale==='ar'?'rtl':'ltr');
    assert.equal(await evaluate("document.querySelector('#prepare').textContent"),strings.prepare);
    assert.equal(await evaluate("document.documentElement.scrollWidth > window.innerWidth"),false);
  }
  ui.window.setSize(480,570);
  assert.equal(await evaluate("document.documentElement.scrollWidth > window.innerWidth"),false,'narrow recovery page remains usable');
  dialog.showSaveDialog=async()=>({canceled:false,filePath:path.join(root,'diagnostics.json')});
  await evaluate("document.querySelector('#export').click()");
  await until("document.querySelector('#notice').textContent.includes('已保存')");
  const exported=JSON.parse(fs.readFileSync(path.join(root,'diagnostics.json'),'utf8'));
  assert.equal(exported.version,app.getVersion());assert.equal('strings' in exported,false);
  await evaluate("document.querySelector('#restore').click()");
  await until("document.body.dataset.phase==='blocked' && !document.querySelector('#restore').disabled");
  assert.equal(calls.filter(c=>c.action==='restore').length,0);
  consent=true;await evaluate("document.querySelector('#restore').click()");
  await until("document.body.dataset.phase==='restored'");
  assert.match(await evaluate("document.querySelector('#detail').textContent"),/不会自动/);
  assert.equal(await evaluate("document.querySelector('#restore').hidden"),true);
  await evaluate("document.querySelector('#retry').click()");
  const ready=await ui.ready;assert.equal(ready.receipt.id,'restored');
  console.log('PASS actual Electron recovery page + preload + scoped IPC, cancellation and explicit continue');
  finish(0);
}).catch(error=>{console.error(error);finish(1);});
