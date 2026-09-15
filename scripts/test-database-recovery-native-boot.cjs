// Real main.js boot and worker with an isolated corrupt database. No model,
// account, service request, installed profile or customer files are involved.
const assert = require('node:assert/strict');
const fs = require('node:fs'),os=require('node:os'),path=require('node:path');
const {app,BrowserWindow,dialog}=require('electron');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'lily-recovery-native-'));
process.env.LILY_USER_DATA_DIR=path.join(root,'profile');
process.env.LILY_HOME=path.join(root,'home');
process.env.LILY_DOCUMENTS_DIR=path.join(root,'documents');
fs.mkdirSync(process.env.LILY_USER_DATA_DIR,{recursive:true});
fs.writeFileSync(path.join(process.env.LILY_USER_DATA_DIR,'app-preferences.json'),JSON.stringify({locale:'zh-CN'}));
const dbPath=path.join(process.env.LILY_USER_DATA_DIR,'messages.db');
const {MessageStore}=require('../src/main/store/message-store');
const store=new MessageStore(dbPath,path.join(root,'blobs'));
store.db.run("INSERT INTO messages(session_id,seq,id,role,envelope_blob,created_at) VALUES('test',1,'message','user',?,1)",require('node:zlib').gzipSync(Buffer.from('{}')));
store.close();
const api=require('../src/main/store/database-recovery');
assert.equal(api.createRecoveryBackup(dbPath).ok,true);
fs.writeFileSync(dbPath,'synthetic corrupted database, not customer data');
const original=fs.readFileSync(dbPath);
app.disableHardwareAcceleration();
let accepted=false, confirmCalls=0;
dialog.showMessageBox=async()=>{confirmCalls++;return {response:accepted?1:0};};
const timer=setTimeout(()=>finish(1),45000);
function finish(code){clearTimeout(timer);for(const win of BrowserWindow.getAllWindows())win.destroy();try{require('./lib/electron-test-cleanup.cjs')(root);}catch{code=1;}app.exit(code);}
app.whenReady().then(async()=>{
  let window;
  for(let i=0;i<400;i++){
    window=BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().endsWith('/recovery/index.html'));
    if(window&&await window.webContents.executeJavaScript("document.body?.dataset.phase==='blocked'"))break;
    await new Promise(r=>setTimeout(r,25));
  }
  assert.ok(window,'real main bootstrap must show recovery');
  const evaluate=code=>window.webContents.executeJavaScript(code);
  const waitFor=async code=>{for(let i=0;i<400;i++){if(await evaluate(code))return;await new Promise(r=>setTimeout(r,25));}throw Error('Timeout: '+code);};
  await waitFor("document.body.dataset.phase==='blocked'");
  assert.equal(await evaluate("document.querySelector('#version').textContent"),app.getVersion());
  assert.deepEqual(fs.readFileSync(dbPath),original);
  await evaluate("document.querySelector('#prepare').click()");
  await waitFor("document.querySelector('#candidates').options.length===1 && !document.querySelector('#restore').disabled");
  await evaluate("document.querySelector('#restore').click()");
  await waitFor("document.body.dataset.phase==='blocked'&&!document.querySelector('#restore').disabled");
  assert.equal(confirmCalls,1);assert.deepEqual(fs.readFileSync(dbPath),original);
  accepted=true;await evaluate("document.querySelector('#restore').click()");
  await waitFor("document.body.dataset.phase==='restored'");
  const result=api.inspectDatabase(dbPath);assert.equal(result.ok,true);assert.equal(result.messageCount,1);
  const evidence=path.join(dbPath+'.recovery',result.restoreReceipt.id,'original.db');
  assert.deepEqual(fs.readFileSync(evidence),original);
  assert.equal(BrowserWindow.getAllWindows().length,1,'no normal workbench/tasks before explicit continue');
  console.log('PASS real Lily bootstrap → corrupt DB → real worker snapshot lookup → cancel → confirmed restore; original retained');
  finish(0);
}).catch(error=>{console.error(error);finish(1);});
require('../src/main.js');
