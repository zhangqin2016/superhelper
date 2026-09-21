"use strict";
const fs=require("node:fs");
const path=require("node:path");
const {createHash}=require("node:crypto");
const {readTaskFile,safeTaskRoot}=require("./task-application");
const {manifestMap}=require("./task-apply-plan");
const {prepareLocalCandidate}=require("./task-local-candidate");
const fail=code=>Object.assign(Error(`COLLAB_LOCAL_INVERSE_${code}`),{code:`COLLAB_LOCAL_INVERSE_${code}`});
const hash=bytes=>createHash("sha256").update(bytes).digest("hex");
const overlaps=(a,b)=>a===b||a.startsWith(b+path.sep)||b.startsWith(a+path.sep);

/** Construct the inverse of bytes actually written by one application. Its
 * after snapshot is the merge base; its before snapshot is the incoming change.
 * This prepares private bytes only. It neither rewinds shared history/A nor
 * authorizes a write: the caller must persist and apply a separate receipt. */
async function prepareContributionInverse({record,journalRoot,destinationRoot,assertActive,gitOptions,officeOptions}={}){
  if(typeof assertActive!=="function")throw fail("INVALID");
  assertActive();
  // Clone the personal journal before any asynchronous merge can yield.
  record=structuredClone(record);
  if(record?.kind!=="materialization"||record.state!=="applied"||record.journal?.state!=="applied")throw fail("NOT_APPLIED");
  const journal=record.journal;
  if(typeof record.id!=="string"||!/^[A-Za-z0-9_-]{1,200}$/.test(record.id)
    ||record.input?.applicationId!==record.id||journal.binding?.applicationId!==record.id
    ||record.input.rootPath!==journal.binding.rootPath||!Array.isArray(journal.operations)
    ||journal.operations.length>10000)throw fail("JOURNAL_INVALID");
  const root=safeTaskRoot(record.input.rootPath),storage=safeTaskRoot(destinationRoot),recovery=safeTaskRoot(journalRoot);
  if(overlaps(root,storage)||overlaps(root,recovery)||overlaps(storage,recovery))throw fail("ROOT_OVERLAP");
  const identity=fs.statSync(root);
  if(`${identity.dev}:${identity.ino}`!==journal.rootIdentity)throw fail("ROOT_CHANGED");
  if(journal.backupDirectory!==path.join(recovery,hash(record.id)))throw fail("JOURNAL_INVALID");
  const backups=safeTaskRoot(journal.backupDirectory);
  // Validate every destination path before constructing any snapshot paths.
  manifestMap(journal.operations.map(op=>({path:op.path,sha256:"0".repeat(64),sizeBytes:0})));
  if(new Set(journal.operations.map(op=>op.path)).size!==journal.operations.length)throw fail("JOURNAL_INVALID");
  const attempt=fs.mkdtempSync(path.join(storage,"inverse-")),baseRoot=path.join(attempt,"after"),incomingRoot=path.join(attempt,"before");
  fs.mkdirSync(baseRoot,{mode:0o700});fs.mkdirSync(incomingRoot,{mode:0o700});
  const output=fs.mkdtempSync(path.join(storage,"inverse-output-"));
  const base=[],incoming=[];let total=0;
  try{
    for(const [index,op]of journal.operations.entries()){
      assertActive();
      if(op.state!=="done"||op.backupName!==`${index}.before`||op.stagedName!==`${index}.after`
        ||![op.expectedLocalHash,op.resultHash].every(value=>value===null||typeof value==="string"&&/^[a-f0-9]{64}$/.test(value))
        ||op.expectedLocalHash===op.resultHash)throw fail("JOURNAL_INVALID");
      for(const [name,expected,dir,manifest]of [[op.stagedName,op.resultHash,baseRoot,base],[op.backupName,op.expectedLocalHash,incomingRoot,incoming]]){
        const file=readTaskFile(backups,name);
        if((file?.sha256||null)!==expected)throw fail("BACKUP_MISMATCH");
        if(!file)continue;
        total+=file.sizeBytes;if(total>1024*1024*1024)throw fail("LIMIT_EXCEEDED");
        const target=path.join(dir,op.path);fs.mkdirSync(path.dirname(target),{recursive:true,mode:0o700});
        fs.writeFileSync(target,file.bytes,{flag:"wx",mode:0o600});
        manifest.push({path:op.path,sha256:file.sha256,sizeBytes:file.sizeBytes});
      }
    }
    const candidate=await prepareLocalCandidate({base:{rootPath:baseRoot,manifest:base},shared:{rootPath:incomingRoot,manifest:incoming},rootPath:root,destinationRoot:output,assertActive,gitOptions,officeOptions});
    // Files the contribution deleted come back with their recorded pre-application mode.
    const restored=new Set(candidate.manifest.map(file=>file.path)),fileModes={};
    for(const op of journal.operations)if(op.resultHash===null&&restored.has(op.path)&&Number.isInteger(op.mode)&&op.mode>0&&op.mode<=0o777)fileModes[op.path]=op.mode;
    return {...candidate,fileModes};
  }catch(error){fs.rmSync(output,{recursive:true,force:true});throw error;}
  finally{fs.rmSync(attempt,{recursive:true,force:true});}
}
module.exports={prepareContributionInverse};
