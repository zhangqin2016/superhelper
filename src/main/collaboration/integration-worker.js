"use strict";
const {randomUUID}=require("node:crypto");
const {createIntegrationIntents}=require("./integration-intents");
const {createSharedPublication}=require("./shared-publication");
const {createCandidateValidation}=require("./candidate-validation");

/** Bounded background preparation. Waiting validation/conflicts are durable;
 * no default validator, engine prompt or implicit successful approval exists. */
function createIntegrationWorker({store,assertActive,getWorkflow,validateIntegration,validationPolicyId,now=()=>store.now(),onChange=()=>{}}){
  const accountId=store.accountId,workerId=randomUUID(),timers=new Set();let stopped=false,running=null;
  function active(){assertActive();if(stopped || store.accountId!==accountId)throw Object.assign(Error("Integration stopped"),{code:"COLLAB_INTEGRATION_STOPPED"});}
  const intents=createIntegrationIntents({store,assertActive:active,now});
  const notify=()=>{try{onChange();}catch{/* Observers cannot change durable work. */}};
  const configured=typeof validateIntegration==="function" && typeof validationPolicyId==="string" && /^[A-Za-z0-9_.:-]{1,160}$/.test(validationPolicyId);
  if(configured)store.db.run("UPDATE task_integration_work SET state='pending',next_attempt_at=0 WHERE account_id=? AND state='waiting' AND code='COLLAB_INTEGRATION_VALIDATION_REQUIRED'",accountId);
  async function drain(){
    active();
    const rows=store.db.all("SELECT * FROM task_integration_work WHERE account_id=? AND state IN ('pending','running') AND next_attempt_at<=? ORDER BY next_attempt_at,intent_id LIMIT 8",accountId,now());
    for(const row of rows){
      if(stopped)return;
      let lease,timer,leaseLost=false;
      const guard=()=>{active();if(leaseLost)throw Object.assign(Error("Integration lease lost"),{code:"COLLAB_INTEGRATION_FENCED"});};
      try{
        guard();const intent=intents.get(row.intent_id);
        if(!intent || ["completed","cancelled"].includes(intent.state)){store.db.run("UPDATE task_integration_work SET state='done' WHERE account_id=? AND intent_id=?",accountId,row.intent_id);continue;}
        lease=intents.claim(intent.id,{workerId,leaseMs:30000});if(!lease)continue;
        store.db.run("UPDATE task_integration_work SET state='running',generation=?,next_attempt_at=? WHERE account_id=? AND intent_id=?",lease.generation,lease.expiresAt,accountId,intent.id);
        timer=setInterval(()=>{try{guard();const renewed=intents.renew(lease,30000);store.db.run("UPDATE task_integration_work SET next_attempt_at=? WHERE account_id=? AND intent_id=? AND generation=? AND state='running'",renewed.expiresAt,accountId,intent.id,lease.generation);}catch{leaseLost=true;}},5000);timer.unref?.();
        timers.add(timer);
        const workflow=getWorkflow(),context=await workflow.acquireIntegrationInput(intent.input);guard();intents.assertLease(lease);
        const publisher=createSharedPublication({store,taskGit:context.taskGit,assertActive:guard,now,authorize:input=>workflow.authorizeIntegration(input)});
        const validation=createCandidateValidation({store,taskGit:context.taskGit,assertActive:()=>{guard();intents.assertLease(lease);},intentId:intent.id,input:intent.input,
          validationPolicyId,validateIntegration});
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
        const attempts=row.attempts+1,waiting=attempts>=3 || ["COLLAB_TASK_ACCESS_DENIED","COLLAB_ACCESS_REVOKED"].includes(code);
        store.db.run("UPDATE task_integration_work SET state=?,attempts=?,code=?,next_attempt_at=? WHERE account_id=? AND intent_id=? AND generation=? AND state!='done'",waiting?"waiting":"pending",attempts,code,now()+Math.min(60000,1000*2**Math.min(attempts,5)),accountId,row.intent_id,lease?.generation??row.generation);
        notify();
      }finally{if(timer){clearInterval(timer);timers.delete(timer);}}
    }
  }
  return {recover(){if(stopped)return Promise.resolve();if(!running)running=drain().finally(()=>{running=null;});return running;},stop(){stopped=true;for(const timer of timers)clearInterval(timer);timers.clear();}};
}
module.exports={createIntegrationWorker};
