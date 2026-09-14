import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {mergeJson}=require('../src/main/collaboration/integration-json-merge');
const merge=(b,h,d)=>mergeJson(...[b,h,d].map(value=>Buffer.from(value)));
assert.deepEqual(JSON.parse(merge('{"x":1,"nested":{"y":1},"gone":1}','{"x":2,"nested":{"y":1}}','{"x":1,"nested":{"y":2},"gone":1}').text),{x:2,nested:{y:2}});
assert.equal(merge('{"x":1}','{"x":2}','{"x":3}').state,'conflicts');
assert.equal(merge('{"x":{"y":1}}','{}','{"x":{"y":2}}').state,'conflicts','deletion cannot discard the other side edit');
assert.equal(merge('{"x":[1,2]}','{"x":[3,2]}','{"x":[1,4]}').state,'conflicts','array identity/order cannot be inferred');
assert.deepEqual(JSON.parse(merge('{}','{"x":{"a":1}}','{"y":2}').text),{x:{a:1},y:2});
for(const value of ['{"x":1,"x":2}','{"n":9007199254740993}','{"n":0.1}','{"n":-0}','{"constructor":1}','[1,2]', '{'.repeat(65)]){
 assert.equal(merge(value,value,value).state,'unsupported','ambiguous/unsupported input never becomes successful output');
}
assert.equal(mergeJson(Buffer.from([0xff]),Buffer.from('{}'),Buffer.from('{}')).state,'unsupported');
assert.equal(merge(' '.repeat(256*1024+1),'{}','{}').state,'unsupported');
console.log('typed JSON merge: independent fields, deletions, atomic arrays, duplicate keys, precision, encoding and limits passed');
