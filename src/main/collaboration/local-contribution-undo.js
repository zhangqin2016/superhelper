"use strict";
const fs=require("node:fs");
const path=require("node:path");
const {createHash,randomUUID}=require("node:crypto");
const {createTaskRecords}=require("./task-records");
const {createTaskRecovery}=require("./task-recovery");
const {createTaskApplication,readTaskFile,safeTaskRoot}=require("./task-application");
const {prepareContributionInverse}=require("./local-contribution-inverse");
const hash=value=>createHash("sha256").update(JSON.stringify(value??null)).digest("hex");
const fail=code=>Object.assign(Error(`COLLAB_LOCAL_UNDO_${code}`),{code:`COLLAB_LOCAL_UNDO_${code}`});
const identifier=value=>typeof value==="string"&&/^[A-Za-z0-9_-]{1,200}$/.test(value);
const TOLERATED=new Set(["COLLAB_ACCESS_REVOKED","COLLAB_TASK_RECORD_INVALID","COLLAB_TASK_RECORD_BINDING_CONFLICT"]);

/** Contribution undo is a new private W change built from the personal
 * receipt's exact after (base) and before (incoming) bytes, merged with the
 * current W so later edits survive or block the undo as conflicts. It never
 * rewinds A or shared history and needs no remote conversation authority: the
 * restored bytes are this account's own files. The supplied writer must carry
 * foreground admission; a completed undo is final and is replayed as history. */
function createLocalContributionUndo({store,writer,journalRoot,destinationRoot,assertActive,beforeReceipt=()=>{},gitOptions,officeOptions}={}){
  if(typeof writer?.run!=="function"||typeof assertActive!=="function"||typeof journalRoot!=="string"||typeof destinationRoot!=="string"||typeof beforeReceipt!=="function")throw fail("CONFIG_INVALID");
  const recoveries=createTaskRecovery({store,assertActive});
  // The job record lives in the remote conversation scope. It is projected
  // best effort: a revoked or retired conversation cannot block personal undo.
  function withJob(original,update){
    try{
      const records=createTaskRecords({store,assertActive});
      let jobId=original.jobId;
      if(!jobId){
        const matches=records.list(original.conversationId).filter(row=>row.kind==="local-materialization"&&row.applicationId===original.id);
        if(matches.length===1)jobId=matches[0].id;
      }
      const job=jobId?records.get(jobId):null;
      if(job&&job.applicationId===original.id)update(records,job);
    }catch(error){if(!TOLERATED.has(error?.code))throw error;}
  }
  function load(id){
    assertActive();
    if(!identifier(id))throw fail("INVALID");
    const record=recoveries.get(id);
    if(!record)throw fail("NOT_FOUND");
    return record;
  }
  const outcome=original=>({ok:true,state:"undone",applicationId:original.id,undoApplicationId:original.undoApplicationId});
  async function undo(originalId){
    const original=load(originalId);
    if(original.kind!=="materialization")throw fail("NOT_MATERIALIZATION");
    // History replay: W after a completed undo belongs to the user again.
    if(original.state==="undone")return outcome(original);
    if(original.state!=="applied"||original.journal?.state!=="applied")throw fail("NOT_APPLIED");
    if(original.undoApplicationId){
      const inverse=recoveries.get(original.undoApplicationId);
      if(inverse?.journal&&inverse.state!=="rolled_back")throw fail(inverse.state==="applied"?"INCONSISTENT":"RECOVERY_REQUIRED");
    }
    fs.mkdirSync(journalRoot,{recursive:true,mode:0o700});fs.mkdirSync(destinationRoot,{recursive:true,mode:0o700});
    const storage=safeTaskRoot(journalRoot),stage=safeTaskRoot(destinationRoot);
    const candidate=await prepareContributionInverse({record:original,journalRoot:storage,destinationRoot:stage,assertActive,gitOptions,officeOptions});
    assertActive();
    const output=path.dirname(path.dirname(candidate.snapshotRoot));
    if(candidate.state!=="ready"){
      if(output.startsWith(stage+path.sep))fs.rmSync(output,{recursive:true,force:true});
      return {ok:false,state:"conflicts",code:"COLLAB_LOCAL_UNDO_CONFLICT",applicationId:original.id,conflicts:candidate.conflicts.map(item=>({path:item.path,reason:item.reason}))};
    }
    const undoApplicationId=`undo-${hash([original.id,randomUUID()])}`;
    const binding={applicationId:undoApplicationId,rootPath:original.input.rootPath,deliveryRoot:candidate.snapshotRoot,baseManifest:candidate.currentManifest,
      deliveryManifest:candidate.manifest,editablePaths:candidate.paths,...(Object.keys(candidate.fileModes||{}).length?{fileModes:candidate.fileModes}:{})};
    let linked=false;
    function guard(){
      assertActive();
      const live=recoveries.get(original.id);
      if(live?.state!=="applied"||(live.undoApplicationId??null)!==(linked?undoApplicationId:original.undoApplicationId??null)
        ||hash(live.journal)!==hash(original.journal))throw fail("FENCED");
      const stat=fs.statSync(safeTaskRoot(binding.rootPath));
      if(`${stat.dev}:${stat.ino}`!==original.journal.rootIdentity)throw fail("FENCED");
    }
    guard();
    const broker=createTaskApplication({journalRoot:storage,assertAuthorized:async()=>{guard();},
      writer:{run:operation=>writer.run(()=>{guard();return operation();})},
      journal:{get:id=>recoveries.get(id)?.journal||null,put:(id,journal)=>store.db.transaction(()=>{
        guard();const inverse=recoveries.get(id);
        if(!inverse||inverse.undoOf!==original.id)throw fail("RECEIPT_REQUIRED");
        if(journal.state==="applied"){
          // Whole-candidate recheck: per-file checkpoints alone are not a receipt.
          const desired=new Map(candidate.manifest.map(file=>[file.path,file.sha256]));
          for(const name of candidate.paths)if((readTaskFile(binding.rootPath,name)?.sha256||null)!==(desired.get(name)||null))throw fail("STALE_WORKSPACE");
          beforeReceipt();guard();
          const live=recoveries.get(original.id);
          // A and shared history stay where they are: undo is a private change.
          recoveries.put(original.id,{...live,state:"undone"});
          withJob(live,(records,job)=>records.put(job.id,{...job,state:"undone",undoApplicationId}));
        }
        recoveries.put(id,{...inverse,journal,state:journal.state});
      })()}});
    const preview=await broker.preview(binding);guard();
    store.db.transaction(()=>{
      guard();
      recoveries.put(undoApplicationId,{id:undoApplicationId,kind:"inverse",conversationId:original.conversationId,taskId:original.taskId,deliveryId:original.deliveryId,
        input:binding,planHash:preview.planHash,state:"planned",createdAt:store.now(),undoOf:original.id});
      recoveries.put(original.id,{...recoveries.get(original.id),undoApplicationId});
    })();
    linked=true;
    await broker.apply({...binding,expectedPlanHash:preview.planHash,confirmDeletions:true});
    return outcome(load(original.id));
  }
  /** Roll an interrupted inverse attempt back to the W that existed before it
   * started writing. A completed undo is never rolled back: that would re-apply
   * the contribution over whatever the user edited afterwards. */
  async function recover(undoApplicationId){
    const inverse=load(undoApplicationId);
    if(inverse.kind!=="inverse")throw fail("NOT_INVERSE");
    if(inverse.state==="applied")throw fail("NOT_RECOVERABLE");
    if(!inverse.journal)return {ok:true,state:inverse.state,applicationId:inverse.id,conflicts:[]};
    fs.mkdirSync(journalRoot,{recursive:true,mode:0o700});
    const broker=createTaskApplication({journalRoot:safeTaskRoot(journalRoot),writer,
      assertAuthorized:async()=>{assertActive();if(recoveries.get(inverse.id)?.kind!=="inverse")throw fail("NOT_FOUND");},
      journal:{get:id=>recoveries.get(id)?.journal||null,put:(id,journal)=>{
        const live=recoveries.get(id);if(live?.kind!=="inverse")throw fail("NOT_FOUND");
        recoveries.put(id,{...live,journal,state:journal.state});
      }}});
    return broker.recover({applicationId:inverse.id,mode:"rollback"});
  }
  return {undo,recover};
}
module.exports={createLocalContributionUndo};
