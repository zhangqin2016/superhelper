import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import { gzipSync } from 'node:zlib';
const require = createRequire(import.meta.url);
const { collectSkillGuideReadEvidence } = require('../src/main/skill-usage-audit');
assert.equal(typeof collectSkillGuideReadEvidence, 'function', 'read outcomes must be recorded');
const guide = '/work/example/SKILL.md';
const tools = ['done', 'failed', undefined].map(status => ({name:'read', input:{filePath:guide}, status}));
assert.deepEqual(collectSkillGuideReadEvidence(tools).map(e => e.outcome), ['success','failed','unknown']);
assert.equal(collectSkillGuideReadEvidence([{...tools[0], result:{isError:true}}])[0].outcome, 'failed');
const { aggregateSkillUsage } = require('../src/main/skill-usage-metrics');
const candidate = {id:'example',guidePath:guide,matched:'explicit'};
const audits = [
  {schemaVersion:2,candidates:[candidate],guideReadEvidence:[{path:guide,outcome:'success'}]},
  {schemaVersion:2,candidates:[candidate],guideReadEvidence:[{path:guide,outcome:'failed'}]},
  {schemaVersion:1,candidates:[candidate],guideReads:[guide],usedSkillIds:['example']},
  {schemaVersion:2,candidates:[{...candidate,matched:'token_overlap'}],guideReadEvidence:[]},
  {schemaVersion:2,candidates:[],guideReadEvidence:[]},
];
const result = aggregateSkillUsage(audits);
assert.equal(result.turns,5); assert.equal(result.matched,4);
assert.equal(result.read,1); assert.equal(result.unread,2); assert.equal(result.unknown,1);
assert.equal(result.matchedUnreadRate,2/3, 'unknown outcomes excluded, never counted successful');
assert.equal(result.byMatchKind.explicit.matched,3);
assert.equal(result.worst[0].id,'example');
assert.equal(aggregateSkillUsage([]).matchedUnreadRate,null, 'no evidence is not zero failure');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lily-skill-metrics-'));
try {
  process.env.LILY_USER_DATA_DIR=path.join(root,'user');
  process.env.LILY_HOME=process.env.LILY_USER_DATA_DIR;
  const skillDir=path.join(root,'.agents/skills/local-proof');
  fs.mkdirSync(skillDir,{recursive:true});
  fs.writeFileSync(path.join(skillDir,'SKILL.md'),'---\nname: local-proof\ndescription: Local proof fixture\n---\nInstructions');
  const {TurnOrchestrator}=require('../src/main/turn-orchestrator');
  const {TurnArchive}=require('../src/main/turn-archive');
  const {createTurnRuntimeEventRouter}=require('../src/main/turn-runtime-event-router');
  const {createTurnTerminalFinalizer}=require('../src/main/turn-terminal-finalizer');
  for(const outcome of ['unknown','unknown-failed','missing-status','success','failed']) {
    const session={id:`proof-${outcome}`,workspacePath:root};
    const state=TurnOrchestrator.prototype._state.call({states:new Map()},session.id);
    state.turnId=`turn-${outcome}`;state.enginePayload={rawText:'$local-proof',text:'$local-proof'};
    state.tools.set('read-guide',{id:'read-guide',name:'read',input:{filePath:path.join(skillDir,'SKILL.md')},status:'running',startedAt:Date.now()});
    if(outcome==='missing-status') delete state.tools.get('read-guide').status;
    const ctx={sessionManager:{findById:()=>session}};
    if(outcome==='success'||outcome==='failed') createTurnRuntimeEventRouter({ctx,getState:()=>state}).applyDraft(session.id,{type:'tool.done',payload:{id:'read-guide',result:'Instructions',isError:outcome==='failed'}});
    const archive=new TurnArchive(ctx.sessionManager);
    let archived;
    await createTurnTerminalFinalizer({ctx,getState:()=>state,turnArchive:{buildRecord:(...args)=>{archived=archive.buildRecord(...args);return archived;},commit:()=>({id:'fixture'})}}).finalize(session.id,outcome==='unknown-failed'?'turn.failed':'turn.completed',{assistant:'Finished'});
    assert.ok(archived?.meta?.skillUsageAudit,'real finalizer must archive audit');
    assert.equal(archived.meta.skillUsageAudit.guideReadEvidence[0].outcome,['success','failed'].includes(outcome)?outcome:'unknown','actual tool completion evidence, not synthetic terminal cleanup');
  }
  const file = path.join(root,'messages.db');
  const db = new DatabaseSync(file);
  db.exec('CREATE TABLE messages (record TEXT)');
  const insert = db.prepare('INSERT INTO messages VALUES (?)');
  for (const audit of audits) insert.run(JSON.stringify({meta:{skillUsageAudit:audit}}));
  insert.run('invalid json'); insert.run('{}'); db.close();
  const before = fs.readFileSync(file);
  const run = spawnSync(process.execPath,['scripts/skill-usage-report.mjs','--db',file,'--json'],{encoding:'utf8'});
  assert.equal(run.status,0,run.stderr);
  const json = JSON.parse(run.stdout); assert.equal(json.read,1); assert.equal(json.invalidRecords,1);
  assert.deepEqual(fs.readFileSync(file),before,'report never mutates DB');
  const threshold=spawnSync(process.execPath,['scripts/skill-usage-report.mjs','--db',file,'--max-unread-rate','0.3'],{encoding:'utf8'});
  assert.equal(threshold.status,1,'explicit diagnostic threshold must fail');
  const production = path.join(root,'production.db');
  const live = new DatabaseSync(production);
  live.exec('CREATE TABLE messages (envelope_blob BLOB)');
  for (const audit of audits) live.prepare('INSERT INTO messages VALUES (?)').run(gzipSync(JSON.stringify({role:'assistant',record:{meta:{skillUsageAudit:audit}}})));
  live.close();
  const actual=spawnSync(process.execPath,['scripts/skill-usage-report.mjs','--db',production,'--json'],{encoding:'utf8'});
  assert.equal(actual.status,0,actual.stderr);
  assert.equal(JSON.parse(actual.stdout).read,1,'production gzip envelope schema, not invented record column');
  const absent=path.join(root,'absent.db');
  const missing=spawnSync(process.execPath,['scripts/skill-usage-report.mjs','--db',absent],{encoding:'utf8'});
  assert.equal(missing.status,2); assert.ok(!fs.existsSync(absent));
  const emptyFile=path.join(root,'empty.db');
  const emptyDb=new DatabaseSync(emptyFile); emptyDb.exec('CREATE TABLE messages (envelope_blob BLOB)'); emptyDb.close();
  const noEvidence=spawnSync(process.execPath,['scripts/skill-usage-report.mjs','--db',emptyFile,'--max-unread-rate','0.3'],{encoding:'utf8'});
  assert.equal(noEvidence.status,2,'no known outcomes cannot pass a requested rate threshold');
  console.log('skill-usage-metrics: ok');
} finally {fs.rmSync(root,{recursive:true,force:true});}
