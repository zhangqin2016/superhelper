import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {OpencodeSharedServer}=require('../src/main/runtime/opencode-shared-server');
const {spawnForeground,createForegroundWriter}=require('../src/main/collaboration/foreground-writer');
const root=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'idle-drain-')),filePath=path.join(root,'writer.sqlite');
const writer=createForegroundWriter({filePath}),servers=[];
const wait=async test=>{const deadline=Date.now()+5000;while(!test()){if(Date.now()>deadline)throw Error('timeout');await new Promise(resolve=>setTimeout(resolve,20));}};
try{
 let active=true;
 for(const name of ['active','idle']){
  const marker=path.join(root,name);
  const child=spawnForeground(process.execPath,['-e',`require('node:fs').writeFileSync(${JSON.stringify(marker)},'ready');setInterval(()=>{},1000);`],{cwd:root,env:process.env,stdio:['ignore','ignore','ignore']},{filePath});
  const server=new OpencodeSharedServer({serverCommand:'fixture',cwd:root,dataDir:':memory:',writerLockPath:filePath});
  server.process=server._ownedProcess=child;server._idleReady=true;server.retainView(()=>name==='active'?active:false);servers.push(server);
  await wait(()=>fs.existsSync(marker));
 }
 assert.equal(servers[1].drainIfIdle(),false,'no application request means idle profiles remain warm');
 assert.throws(()=>writer.run(()=>{}),/BUSY/);
 assert.equal(servers[0].drainIfIdle(),false,'active foreground chat must continue');
 const release=servers[1].retainWork();assert.equal(servers[1].drainIfIdle(),false,'background SDK work also prevents shutdown');release();
 let invalidated=false;servers[1].on('idle-retire',()=>{assert.equal(servers[1]._terminated,true);invalidated=true;});
 assert.equal(servers[1].drainIfIdle(),true);assert.equal(invalidated,true);
 await servers[1].terminate();assert.throws(()=>writer.run(()=>{}),/BUSY/,'other active profile still owns a group');
 active=false;const unknown=servers[0].retainView();assert.equal(servers[0].drainIfIdle(),false,'unknown view activity cannot be guessed idle');unknown();
 assert.equal(servers[0].drainIfIdle(),true);await servers[0].terminate();
 writer.run(()=>fs.writeFileSync(path.join(root,'applied'),'yes'));
  assert.equal(fs.existsSync(path.join(root,'applied')),true);
 assert.equal(writer.idleRequested(),false,'successful admission clears the hint so later idle engines stay warm');
 console.log('PASS idle drain: preserves active/unknown views and SDK work, invalidates idle profiles, admits write after group exit');
}finally{for(const server of servers)await server.terminate();fs.rmSync(root,{recursive:true,force:true});}
