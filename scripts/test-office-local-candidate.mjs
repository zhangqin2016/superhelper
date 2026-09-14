import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {prepareLocalCandidate}=require('../src/main/collaboration/task-local-candidate');
const {mergeOffice}=require('../src/main/collaboration/office-merge');
const python=process.env.LILY_TEST_OFFICE_PYTHON;
if(!python){console.log('SKIP Office private candidate: set LILY_TEST_OFFICE_PYTHON to a Python with python-docx, openpyxl, python-pptx and lxml (unchecked acceptance item)');process.exit(0);}
const rendering=Boolean(process.env.LILY_RUNTIME_ROOT);
const root=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'lily-office-candidate-'));
try{
  for(const name of ['a','w','m','stage'])fs.mkdirSync(path.join(root,name));
  execFileSync(python,['-c',`
import runpy, pathlib, sys
tests=runpy.run_path('scripts/test_office_merge.py')
root=pathlib.Path(sys.argv[1])
t=tests['OfficeMergeTest']();t.setUp()
(root/'a'/'report.docx').write_bytes(t.a)
(root/'w'/'report.docx').write_bytes(t.variant(lambda d: setattr(d.paragraphs[0], 'text', 'private')))
(root/'m'/'report.docx').write_bytes(t.variant(lambda d: setattr(d.paragraphs[1], 'text', 'shared')))
b=tests['WorkbookMergeTest']();b.setUp()
(root/'a'/'budget.xlsx').write_bytes(b.a)
(root/'w'/'budget.xlsx').write_bytes(b.variant(lambda k: k['Budget'].__setitem__('B2', 45)))
(root/'m'/'budget.xlsx').write_bytes(b.variant(lambda k: k['Budget'].__setitem__('C3', '=B3*2')))
p=tests['PresentationMergeTest']();p.setUp()
(root/'a'/'deck.pptx').write_bytes(p.a)
(root/'w'/'deck.pptx').write_bytes(p.variant(lambda d: setattr(d.slides[0].shapes.title, 'text', 'Private one')))
(root/'m'/'deck.pptx').write_bytes(p.variant(lambda d: setattr(d.slides[1].shapes.title, 'text', 'Shared two')))
for side in ('a','w','m'):
    (root/side/'export.pdf').write_bytes(b'%PDF-1.4 '+side.encode()+b'\\n')
`,root]);
  const bytes=(side,name)=>fs.readFileSync(path.join(root,side,name));
  const files=['report.docx','budget.xlsx','deck.pptx','export.pdf'];
  const manifest=side=>files.map(name=>({path:name,sha256:createHash('sha256').update(bytes(side,name)).digest('hex'),sizeBytes:bytes(side,name).length}));
  const input={base:{rootPath:path.join(root,'a'),manifest:manifest('a')},shared:{rootPath:path.join(root,'m'),manifest:manifest('m')},rootPath:path.join(root,'w'),destinationRoot:path.join(root,'stage'),assertActive(){},officeOptions:{python}};
  const before=Object.fromEntries(files.map(name=>[name,bytes('w',name)]));
  const result=await prepareLocalCandidate(input);
  assert.equal(result.state,'conflicts');
  assert.deepEqual(result.conflicts,[{path:'export.pdf',reason:'pdf_source_preferred'}],'PDF exports are never merged; the source document is');
  assert.deepEqual(result.office.map(item=>[item.path,item.format,item.policy]).sort(),[['budget.xlsx','xlsx','office-parts-v2'],['deck.pptx','pptx','office-parts-v2'],['report.docx','docx','office-parts-v2']]);
  execFileSync(python,['-c',`
import sys
from docx import Document; import openpyxl; from pptx import Presentation
assert [p.text for p in Document(sys.argv[1]).paragraphs] == ['private','shared'], 'docx'
book=openpyxl.load_workbook(sys.argv[2]); s=book['Budget']
assert (s['B2'].value, s['C3'].value, s['C1'].value) == (45, '=B3*2', '=B1*2'), (s['B2'].value, s['C3'].value)
assert book.calculation.fullCalcOnLoad, 'formulas taken from one side force recalculation on open'
assert [x.shapes.title.text for x in Presentation(sys.argv[3]).slides] == ['Private one','Shared two'], 'pptx'
`,path.join(result.snapshotRoot,'report.docx'),path.join(result.snapshotRoot,'budget.xlsx'),path.join(result.snapshotRoot,'deck.pptx')]);
  for(const name of files)assert.deepEqual(bytes('w',name),before[name],`preparation must preserve private working bytes: ${name}`);
  const workbook=result.office.find(item=>item.path==='budget.xlsx');
  assert.equal(workbook.recalculateOnLoad,true);assert.ok(workbook.cells>=2);
  if(rendering){
    for(const item of result.office)assert.ok(item.renderedPages>=1,`${item.path} rendered ${item.renderedPages} pages through the bundled LibreOffice`);
    console.log('rendered pages:',result.office.map(item=>`${item.path}=${item.renderedPages}`).join(' '));
  }else assert.equal(workbook.renderedPages,null,'without a LibreOffice runtime the merge is accepted without a render check and says so');
  const clash=await mergeOffice(bytes('a','report.docx'),bytes('w','report.docx'),(()=>{execFileSync(python,['-c',`
import runpy, pathlib, sys
t=runpy.run_path('scripts/test_office_merge.py')['OfficeMergeTest']();t.setUp()
pathlib.Path(sys.argv[1]).write_bytes(t.variant(lambda d: setattr(d.paragraphs[0], 'text', 'remote')))`,path.join(root,'clash.docx')]);return fs.readFileSync(path.join(root,'clash.docx'));})(),root,{python,extension:'.docx'});
  assert.equal(clash.state,'conflict');assert.equal(clash.reason,'same_paragraph','the merger names the bounded semantic conflict');
  const required=await mergeOffice(bytes('a','report.docx'),bytes('w','report.docx'),bytes('m','report.docx'),root,{python,extension:'.docx',render:'require',env:{...process.env,LILY_LIBREOFFICE_PROGRAM:''}});
  assert.equal(required.state,'unsupported');assert.equal(required.reason,'render_unavailable','a required render check without LibreOffice never passes silently');
  const unavailable=await prepareLocalCandidate({...input,officeOptions:{python:null}});
  assert.equal(unavailable.state,'conflicts');
  assert.deepEqual(unavailable.conflicts.filter(c=>c.reason==='office_unsupported').map(c=>c.path).sort(),['budget.xlsx','deck.pptx','report.docx']);
  const changed=await prepareLocalCandidate({...input,assertActive(){},officeOptions:{python:'/nonexistent/python'}});
  assert.equal(changed.state,'conflicts');
  assert.equal(fs.readdirSync(path.dirname(result.snapshotRoot)).includes('merge'),false,'scratch documents are removed');
  console.log(`PASS Office private candidate: real Python Word/Excel/PowerPoint merges${rendering?' with LibreOffice render verification':' (render check skipped: no LILY_RUNTIME_ROOT)'}, PDF source rule, unchanged W, bounded conflict reasons, unavailable runtime, scratch cleanup`);
}finally{fs.rmSync(root,{recursive:true,force:true});}
