import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
const require = createRequire(import.meta.url);
const { classifyAssistantError } = require('../src/main/agent-runner');
const { parseServeDiagnostic } = require('../src/main/runtime/opencode-serve-diagnostics');
const { OpencodeAgentSession } = require('../src/main/opencode-agent-session');
const { reduceOpencodeRuntimeEvent, createOpencodeRuntimeState } = require('../src/main/runtime/opencode-runtime-reducer');
const raw = 'upstream transport error: token refresh failed (401)';
const classified = classifyAssistantError(raw);
assert.equal(classified?.code, 'UPSTREAM_MODEL_AUTH_FAILED');
assert.equal(classified.retryable, false);
assert.equal(require('../src/main/opencode-session-failure-policy').isSafeReplayableModelFailure(classified, raw, {modelRouteAudit:{keyKind:'gateway-token',route:'gateway'}}), false, 'upstream OAuth cannot be repaired by refreshing the Lily gateway key');
assert.equal(classifyAssistantError(classified.message)?.code, classified.code);
for (const text of ['token refresh failed (503)', 'upstream transport error: timeout', '401 invalid API key']) {
  assert.notEqual(classifyAssistantError(text)?.code, classified.code, 'unrelated failures keep existing handling');
}
const line = (agent='build', session='ses_test', ts=Date.now()) => `timestamp=${new Date(ts).toISOString()} level=ERROR message="stream error" session.id=${session} agent=${agent} error.error="AI_APICallError: ${raw}"`;
assert.equal(parseServeDiagnostic(line())?.kind, 'upstream_auth');
const error = {name:'APIError',data:{message:raw,statusCode:502,isRetryable:true}};
const reduced = reduceOpencodeRuntimeEvent({type:'message.updated',properties:{info:{id:'msg_failed',role:'assistant',error}}}, createOpencodeRuntimeState());
assert.equal(reduced.effects.find(e=>e.kind==='error')?.message, raw);
for (const extra of [{agent:'compaction'}, {summary:true}, {agent:'title'}]) {
  const auxiliary=reduceOpencodeRuntimeEvent({type:'message.updated',properties:{info:{id:'msg_aux',role:'assistant',error,...extra}}},createOpencodeRuntimeState());
  assert.equal(auxiliary.effects.some(e=>e.kind==='error'),false,'optional helper error cannot newly fail the foreground');
}
class Server extends EventEmitter {
  sessionID='ses_test'; prompts=[]; aborts=0;
  async start() {} async createSession() {return this.sessionID;} subscribe() {}
  async sendPrompt(p) {this.prompts.push(p);} async abort() {this.aborts++;return true;}
  terminate() {} async checkHealth() {return true;}
}
const tick=()=>new Promise(r=>setImmediate(r));
for (const via of ['diagnostic','message','session','abort-failed','abort-delayed']) {
  const server=new Server(); const errors=[]; const done=[];
  const session=new OpencodeAgentSession('auth-test',{createServer:()=>server});
  session.bindOrchestrator({ingest(){},notifyRunnerError:(_,m)=>errors.push(m),notifyRunnerDone:(_,p)=>done.push(p)});
  session.ensureProcess(process.cwd(),{agentCommand:'/bin/true'},{lazy:true});
  session.sendUserMessage({text:'生成一个宣传图'}); await tick();
  for (const info of [parseServeDiagnostic(line('title')),parseServeDiagnostic(line('build','ses_other')),parseServeDiagnostic(line('build','ses_test',1))]) server.emit('diagnostic',info);
  assert.equal(errors.length,0,'auxiliary/foreign/stale diagnostics cannot fail the active turn');
  let releaseAbort;
  if (via==='abort-failed') server.abort=async()=>{server.aborts++;throw new Error('offline');};
  if (via==='abort-delayed') server.abort=()=>{server.aborts++;return new Promise(resolve=>{releaseAbort=resolve;});};
  if (via==='diagnostic' || via.startsWith('abort-')) server.emit('diagnostic',parseServeDiagnostic(line()));
  else server.emit('event',via==='message'
    ? {type:'message.updated',properties:{info:{id:'msg_failed',role:'assistant',error}}}
    : {type:'session.error',properties:{sessionID:'ses_test',error}});
  await tick();await tick();
  if (releaseAbort) {
    assert.equal(session.isBusy(),true,'keep the turn fenced until abort settles');
    assert.equal(errors.length,0);
    releaseAbort(true);await tick();
  }
  assert.equal(errors.length,1,via+' preserves one visible auth failure');
  assert.equal(classifyAssistantError(errors[0])?.code,'UPSTREAM_MODEL_AUTH_FAILED');
  assert.equal(server.aborts,1,'abort only this engine session');
  assert.equal(server.prompts.length,1,'no empty-completion replay');
  assert.equal(done.length,0);
  server.emit('event',{type:'session.idle',properties:{sessionID:'ses_test'}});
  server.emit('diagnostic',parseServeDiagnostic(line()));await tick();
  assert.equal(errors.length,1,'late idle/error cannot settle twice');
  session.terminate();
}
console.log('upstream-auth-failure: ok');
