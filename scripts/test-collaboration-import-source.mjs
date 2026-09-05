import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {validImportCommand,withImportSource,MAX_IMAGE_BYTES} from '../src/main/collaboration/import-source.js';
import {registerTransferIpc,transferResult} from '../src/main/collaboration/transfer-ipc.js';
const png=Buffer.from('89504e470d0a1a0a00000000','hex');
test('explicit import IPC bounds source authority and never returns paths',async()=>{
 const handlers=new Map(),calls=[];registerTransferIpc({ipcMain:{handle:(n,f)=>handlers.set(n,f)},invoke:(...args)=>{calls.push(args);return {ok:true};}});
 const invoke=v=>handlers.get('collaboration:import-attachment')(null,v);
 const good={conversationId:'conversation',source:{kind:'image',bytes:png}};
 for(const bad of [{...good,scopeId:'team:other'},{...good,conversationId:123},{...good,source:{kind:'file',path:'../secret'}},{...good,source:{kind:'image',bytes:Buffer.alloc(MAX_IMAGE_BYTES+1)}},{...good,source:{kind:'image',bytes:[1,2]}},{...good,source:{kind:'image',bytes:png,path:'/private'}}]) {assert.equal(validImportCommand(bad),false);assert.equal((await invoke(bad)).ok,false);}
 assert.equal(calls.length,0);assert.equal((await invoke(good)).ok,true);assert.equal(calls[0][0],'importAttachment');
 assert.deepEqual(transferResult('importAttachment',{ok:true,id:'file',sourcePath:'/private',dek:'secret'}),{ok:true,id:'file'});
});
test('clipboard source is typed, private, and removed after encryption or failure',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'collab-import-'));
 try {
  await withImportSource({kind:'image',bytes:png},root,async({inputPath,mimeType,originalName})=>{assert.equal(mimeType,'image/png');assert.match(originalName,/\.png$/);assert.deepEqual(await fs.readFile(inputPath),png);assert.equal((await fs.stat(inputPath)).mode&0o777,0o600);});
  assert.deepEqual(await fs.readdir(root),[]);
  await assert.rejects(withImportSource({kind:'image',bytes:png},root,async()=>{throw Error('encrypt failed');}),/encrypt failed/);assert.deepEqual(await fs.readdir(root),[]);
  await assert.rejects(withImportSource({kind:'image',bytes:Buffer.from('not an image')},root,()=>assert.fail()),{code:'COLLABORATION_INVALID_INPUT'});
  await assert.rejects(withImportSource({kind:'file',path:root},root,()=>assert.fail()),{code:'COLLABORATION_INVALID_INPUT'});
  const file=path.join(root,'test.zip');await fs.writeFile(file,'fixture');let called=false;
  await withImportSource({kind:'file',path:file},root,async input=>{called=true;assert.equal(input.originalName,'test.zip');});assert.ok(called);assert.equal(await fs.readFile(file,'utf8'),'fixture');
 }finally{await fs.rm(root,{recursive:true,force:true});}
});
