import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {createRequire} from 'node:module';
const require = createRequire(import.meta.url);
const JSZip = require('jszip');
const share = require('../src/main/workspace-share');
const {freezeTaskBundle,unpackTaskBundle} = require('../src/main/collaboration/task-bundle');
const temporary = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'lily-task-bundle-'));
const sourceRoot = path.join(temporary,'source');
fs.mkdirSync(sourceRoot); fs.mkdirSync(path.join(sourceRoot,'notes'));
fs.writeFileSync(path.join(sourceRoot,'notes/work.txt'),'original work');
fs.writeFileSync(path.join(sourceRoot,'lily-workspace.json'),'user-authored file');
fs.writeFileSync(path.join(sourceRoot,'.env'),'SECRET=hidden');
fs.writeFileSync(path.join(sourceRoot,'AGENTS.md'),'Untrusted workspace agent policy');
fs.mkdirSync(path.join(sourceRoot,'.claude'));
fs.writeFileSync(path.join(sourceRoot,'.claude/settings.json'),'{"hooks":{}}');
fs.writeFileSync(path.join(sourceRoot,'config.js'),'const token = "sk-123456789012345678901234567890";');
fs.symlinkSync(path.join(sourceRoot,'notes/work.txt'),path.join(sourceRoot,'linked.txt'));
try {
  const scan = share.scanForSecrets;
  let frozen;
  try {
    share.scanForSecrets = files => { const found=scan(files); fs.writeFileSync(path.join(sourceRoot,'notes/work.txt'),'edited during generation'); return found; };
    frozen = await freezeTaskBundle({sourceRoot,destinationRoot:path.join(temporary,'frozen'),name:'Task materials'});
  } finally { share.scanForSecrets = scan; }
  assert.deepEqual(frozen.manifest.map(f=>f.path),['lily-workspace.json','notes/work.txt']);
  assert(frozen.omitted >= 2); assert(frozen.warnings.some(w=>w.includes('config.js')));
  fs.writeFileSync(path.join(sourceRoot,'notes/work.txt'),'changed source');
  assert.equal(fs.readFileSync(path.join(frozen.snapshotRoot,'notes/work.txt'),'utf8'),'original work');
  const unpacked = await unpackTaskBundle({packagePath:frozen.packagePath,destinationRoot:path.join(temporary,'unpacked')});
  assert.deepEqual(unpacked.manifest,frozen.manifest);
  assert.equal(fs.readFileSync(path.join(unpacked.snapshotRoot,'lily-workspace.json'),'utf8'),'user-authored file');
  for (const file of frozen.manifest) assert.equal(file.sha256,crypto.createHash('sha256').update(fs.readFileSync(path.join(unpacked.snapshotRoot,file.path))).digest('hex'));
  await assert.rejects(freezeTaskBundle({sourceRoot,destinationRoot:path.join(sourceRoot,'nested')}),/OVERLAP/);
  await assert.rejects(freezeTaskBundle({sourceRoot,destinationRoot:path.dirname(frozen.packagePath)}),/DESTINATION/);
  const collect = share.collectShareableFiles;
  try { share.collectShareableFiles = ()=>({truncated:true}); await assert.rejects(freezeTaskBundle({sourceRoot,destinationRoot:path.join(temporary,'truncated')}),/TRUNCATED/); }
  finally { share.collectShareableFiles = collect; }
  // Selection races a link into a previously regular path: do not follow it.
  try {
    share.collectShareableFiles = (...args)=>{ const result=collect(...args); fs.renameSync(path.join(sourceRoot,'notes'),path.join(sourceRoot,'moved')); fs.symlinkSync(path.join(sourceRoot,'moved'),path.join(sourceRoot,'notes')); return result; };
    await assert.rejects(freezeTaskBundle({sourceRoot,destinationRoot:path.join(temporary,'raced')}),/UNSAFE_PATH/);
  } finally { share.collectShareableFiles = collect; fs.unlinkSync(path.join(sourceRoot,'notes')); fs.renameSync(path.join(sourceRoot,'moved'),path.join(sourceRoot,'notes')); }
  const malicious = new JSZip(); malicious.file('lily-workspace.json',JSON.stringify({kind:'lily-workspace-pack',schemaVersion:1})); malicious.file('files/../escape.txt','bad');
  const maliciousPath=path.join(temporary,'malicious.zip'); fs.writeFileSync(maliciousPath,await malicious.generateAsync({type:'nodebuffer'}));
  await assert.rejects(unpackTaskBundle({packagePath:maliciousPath,destinationRoot:path.join(temporary,'bad')}));
  assert.equal(fs.existsSync(path.join(temporary,'escape.txt')),false);
  const control = new JSZip(); control.file('lily-workspace.json',JSON.stringify({kind:'lily-workspace-pack',schemaVersion:1}));
  control.file('files/.claude/settings.json','{"hooks":{}}');
  const controlPath=path.join(temporary,'control.zip');fs.writeFileSync(controlPath,await control.generateAsync({type:'nodebuffer'}));
  await assert.rejects(unpackTaskBundle({packagePath:controlPath,destinationRoot:path.join(temporary,'controls')}),/CONTROL_FILE/);
  console.log('remote task bundle: stable snapshots, secrets, exact manifests, strict extraction, truncation and link races passed');
} finally { fs.rmSync(temporary,{recursive:true,force:true}); }
