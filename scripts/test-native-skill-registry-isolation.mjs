import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lily-skill-isolation-'));
process.env.LILY_USER_DATA_DIR = path.join(root, 'user');
process.env.LILY_HOME = process.env.LILY_USER_DATA_DIR;
const require = createRequire(import.meta.url);
try {
  const manager = require('../src/main/skill-manager');
  const workspace = path.join(root, 'workspace');
  const dir = path.join(workspace, '.agents/skills/local-only');
  fs.mkdirSync(dir, {recursive:true});
  fs.writeFileSync(path.join(dir, 'SKILL.md'), '---\nname: local-only\ndescription: Use for local apples\n---\nBody');
  assert.deepEqual(manager.normalizeSessionSkillSelection(['local-only'], workspace), ['local-only'], 'selection API retains discovered local ID');
  assert.deepEqual(manager.normalizeSessionSkillSelection([], workspace), [], 'explicit local opt-out never collapses to inherited defaults');
  const a = {id:'a', enabledSkillIds:['local-only']};
  const b = {id:'b', enabledSkillIds:[]};
  const fileA = path.join(manager.writeSessionAgentGuide('a', a, workspace), 'AGENT.md');
  const fileB = path.join(manager.writeSessionAgentGuide('b', b, workspace), 'AGENT.md');
  assert.ok(fs.readFileSync(fileA, 'utf8').includes('local apples'));
  assert.ok(!fs.readFileSync(fileB, 'utf8').includes('local apples'), 'same workspace conversations remain isolated');
  a.enabledSkillIds=[];
  manager.writeSessionAgentGuide('a', a, workspace);
  assert.ok(!fs.readFileSync(fileA,'utf8').includes('local apples'),'changing only local selection invalidates cached guide');
  a.enabledSkillIds=['local-only'];
  manager.writeSessionAgentGuide('a', a, workspace);
  fs.writeFileSync(path.join(dir, 'SKILL.md'), '---\nname: local-only\ndescription: Use for local pears\n---\nBody');
  manager.writeSessionAgentGuide('a', a, workspace);
  assert.ok(fs.readFileSync(fileA, 'utf8').includes('local pears'), 'real session guide refreshes after edit');
  fs.unlinkSync(path.join(dir, 'SKILL.md'));
  manager.writeSessionAgentGuide('a', a, workspace);
  assert.ok(!fs.readFileSync(fileA, 'utf8').includes('local pears'), 'deleted skill disappears');
  const { SessionRunnerPool } = require('../src/main/session-runner-pool');
  assert.deepEqual(SessionRunnerPool.prototype._opencodeSkillPaths(['local-only'], 'a'), []);
  assert.deepEqual(SessionRunnerPool.prototype._opencodeSkillPaths([], 'b'), []);
  // Drive the real IPC path for sessions whose workspace is not a project.
  fs.writeFileSync(path.join(dir,'SKILL.md'),'---\nname: local-only\ndescription: IPC local skill\n---\nBody');
  const Module = require('node:module');
  const originalLoad = Module._load;
  const handlers = new Map();
  const standalone = {id:'standalone',workspacePath:workspace,enabledSkillIds:[]};
  let register;
  try {
    Module._load = function(request,...args) {
      if(request==='electron') return {ipcMain:{handle:(name,fn)=>handlers.set(name,fn)},dialog:{}};
      if(request==='./license-manager') return {requireValidLicense:()=>({ok:true})};
      if(request==='./ipc-utils') return {isSessionBusy:()=>false};
      return originalLoad.call(this,request,...args);
    };
    ({registerSessionHandlers:register}=require('../src/main/ipc-sessions'));
  } finally {Module._load=originalLoad;}
  register({sessionManager:{findById:()=>standalone,setEnabledSkillIds:(_id,ids)=>{standalone.enabledSkillIds=ids;return true;}},projectManager:{find:()=>null},runnerPool:{get:()=>null,terminateSession:()=>{}}});
  const response = handlers.get('session:set-skills')(null,{sessionId:'standalone',enabledSkillIds:['local-only']});
  assert.equal(response.ok,true);
  const ipcGuide=path.join(require('../src/main/config').sessionGuideDir('standalone'),'AGENT.md');
  assert.ok(fs.readFileSync(ipcGuide,'utf8').includes('IPC local skill'),'IPC selection writes standalone workspace guide');
  handlers.get('session:set-skills')(null,{sessionId:'standalone',enabledSkillIds:[]});
  assert.ok(!fs.readFileSync(ipcGuide,'utf8').includes('IPC local skill'),'IPC disabling local skill changes actual cached guide');
  console.log('native-skill-registry-isolation: ok');
} finally { fs.rmSync(root,{recursive:true, force:true}); }
