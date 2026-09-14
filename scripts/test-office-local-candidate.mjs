import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {prepareLocalCandidate}=require('../src/main/collaboration/task-local-candidate');
const python=process.env.LILY_TEST_OFFICE_PYTHON;
assert.ok(python,'explicit test Python with python-docx/lxml is required');
const root=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'lily-office-candidate-'));
try{
  for(const name of ['a','w','m','stage'])fs.mkdirSync(path.join(root,name));
  execFileSync(python,['-c',`
import runpy, pathlib, sys
t=runpy.run_path('scripts/test_office_merge.py')['OfficeMergeTest']()
t.setUp()
root=pathlib.Path(sys.argv[1])
(root/'a'/'report.docx').write_bytes(t.a)
(root/'w'/'report.docx').write_bytes(t.variant(lambda d: setattr(d.paragraphs[0], 'text', 'private')))
(root/'m'/'report.docx').write_bytes(t.variant(lambda d: setattr(d.paragraphs[1], 'text', 'shared')))
`,root]);
  const bytes=name=>fs.readFileSync(path.join(root,name,'report.docx'));
  const manifest=name=>[{path:'report.docx',sha256:createHash('sha256').update(bytes(name)).digest('hex'),sizeBytes:bytes(name).length}];
  const input={base:{rootPath:path.join(root,'a'),manifest:manifest('a')},shared:{rootPath:path.join(root,'m'),manifest:manifest('m')},rootPath:path.join(root,'w'),destinationRoot:path.join(root,'stage'),assertActive(){},officeOptions:{python}};
  const before=bytes('w');
  const result=await prepareLocalCandidate(input);
  assert.equal(result.state,'ready');
  execFileSync(python,['-c',"from docx import Document; import sys; d=Document(sys.argv[1]); assert [p.text for p in d.paragraphs] == ['private','shared']",path.join(result.snapshotRoot,'report.docx')]);
  assert.deepEqual(bytes('w'),before,'preparation must preserve private working bytes');
  const unavailable=await prepareLocalCandidate({...input,officeOptions:{python:null}});
  assert.equal(unavailable.state,'conflicts');
  assert.equal(unavailable.conflicts[0].reason,'office_unsupported');
  const changed=await prepareLocalCandidate({...input,assertActive(){},officeOptions:{python:'/nonexistent/python'}});
  assert.equal(changed.state,'conflicts');
  assert.equal(fs.readdirSync(path.dirname(result.snapshotRoot)).includes('merge'),false,'scratch documents are removed');
  console.log('PASS Office private candidate: real Python merge, unchanged W, unavailable runtime, scratch cleanup');
}finally{fs.rmSync(root,{recursive:true,force:true});}
