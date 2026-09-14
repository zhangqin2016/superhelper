"use strict";
const {randomUUID}=require("node:crypto");
const {createIntegrationIntents}=require("./integration-intents");
const {createSharedPublication}=require("./shared-publication");
const {createCandidateValidation}=require("./candidate-validation");
const {createNodeCheckPolicy}=require("./node-check-policy");

/** Bounded background preparation. Waiting validation/conflicts are durable;
 * no default validator, engine prompt or implicit successful approval exists. */
function createIntegrationWorker({store,assertActive,getWorkflow,validateIntegration,validationPolicyId,now=()=>store.now(),onChange=()=>{}}){
  const accountId=store.accountId,workerId=randomUUID(),timers=new Set();let stopped=false,running=null;
  function active(){assertActive();if(stopped || store.accountId!==accountId)throw Object.assign(Error("Integration stopped"),{code:"COLLAB_INTEGRATION_STOPPED"});}
  const intents=createIntegrationIntents({store,assertActive:active,now});
  const notify=()=>{try{onChange();}catch{/* Observers cannot change durable work. */}};
  const configured=typeof validateIntegration==="function" && typeof validationPolicyId==="string" && /^[A-Za-z0-9_.:-]{1,160}$/.test(validationPolicyId);
  if(configured)store.db.run("UPDATE task_integration_work SET state='pending',next_attempt_at=0 WHERE account_id=? AND state='waiting' AND code='COLLAB_INTEGRATION_VALIDATION_REQUIRED'",accountId);
  let policyCursor="",policyScanDone=false,policyScan=null;
  async function scanPolicies(){
    active();if(policyScanDone)return;
    // One bounded startup pass upgrades old validation-required work. Native
    // admission still owns execution; a wakeup is never a validation receipt.
    const rows=store.db.all("SELECT * FROM task_integration_work WHERE account_id=? AND state='waiting' AND code='COLLAB_INTEGRATION_VALIDATION_REQUIRED' AND intent_id>? ORDER BY intent_id LIMIT 8",accountId,policyCursor);
    for(const row of rows){
      active();policyCursor=row.intent_id;
      try{
        const intent=intents.get(row.intent_id);if(intent?.state!=="pending")continue;
        const policy=await getWorkflow().getIntegrationCheckPolicy?.(intent.input);active();
        if(policy)store.db.run("UPDATE task_integration_work SET state='pending',code=NULL,attempts=0,next_attempt_at=0 WHERE account_id=? AND intent_id=? AND generation=? AND state='waiting' AND code='COLLAB_INTEGRATION_VALIDATION_REQUIRED'",accountId,row.intent_id,row.generation);
      }catch{active();/* Keep denied/unavailable checks waiting for explicit action. */}
    }
    if(rows.length<8)policyScanDone=true;
  }
  function recoverCheckPolicies(){if(stopped)return Promise.resolve();if(!policyScan)policyScan=scanPolicies().finally(()=>{policyScan=null;});return policyScan;}
  async function runRow(row,assertCurrent=()=>{}){
    if(stopped)return;
    let lease,timer,leaseLost=false,policyReady=false,expectedPolicyId=null;
    const guard=()=>{active();assertCurrent();if(leaseLost)throw Object.assign(Error("Integration lease lost"),{code:"COLLAB_INTEGRATION_FENCED"});
      if(policyReady)getWorkflow().assertIntegrationCheckPolicy?.(intents.get(row.intent_id).input,expectedPolicyId);};
    try{
      guard();const intent=intents.get(row.intent_id);
      if(!intent || ["completed","cancelled"].includes(intent.state)){store.db.run("UPDATE task_integration_work SET state='done' WHERE account_id=? AND intent_id=?",accountId,row.intent_id);return;}
      lease=intents.claim(intent.id,{workerId,leaseMs:30000});if(!lease)return;
      store.db.run("UPDATE task_integration_work SET state='running',generation=?,next_attempt_at=? WHERE account_id=? AND intent_id=?",lease.generation,lease.expiresAt,accountId,intent.id);
      timer=setInterval(()=>{try{guard();const renewed=intents.renew(lease,30000);store.db.run("UPDATE task_integration_work SET next_attempt_at=? WHERE account_id=? AND intent_id=? AND generation=? AND state='running'",renewed.expiresAt,accountId,intent.id,lease.generation);}catch{leaseLost=true;}},5000);timer.unref?.();
      timers.add(timer);
      const workflow=getWorkflow(),context=await workflow.acquireIntegrationInput(intent.input);guard();intents.assertLease(lease);
      const checkPolicy=await workflow.getIntegrationCheckPolicy?.(intent.input);guard();intents.assertLease(lease);
      expectedPolicyId=checkPolicy?.id||null;policyReady=true;guard();
      const nodePolicy=checkPolicy?createNodeCheckPolicy({taskGit:context.taskGit,record:checkPolicy,input:intent.input,
        assertActive:()=>{guard();intents.assertLease(lease);}}):null;
      const publisher=createSharedPublication({store,taskGit:context.taskGit,assertActive:guard,now,authorize:async input=>{
        if(await workflow.authorizeIntegration(input)!==true)return false;
        const current=await workflow.getIntegrationCheckPolicy?.(input);
        if((current?.id||null)!==(checkPolicy?.id||null))throw Object.assign(Error("Check policy changed"),{code:"COLLAB_CHECK_POLICY_CHANGED"});
        return true;
      }});
      const validation=createCandidateValidation({store,taskGit:context.taskGit,assertActive:()=>{guard();intents.assertLease(lease);},intentId:intent.id,input:intent.input,
        validationPolicyId:nodePolicy?.policyId||validationPolicyId,checkPolicyId:checkPolicy?.id||null,
        validateIntegration:nodePolicy?.validate||validateIntegration});
      const result=await publisher.run({lease,baseline:context.baseline,delivery:context.delivery,
        validationPolicyId:validation.policyId,validate:validation.validate});
      guard();
      const code=result.state==="conflicts"?"COLLAB_INTEGRATION_CONFLICT":result.state==="published"?null:
        result.validationAttempt?.state==="failed"?"COLLAB_INTEGRATION_VALIDATION_FAILED":"COLLAB_INTEGRATION_VALIDATION_REQUIRED";
      store.db.run("UPDATE task_integration_work SET state=?,code=?,attempts=0,next_attempt_at=0 WHERE account_id=? AND intent_id=? AND generation=? AND state='running'",result.state==="published"?"done":"waiting",code,accountId,intent.id,lease.generation);
      notify();
    }catch(error){
      if(stopped)return;
      active();
      if(lease){try{intents.release(lease);}catch{/* A successor or cancellation owns further state. */}}
      const code=/^COLLAB_[A-Z_]{1,80}$/.test(error.code||"")?error.code:"COLLAB_INTEGRATION_FAILED";
      const attempts=row.attempts+1,waiting=attempts>=3 || ["COLLAB_TASK_ACCESS_DENIED","COLLAB_ACCESS_REVOKED","COLLAB_INTEGRATION_FENCED"].includes(code);
      store.db.run("UPDATE task_integration_work SET state=?,attempts=?,code=?,next_attempt_at=? WHERE account_id=? AND intent_id=? AND generation=? AND state!='done'",waiting?"waiting":"pending",attempts,code,now()+Math.min(60000,1000*2**Math.min(attempts,5)),accountId,row.intent_id,lease?.generation??row.generation);
      notify();
    }finally{if(timer){clearInterval(timer);timers.delete(timer);}}
  }
  const executing=new Map();
  function executeRow(row,guard){
    if(executing.has(row.intent_id))return executing.get(row.intent_id);
    const promise=runRow(row,guard).finally(()=>executing.delete(row.intent_id));executing.set(row.intent_id,promise);return promise;
  }
  async function drain(){
    try{await recoverCheckPolicies();}catch(error){if(stopped)return;throw error;}if(stopped)return;active();
    const rows=store.db.all("SELECT * FROM task_integration_work WHERE account_id=? AND state IN ('pending','running') AND next_attempt_at<=? ORDER BY next_attempt_at,intent_id LIMIT 8",accountId,now());
    for(const row of rows)await executeRow(row);
  }
  async function runIntent(request,execution){
    active();execution.assertActive();const intent=intents.get(request.intentId);
    if(request.accountId!==accountId || !intent || request.sessionId!==intent.input.sessionId)throw Object.assign(Error("Integration binding changed"),{code:"COLLAB_INTEGRATION_FENCED"});
    let row=store.db.get("SELECT * FROM task_integration_work WHERE account_id=? AND intent_id=?",accountId,intent.id);
    if(!row)throw Object.assign(Error("Integration work missing"),{code:"COLLAB_INTEGRATION_FENCED"});
    if(['pending','running'].includes(row.state))await executeRow(row,execution.assertActive);
    active();execution.assertActive();row=store.db.get("SELECT * FROM task_integration_work WHERE account_id=? AND intent_id=?",accountId,intent.id);
    const final=intents.get(intent.id);
    const state=final?.state==='completed'?'published':final?.state==='cancelled'?'cancelled':row?.code==='COLLAB_INTEGRATION_VALIDATION_REQUIRED'?'validation_required':row?.code==='COLLAB_INTEGRATION_VALIDATION_FAILED'?'validation_failed':row?.code==='COLLAB_INTEGRATION_CONFLICT'?'conflict':row?.state==='waiting'?'failed':'queued';
    return {ok:true,state};
  }
  return {runIntent,recoverCheckPolicies,recover(){if(stopped)return Promise.resolve();if(!running)running=drain().finally(()=>{running=null;});return running;},stop(){stopped=true;for(const timer of timers)clearInterval(timer);timers.clear();}};
}
module.exports={createIntegrationWorker};
