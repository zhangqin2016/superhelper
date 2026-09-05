#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const {prepareTurnCapabilityReadiness} = require('../src/main/turn-capability-readiness');
const {planCapabilityReadiness} = require('../src/main/capability-readiness');
const calls=[];
const deps={installed:()=>new Set(),installing:()=>new Set(),prepare:async payload=>{calls.push(payload.requiredPackIds);return {ok:true,readyPackIds:payload.requiredPackIds};}};
const run=selectedSkills=>prepareTurnCapabilityReadiness({text:'Do the selected task',selectedSkills,deps});
assert.equal((await run([{id:'local-selected',manifest:{requiredRuntimePacks:['git']}}])).status,'ready');
assert.deepEqual(calls.pop(),['git'],'actual coordinator must prepare explicitly selected declaration');
await run([]);
assert.equal(calls.length,0,'unrelated task must not install enabled or recommended skills');
const malformed={get requiredRuntimePacks(){throw Error('broken');}};
const plan=planCapabilityReadiness({text:'browser',selectedSkills:[{id:'local-selected',manifest:malformed}]});
assert.deepEqual(plan.requiredPackIds,['web-automation']);
const legacy=planCapabilityReadiness({selectedSkills:[{id:'lily-template-fill',manifest:{requiredRuntimePacks:['git']}}]});
assert.deepEqual(new Set(legacy.requiredPackIds),new Set(['libreoffice','git']));
const overflow=planCapabilityReadiness({text:'browser',selectedSkills:Array(257).fill({id:'local-selected',manifest:{requiredRuntimePacks:['git']}})});
assert.deepEqual(overflow.requiredPackIds,['web-automation']);
process.env.LILY_SKILL_RUNTIME_DECLARATIONS='0';
assert.deepEqual(
  planCapabilityReadiness({text:'browser',selectedSkills:[{id:'lily-template-fill',manifest:{requiredRuntimePacks:['git']}}]}),
  planCapabilityReadiness({text:'browser'}),
  'kill switch restores the full pre-selection baseline, including legacy skills',
);
await run([{id:'local-selected',manifest:{requiredRuntimePacks:['git']}}]);
assert.equal(calls.length,0);
delete process.env.LILY_SKILL_RUNTIME_DECLARATIONS;
const broker=require('../src/main/capability-broker');
const original=broker.recommendSkillCapabilityGraph;
broker.recommendSkillCapabilityGraph=()=>[{id:'optional',requiredRuntimePacks:['ffmpeg']}];
try {await run([]);assert.equal(calls.length,0,'recommendations must remain optional');
broker.recommendSkillCapabilityGraph=()=>{throw Error('catalog failure');};
assert.deepEqual(planCapabilityReadiness({text:'browser',selectedSkills:[{id:'local-selected',manifest:{requiredRuntimePacks:['git']}}]}).requiredPackIds,['web-automation','git']);
} finally {broker.recommendSkillCapabilityGraph=original;}
console.log('selected skill readiness: ok');
