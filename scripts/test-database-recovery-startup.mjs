import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
const source=fs.readFileSync('src/main.js','utf8');
const events=[];const handlers=new Map();let startup,catcher,release;
const readiness=new Promise(resolve=>release=resolve);
const app={setPath(){},getPath:()=>'/temporary/profile',setName(){},requestSingleInstanceLock:()=>true,on(){},quit(){},getVersion:()=> '9.8.7',whenReady:()=>({then(fn){startup=fn;return {catch(fn){catcher=fn;}};}})};
const recoveryWindow={isDestroyed:()=>false,destroy(){},hide(){}};
const noop=()=>{};
const modules={
  electron:{app,ipcMain:{handle:(name,fn)=>handlers.set(name,fn)},BrowserWindow:{getAllWindows:()=>[]}},
  './main/config':{defaultWorkspacePath:()=>'/temporary/work',collaborationTransferRoot:()=>'',bindRuntimePaths:noop,messageDbPath:()=>'/temporary/messages.db'},
  './main/app-icon':{loadAppIconImage:()=>null},
  './main/agent-command':{resolveOpencodeCommand:()=>'/temporary/engine'},
  './main/connector-bridge':{stopConnectorBridge:noop},
  './main/diagnostics/main-log-file':{startMainLogFile:noop},
  './main/blob-protocol':{registerBlobScheme:noop,installBlobProtocol:noop},
  './main/local-media-protocol':{registerLocalMediaScheme:noop,installLocalMediaProtocol:noop},
  './main/database-recovery-service':{DatabaseRecoveryService:class{close(){}}},
  './main/database-recovery-window':{openDatabaseRecoveryWindow:async options=>{
    events.push(options.allowRestore===false?'failure-window':'gate');
    return {window:recoveryWindow,ready:readiness,dispose:noop};
  }},
  './main/data-migration':{runDataMigrations:()=>{events.push('migration');throw Error('injected database boot failure');}},
};
vm.runInNewContext(source,{require:name=>name==='node:path'?path:(modules[name]||{}),process:{env:{LILY_USER_DATA_DIR:'/temporary/profile'},platform:'darwin'},console:{info:noop,warn:noop,error:noop},__dirname:path.resolve('src'),setTimeout,clearTimeout,setInterval,clearInterval});
const running=startup().catch(error=>{if(catcher)return catcher(error);throw error;});
await new Promise(resolve=>setImmediate(resolve));
assert.deepEqual(events,['gate'],'data loading must wait for DB admission');
assert.equal(handlers.get('app:get-version')().version,'9.8.7','version IPC must exist before data loading');
release({phase:'ready'});await running;
assert.deepEqual(events,['gate','migration','failure-window'],'initialization failure opens repair-independent surface');
const appSource=fs.readFileSync('src/renderer/app.js','utf8');
const versionFunction=appSource.slice(appSource.indexOf('async function updateAboutVersion()'),appSource.indexOf('\nasync function bindAppIcons()'));
const el={};const versionContext={window:{assistantClient:{getAppVersion:async()=>{throw Error('IPC missing');}}},$:()=>el,t:(key,vars)=>vars?.version||key};
await vm.runInNewContext(versionFunction+'; updateAboutVersion()',versionContext);
assert.notEqual(el.textContent,'0.1.0');
assert.equal(el.textContent,'settings.versionUnavailable');
console.log('PASS actual startup ordering/failure boundary and honest version fallback');
