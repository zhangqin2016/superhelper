"use strict";
const {createHash}=require("node:crypto");
const {createTaskRecords}=require("./task-records");
const {createIntegrationIntents}=require("./integration-intents");
const {integrationTurnId}=require("./integration-turn");
const fail=code=>Object.assign(Error(`COLLAB_INTEGRATION_${code}`),{code:`COLLAB_INTEGRATION_${code}`});
const id=intentId=>`integration-admission:${createHash("sha256").update(intentId).digest("hex")}`;
const terminal=new Set(["completed","failed","interrupted","cancelled"]);

/** Cross-store admission journal: save the stable turn identity before calling
 * the native queue. Replay lost acknowledgements without repeating execution.
 * Actual Git/file work runs only through execute with the current turn guard. */
function createIntegrationAdmission({store,assertActive,getWorkflow,enqueue,worker,now=()=>store.now(),onChange=()=>{}}){
  const accountId=store.accountId;let stopped=false,running=null;
  const active=()=>{assertActive();if(stopped || store.accountId!==accountId)throw fail("STOPPED");};
  const records=createTaskRecords({store,assertActive:active}),intents=createIntegrationIntents({store,assertActive:active,now});
  const get=intentId=>records.get(id(intentId));
  const notify=()=>{try{onChange();}catch{/* Durable state is authoritative. */}};
  const updateWork=(row,state,code,delay,attempts=row.attempts)=>row.state==="done"
    ?store.db.run("UPDATE task_integration_work SET code=?,next_attempt_at=? WHERE account_id=? AND intent_id=? AND generation=? AND state='done' AND (code IS NULL OR code='COLLAB_LOCAL_APPLICATION_PENDING')",
      state==="waiting"?"COLLAB_LOCAL_APPLICATION_REQUIRED":code||"COLLAB_LOCAL_APPLICATION_PENDING",now()+delay,accountId,row.intent_id,row.generation)
    :store.db.run("UPDATE task_integration_work SET state=?,code=?,next_attempt_at=?,attempts=? WHERE account_id=? AND intent_id=? AND generation=? AND state IN ('pending','running')",
      state,code,now()+delay,attempts,accountId,row.intent_id,row.generation);
  async function drain(){
    try{await worker.recoverCheckPolicies?.();}catch(error){if(stopped)return;throw error;}if(stopped)return;active();
    const rows=store.db.all("SELECT * FROM task_integration_work WHERE account_id=? AND (state IN ('pending','running') OR (state='done' AND (code IS NULL OR code='COLLAB_LOCAL_APPLICATION_PENDING'))) AND next_attempt_at<=? ORDER BY next_attempt_at,intent_id LIMIT 8",accountId,now());
    for(const row of rows){
      try{
        active();const intent=intents.get(row.intent_id);
        if(!intent||intent.state==="cancelled"||(intent.state==="completed"&&row.state!=="done"))continue;
        await getWorkflow().authorizeIntegration(intent.input);active();
        if(row.state==="done"){
          const local=getWorkflow().localApplicationStatus?.(intent.id)||{state:"disabled"};active();
          if(local.state!=="pending"){updateWork(row,"done",`COLLAB_LOCAL_APPLICATION_${local.state.toUpperCase()}`,0);continue;}
          if(!local.ready){updateWork(row,"done","COLLAB_LOCAL_APPLICATION_PENDING",2000);continue;}
        }
        let journal=store.db.transaction(()=>{
          active();const current=store.db.get("SELECT * FROM task_integration_work WHERE account_id=? AND intent_id=?",accountId,intent.id);
          if(!current || current.generation!==row.generation || !["pending","running",...(row.state==="done"?["done"]:[])].includes(current.state) || current.next_attempt_at>now())return null;
          const previous=get(intent.id);
          if(previous && (previous.generation===row.generation||row.state==="done") && previous.state!=="terminal")return previous;
          const attempt=previous?previous.attempt+1:0;
          const request={accountId,intentId:intent.id,sessionId:intent.input.sessionId,attempt},turnId=integrationTurnId(request);
          if(!turnId)throw fail("INVALID");
          return records.put(id(intent.id),{kind:"integration-admission",conversationId:intent.input.conversationId,intentId:intent.id,
            generation:row.generation,attempt,request,turnId,state:"pending"});
        })();
        if(!journal)continue;
        const receipt=await enqueue(journal.request);active();
        if(receipt?.ok!==true)throw fail(receipt?.error==="COLLAB_INTEGRATION_NOT_READY"?"NOT_READY":"ADMISSION_FAILED");
        if(receipt.turnId!==journal.turnId)throw fail("ADMISSION_CONFLICT");
        // The queued handler may already have claimed/completed this work while
        // send returned its acknowledgement. Never overwrite its newer state.
        store.db.transaction(()=>{
          active();const current=get(intent.id);if(current?.turnId!==journal.turnId||current.state==="terminal")return;
          const ended=terminal.has(receipt.durableStatus),unknown=receipt.outcomeUnknown===true && receipt.active===false;
          journal=records.put(id(intent.id),{...journal,state:ended||unknown?"terminal":"admitted"});
          if(ended && receipt.durableStatus!=="completed")updateWork(row,"waiting","COLLAB_INTEGRATION_TURN_CANCELLED",0);
          else if(ended)updateWork(row,row.state,null,1000);
          else updateWork(row,row.state,null,unknown?1000:30000);
        })();notify();
      }catch(error){
        if(stopped)return;active();
        const notReady=error.code==="COLLAB_INTEGRATION_NOT_READY",attempts=row.attempts+(notReady?0:1);
        const denied=["COLLAB_TASK_ACCESS_DENIED","COLLAB_ACCESS_REVOKED"].includes(error.code);
        updateWork(row,attempts>=3||denied?"waiting":row.state,notReady?null:denied?error.code:"COLLAB_INTEGRATION_ADMISSION_FAILED",notReady?2000:Math.min(60000,1000*2**Math.min(attempts,5)),attempts);notify();
      }
    }
  }
  async function execute(request,execution){
    active();execution?.assertActive?.();
    if(request?.accountId!==accountId || typeof execution?.assertActive!=="function")throw fail("FENCED");
    const intent=intents.get(request.intentId),journal=get(request.intentId);
    if(!intent || !journal || request.sessionId!==intent.input.sessionId || execution.turnId!==journal.turnId || journal.state==="terminal")throw fail("FENCED");
    const guard=()=>{active();execution.assertActive();const current=get(request.intentId);if(current?.turnId!==execution.turnId || current.state==="terminal")throw fail("FENCED");};
    await getWorkflow().authorizeIntegration(intent.input);guard();
    const result=await worker.runIntent(request,{...execution,assertActive:guard});guard();
    if(result.state==="published"&&result.localState){
      store.db.transaction(()=>{
        guard();
        const code=result.localState==="applied"?"COLLAB_LOCAL_APPLICATION_APPLIED":result.localState==="waiting"?"COLLAB_LOCAL_APPLICATION_PENDING":"COLLAB_LOCAL_APPLICATION_REQUIRED";
        store.db.run("UPDATE task_integration_work SET code=?,next_attempt_at=? WHERE account_id=? AND intent_id=? AND state='done'",code,now()+2000,accountId,intent.id);
        records.put(journal.id,{...get(intent.id),state:"terminal"});
      })();notify();
    }
    return result;
  }
  return {get,execute,recover(){if(stopped)return Promise.resolve();if(!running)running=drain().finally(()=>{running=null;});return running;},stop(){stopped=true;}};
}
module.exports={createIntegrationAdmission};
