import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {execFileSync} from 'node:child_process';import {createHash} from 'node:crypto';import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {TaskGit}=require('../src/main/collaboration/task-git');
const {createSharedGit}=require('../src/main/collaboration/shared-git');
const python=process.env.LILY_TEST_OFFICE_PYTHON;
if(!python){console.log('SKIP Office shared candidate: set LILY_TEST_OFFICE_PYTHON (unchecked acceptance item)');process.exit(0);}
const root=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'lily-office-shared-'));
const hash=v=>createHash('sha256').update(v).digest('hex');
try{
 for(const name of ['base','first','second','clash'])fs.mkdirSync(path.join(root,name));
 execFileSync(python,['-c',`
import runpy, pathlib, sys
tests=runpy.run_path('scripts/test_office_merge.py')
root=pathlib.Path(sys.argv[1])
t=tests['OfficeMergeTest']();t.setUp()
(root/'base'/'report.docx').write_bytes(t.a)
(root/'first'/'report.docx').write_bytes(t.variant(lambda d: setattr(d.paragraphs[0], 'text', 'from history')))
(root/'second'/'report.docx').write_bytes(t.variant(lambda d: setattr(d.paragraphs[1], 'text', 'from delivery')))
(root/'clash'/'report.docx').write_bytes(t.variant(lambda d: setattr(d.paragraphs[0], 'text', 'competing')))
for side in ('base','first','second','clash'):
    (root/side/'notes.txt').write_text('shared notes\\n' if side!='second' else 'shared notes\\ndelivery line\\n')
`,root]);
 const manifest=dir=>fs.readdirSync(dir).sort().map(name=>{const bytes=fs.readFileSync(path.join(dir,name));return {path:name,sha256:hash(bytes),sizeBytes:bytes.length};});
 const taskGit=new TaskGit({rootPath:path.join(root,'git'),gitOptions:{autoInstall:false}}),shared=createSharedGit(taskGit);
 const base=path.join(root,'base'),baseline=await taskGit.captureBaseline({taskId:'task',snapshotRoot:base,manifest:manifest(base)});
 const deliver=async name=>taskGit.captureContribution({baseline,baseManifest:manifest(base),materializedPaths:manifest(base).map(f=>f.path),deliveryId:name,snapshotRoot:path.join(root,name),manifest:manifest(path.join(root,name))});
 const head=await shared.initialize({workspaceId:'w',baseline});
 const first=await shared.prepare({workspaceId:'w',baseline,delivery:await deliver('first'),expectedHead:head.commit});
 assert.equal(first.state,'ready');
 const validate=async candidate=>({ok:true,commit:candidate.commit});
 const published=await shared.publish({candidate:first,validate});
 const git=async args=>(await taskGit.ensure()).git(args);
 // H now differs from the baseline in report.docx; a delivery editing another paragraph is a Git-level binary conflict.
 const modelCalls=[];
 const second=await shared.prepare({workspaceId:'w',baseline,delivery:await deliver('second'),expectedHead:published.commit,officeOptions:{python},
  resolve:async({files})=>{modelCalls.push(files.map(f=>f.path));return null;}});
 assert.equal(second.state,'ready','a disjoint Word edit merges through the typed Office merger on the shared chain');
 assert.match(second.resolutionHash,/^[a-f0-9]{64}$/);assert.deepEqual(second.office.map(item=>[item.path,item.format]),[['report.docx','docx']]);
 assert.equal(modelCalls.length,0,'a fully merged Office conflict never reaches the model');
 const merged=path.join(root,'merged.docx'),{repository}=await taskGit.ensure();
 fs.writeFileSync(merged,execFileSync('git',['-C',repository,'cat-file','blob',`${second.commit}:report.docx`],{encoding:'buffer',maxBuffer:64*1024*1024}));
 execFileSync(python,['-c',"from docx import Document; import sys; assert [p.text for p in Document(sys.argv[1]).paragraphs]==['from history','from delivery'], [p.text for p in Document(sys.argv[1]).paragraphs]",merged]);
 assert.equal(await git(['show',`${second.commit}:notes.txt`]),'shared notes\ndelivery line','text changes merge alongside the Office merge');
 // Competing edits to the same paragraph stay a conflict with the merger's bounded reason, and the model is not asked about binary packages.
 const clash=await shared.prepare({workspaceId:'w',baseline,delivery:await deliver('clash'),expectedHead:published.commit,officeOptions:{python},
  resolve:async({files})=>{modelCalls.push(files.map(f=>f.path));return null;}});
 assert.equal(clash.state,'conflicts');assert.deepEqual(clash.paths,['report.docx']);
 assert.deepEqual(clash.office.conflicts.map(c=>[c.path,c.reason,c.detail]),[['report.docx','office_content','same_paragraph']]);
 assert.equal(modelCalls.length,0,'binary Office conflicts are not offered to the text resolver');
 const unavailable=await shared.prepare({workspaceId:'w',baseline,delivery:await deliver('second'),expectedHead:published.commit,officeOptions:{python:null}});
 assert.equal(unavailable.state,'conflicts');assert.equal(unavailable.office.conflicts[0].reason,'office_unsupported','no runtime means a visible conflict, never a text merge of a package');
 console.log('PASS Office shared candidate: typed Word merge on the shared chain with resolution identity, alongside text merge, bounded same-paragraph conflict, runtime unavailability, model never consulted for packages');
}finally{fs.rmSync(root,{recursive:true,force:true});}
