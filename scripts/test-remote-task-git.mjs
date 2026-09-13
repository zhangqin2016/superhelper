import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {createRequire} from 'node:module';
const require = createRequire(import.meta.url);
const {TaskGit} = require('../src/main/collaboration/task-git');
const temporary = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'lily-task-git-'));
const source = path.join(temporary,'source'); fs.mkdirSync(source);
const git = (...args)=>execFileSync('git',args,{cwd:source,encoding:'utf8'}).trim();
const file = (name,body)=>{fs.mkdirSync(path.dirname(path.join(source,name)),{recursive:true});fs.writeFileSync(path.join(source,name),body);return {path:name,sha256:createHash('sha256').update(body).digest('hex'),sizeBytes:Buffer.byteLength(body)};};
try {
  git('init','-q');file('private.txt','private historical data');git('add','.');git('-c','user.name=Test','-c','user.email=test@example.invalid','commit','-qm','private history');
  const privateHead=git('rev-parse','HEAD');
  file('.lily-work/version-vault.git/private','private vault');file('unrelated.txt','unrelated dirty work');
  const entry=file('authorized.txt','frozen baseline\r\n');
  file('.gitattributes','*.txt filter=unsafe text eol=lf');
  const tasks=new TaskGit({rootPath:path.join(temporary,'collaboration'),gitOptions:{autoInstall:false}});
  const baseline=await tasks.captureBaseline({taskId:'task_one',snapshotRoot:source,manifest:[entry]});
  const inspect=(...args)=>execFileSync('git',['--git-dir',baseline.repository,...args],{encoding:'utf8'}).trim();
  assert.equal(inspect('ls-tree','-r','--name-only',baseline.commit),'authorized.txt');
  assert.equal(inspect('rev-list','--count',baseline.commit),'1');
  assert.equal(execFileSync('git',['--git-dir',baseline.repository,'show',`${baseline.commit}:authorized.txt`]).toString(),'frozen baseline\r\n');
  assert.throws(()=>inspect('cat-file','-e',privateHead));
  assert.equal(git('rev-parse','HEAD'),privateHead);
  const restarted=new TaskGit({rootPath:path.join(temporary,'collaboration'),gitOptions:{autoInstall:false}});
  assert.equal((await restarted.captureBaseline({taskId:'task_one',snapshotRoot:source,manifest:[entry]})).commit,baseline.commit);
  // A host process can itself be running under Git; that environment must not
  // route task objects/index writes into its private repository.
  const inherited={GIT_DIR:process.env.GIT_DIR,GIT_INDEX_FILE:process.env.GIT_INDEX_FILE,GIT_OBJECT_DIRECTORY:process.env.GIT_OBJECT_DIRECTORY};
  try {
    process.env.GIT_DIR=path.join(source,'.git');
    process.env.GIT_INDEX_FILE=path.join(temporary,'must-not-exist');
    process.env.GIT_OBJECT_DIRECTORY=path.join(source,'.git/objects');
    const isolated=new TaskGit({rootPath:path.join(temporary,'isolated-env'),gitOptions:{autoInstall:false}});
    const result=await isolated.captureBaseline({taskId:'env',snapshotRoot:source,manifest:[entry]});
    assert.equal(result.commit,baseline.commit);
    assert.equal(fs.existsSync(process.env.GIT_INDEX_FILE),false);
    assert.throws(()=>git('cat-file','-e',result.commit));
  } finally {for (const [key,value] of Object.entries(inherited)) {if (value === undefined) delete process.env[key];else process.env[key]=value;}}
  assert.equal((await tasks.captureBaseline({taskId:'task_one',snapshotRoot:source,manifest:[entry]})).commit,baseline.commit);
  const changed=file('authorized.txt','changed baseline');
  await assert.rejects(tasks.captureBaseline({taskId:'task_one',snapshotRoot:source,manifest:[changed]}),/BASELINE_CONFLICT/);
  assert.equal(inspect('rev-parse',baseline.ref),baseline.commit);
  await assert.rejects(tasks.captureBaseline({taskId:'bad-hash',snapshotRoot:source,manifest:[entry]}),/SNAPSHOT_CHANGED/);
  await assert.rejects(tasks.captureBaseline({taskId:'controls',snapshotRoot:source,manifest:[file('.git/secret','hidden')]}),/CONTROL_FILE/);
  fs.symlinkSync(path.join(source,'authorized.txt'),path.join(source,'link.txt'));
  await assert.rejects(tasks.captureBaseline({taskId:'links',snapshotRoot:source,manifest:[{...changed,path:'link.txt'}]}),/UNSAFE_PATH/);
  const results=await Promise.all([1,2].map(()=>tasks.captureBaseline({taskId:'concurrent',snapshotRoot:source,manifest:[changed]})));
  assert.equal(results[0].commit,results[1].commit);
  inspect('fsck','--strict','--no-reflogs');
  console.log('task Git: isolated root commit, explicit manifest, exact bytes, immutable retry, corruption/link rejection and concurrent capture passed');
} finally {fs.rmSync(temporary,{recursive:true,force:true});}
