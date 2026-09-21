"use strict";
const {createHash}=require("node:crypto");
const {TaskGit}=require("./task-git");
const {createTaskRecords}=require("./task-records");
const {createNodeCheckPolicy}=require("./node-check-policy");
const {checkCandidateJavascript}=require("./candidate-javascript");
const {unchanged}=require("./candidate-validation");
const hash=value=>createHash("sha256").update(JSON.stringify(value)).digest("hex");
const fail=code=>Object.assign(Error(`COLLAB_LOCAL_VALIDATION_${code}`),{code:`COLLAB_LOCAL_VALIDATION_${code}`});

// This repository belongs only to local validation. It is never passed to the
// shared transport or publisher. A real private commit binds the execution copy.
function createLocalCandidateValidation({store,rootPath,assertActive,getPolicy,dependencyRoot=null}){
  const records=createTaskRecords({store,assertActive});
  const taskGit=new TaskGit({rootPath});
  async function validate({job,input}){
    const policy=getPolicy(input),policyId=policy?.id||null;
    const guard=()=>{
      assertActive();const current=records.get(job.id);
      if(job.state!=="ready"||current?.state!=="ready"||current.token!==job.token||current.fingerprint!==job.fingerprint
        ||(getPolicy(input)?.id||null)!==policyId)throw fail("FENCED");
    };
    guard();
    const revision=await taskGit.captureBaseline({taskId:hash([job.id,job.token,job.fingerprint]),
      snapshotRoot:job.candidate.snapshotRoot,manifest:job.candidate.manifest});guard();
    const syntax=await checkCandidateJavascript({...job.candidate,assertActive:guard});guard();
    let project={state:"required"};
    if(policy){
      const checker=createNodeCheckPolicy({taskGit,record:policy,input,assertActive:guard,candidateParents:[],dependencyRoot});
      project=await checker.validate(revision,{assertActive:guard});guard();
    }
    const intact=await unchanged(job.candidate.snapshotRoot,job.candidate.manifest,guard);guard();
    const state=!intact||syntax.status==="failed"||project.state==="failed"?"failed":syntax.status==="required"||project.state!=="passed"?"required":"passed";
    const report={version:1,kind:"local-candidate-validation",fingerprint:job.fingerprint,token:job.token,
      privateCommit:revision.commit,checkPolicyId:policyId,runtime:process.version,state,syntax,project,candidateUnchanged:intact};
    const evidenceHash=hash(report),id=`local-validation:${evidenceHash}`;
    return store.db.transaction(()=>{
      guard();const evidence=records.put(id,{id,kind:"local-candidate-validation",conversationId:input.conversationId,intentId:job.intentId,state,evidenceHash,report});
      records.put(job.id,{...records.get(job.id),validation:{state,evidenceId:id,evidenceHash,privateCommit:revision.commit,checkPolicyId:policyId}});
      return evidence;
    })();
  }
  return {validate};
}
module.exports={createLocalCandidateValidation};
