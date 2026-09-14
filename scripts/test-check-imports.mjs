import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {scanImports,resolveCheckImports}=require('../src/main/collaboration/check-imports');
const scan=scanImports(`
const a=require('./helpers/a');const b=require("../lib/b.js");import c from './c.json';
import {d} from "demo-dep/sub/path";import * as e from '@scope/pkg';import 'side-effect-pkg';
import('./dynamic');export {f} from './f';const fs=require('node:fs'),os=require('os');
const http=require("https://example.invalid/x.js");const priv=require('#internal');const bad=require('Bad Name!');
`);
assert.deepEqual(scan.relative,['../lib/b.js','./c.json','./dynamic','./f','./helpers/a']);
assert.deepEqual(scan.bare,['@scope/pkg','demo-dep','side-effect-pkg'],'builtins, URLs, subpath imports and invalid names are not dependencies');
const texts={
 'tests/rule.test.cjs':"require('./helpers/check.cjs');require('../shared/values.json');require('demo-dep');require('./missing');",
 'tests/helpers/check.cjs':"module.exports=require('./deep');require('left-pad');",
 'tests/helpers/deep/index.js':"module.exports=1;require('../check.cjs');require('./index.js');",
 'shared/values.json':'{"value":2}',
 'unrelated.cjs':"require('demo-dep-two');",
};
const entries=new Map(Object.entries(texts).map(([path,text])=>[path,{path,sizeBytes:Buffer.byteLength(text),blob:'b'.repeat(40)}]));
const reads=[];
const result=await resolveCheckImports({entries,roots:['tests/rule.test.cjs'],read:async entry=>{reads.push(entry.path);return Buffer.from(texts[entry.path]);}});
assert.deepEqual(result.helpers.map(h=>h.path),['tests/helpers/check.cjs','tests/helpers/deep/index.js'],'test infrastructure resolves transitively through extensions and index files');
assert.deepEqual(result.sourceImports.map(h=>h.path),['shared/values.json'],'code under test is recorded, not pinned');
assert.deepEqual(result.dependencies,['demo-dep','left-pad'],'only packages reachable from the selected checks are recorded');
assert.deepEqual(result.unresolved,[{from:'tests/rule.test.cjs',specifier:'./missing'}]);
assert.equal(reads.includes('shared/values.json'),false,'code under test is never scanned or traversed');
const rootTest=await resolveCheckImports({entries:new Map([['rule.test.cjs',{path:'rule.test.cjs',sizeBytes:1}],['value.json',{path:'value.json',sizeBytes:1}],['helpers/check.cjs',{path:'helpers/check.cjs',sizeBytes:1}],['src/deep/module.js',{path:'src/deep/module.js',sizeBytes:1}]]),roots:['rule.test.cjs'],
 read:async entry=>Buffer.from(entry.path==='rule.test.cjs'?"require('./value.json');require('./helpers/check.cjs');require('./src/deep/module.js');":"require('../../huge.cjs');")});
assert.deepEqual(rootTest.helpers.map(h=>h.path),['helpers/check.cjs'],'a root-level check pins only conventional test directories');
assert.deepEqual(rootTest.sourceImports.map(h=>h.path),['src/deep/module.js','value.json']);
assert.equal(new Set(reads).size,reads.length,'cycles are read once');
const escape=new Map([['t.cjs',{path:'t.cjs',sizeBytes:10}]]);
const escaped=await resolveCheckImports({entries:escape,roots:['t.cjs'],read:async()=>Buffer.from("require('../../outside.js')")});
assert.deepEqual(escaped.helpers,[]);assert.equal(escaped.unresolved[0].specifier,'../../outside.js','imports escaping the baseline tree are never resolved');
const big=new Map([['t.cjs',{path:'t.cjs',sizeBytes:10}],['helpers/huge.cjs',{path:'helpers/huge.cjs',sizeBytes:256*1024+1}]]);
await assert.rejects(resolveCheckImports({entries:big,roots:['t.cjs'],read:async()=>Buffer.from("require('./helpers/huge.cjs')")}),/LIMIT/);
console.log('PASS check imports: static relative/bare inventory, infrastructure vs code-under-test classification, transitive baseline resolution, cycles, escapes and limits');
