import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {resolveSessionWorkspace,captureExecutionWorkspace}=require('../src/main/session-workspace');
const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'session-workspace-')));
const work=path.join(root,'task');fs.mkdirSync(work);
const project={id:'project',path:root,name:'Existing project'};
const pm={find:id=>id===project.id?project:null};
try {
  const ordinary={projectId:'project'};
  assert.equal(resolveSessionWorkspace(pm,ordinary),project,'ordinary sessions keep the original project');
  const session={projectId:'project',remoteTaskBinding:'task',remoteTaskExecution:captureExecutionWorkspace(work)};
  assert.equal(resolveSessionWorkspace(pm,session).path,work);
  assert.equal(resolveSessionWorkspace(pm,session).id,project.id,'execution stays under one top-level project');
  assert.equal(project.path,root,'resolving a task never mutates global project identity');
  assert.equal(resolveSessionWorkspace(pm,{...session,remoteTaskBinding:null}),null,'unowned override fails closed');
  fs.renameSync(work,path.join(root,'original'));fs.mkdirSync(work);
  assert.equal(resolveSessionWorkspace(pm,session),null,'replaced task directory cannot redirect execution');
  fs.rmdirSync(work);fs.symlinkSync(root,work);
  assert.equal(resolveSessionWorkspace(pm,session),null,'a link to the private workspace is not the task directory');
  fs.unlinkSync(work);
  assert.equal(resolveSessionWorkspace(pm,session),null,'missing task material never falls back to private project');
  console.log('session workspace: normal baseline, isolated project identity, missing/replaced/symlink directory refusal passed');
} finally {fs.rmSync(root,{recursive:true,force:true});}
