"use strict";
const fs=require("node:fs");
const path=require("node:path");
const {createHash}=require("node:crypto");
const {createTaskRecords}=require("./task-records");
const {candidateRef}=require("./shared-git");
const {checkCandidateJavascript}=require("./candidate-javascript");
const {manifestHash}=require("./task-changeset");
const hash=value=>createHash("sha256").update(JSON.stringify(value)).digest("hex");
const fail=()=>Object.assign(Error("Candidate validation binding invalid"),{code:"COLLAB_INTEGRATION_VALIDATION_INVALID"});

async function unchanged(root,manifest,guard){
  const expected=new Map(manifest.map(file=>[file.path,file]));let count=0;
  const directories=new Set([""]);
  for(const file of manifest){let parent=file.path;while(parent.includes("/")){parent=parent.slice(0,parent.lastIndexOf("/"));directories.add(parent);}}
  async function walk(relative){
    guard();const directory=path.join(root,relative),stat=fs.lstatSync(directory);
    if(!stat.isDirectory()||stat.isSymbolicLink())return false;
    for await(const {name} of await fs.promises.opendir(directory)){
      const key=relative?`${relative}/${name}`:name,file=path.join(directory,name),entry=fs.lstatSync(file);
      if(entry.isSymbolicLink())return false;
      if(entry.isDirectory()){if(!directories.has(key)||!await walk(key))return false;continue;}
      const wanted=expected.get(key);
      if(!wanted||!entry.isFile()||entry.nlink!==1||entry.size!==wanted.sizeBytes)return false;
      const digest=createHash("sha256");let bytes=0;
      for await(const chunk of fs.createReadStream(file)){guard();bytes+=chunk.length;if(bytes>wanted.sizeBytes)return false;digest.update(chunk);}
      if(bytes!==wanted.sizeBytes||digest.digest("hex")!==wanted.sha256)return false;
      count++;
    }
    return true;
  }
  return await walk("")&&count===manifest.length;
}

/** Host-owned policy checks run against exact isolated Git bytes. This is an
 * evidence boundary, not a sandbox: only trusted main-process checkers belong
 * here. Contributions cannot supply commands, policy IDs or passing receipts.
 * Structural integrity alone does not authorize semantic publication. */
function createCandidateValidation({store,taskGit,assertActive,intentId,input,validationPolicyId,validateIntegration}){
  const configured=typeof validateIntegration==="function" && typeof validationPolicyId==="string" && /^[A-Za-z0-9_.:-]{1,160}$/.test(validationPolicyId);
  const policyId=`candidate-v2:${hash([configured?validationPolicyId:"unconfigured",process.version])}`;
  const records=createTaskRecords({store,assertActive});
  const recordId=candidate=>`candidate-validation-latest:${hash([intentId,candidate.commit,policyId])}`;
  function get(candidate){
    const index=records.get(recordId(candidate));if(!index)return null;
    const proof=records.get(index.evidenceId);
    if(index.kind!=="candidate-validation-latest" || !proof || proof.kind!=="candidate-validation" || proof.intentId!==intentId || proof.conversationId!==input.conversationId
      || proof.evidenceHash!==hash(proof.report) || proof.report.policyId!==policyId
      || ["commit","tree","head","baseline","delivery"].some(key=>proof.report[key]!==candidate[key]))throw fail();
    return proof;
  }
  async function validate(candidate){
    assertActive();candidate=Object.freeze({...candidate});
    if(candidate.state!=="ready" || ["commit","tree","head","baseline","delivery"].some(key=>!/^[a-f0-9]{40}$/.test(candidate[key]||""))
      || candidate.baseline!==input.baselineCommit || candidate.delivery!==input.deliveryCommit
      || candidate.headRef!==`refs/workspaces/${hash(input.workspaceId)}/head`
      || candidate.ref!==candidateRef(candidate)
      || !await taskGit.hasRevision(candidate))throw fail();assertActive();
    const runtime=await taskGit.ensure();assertActive();
    if(candidate.repository!==runtime.repository||await runtime.git(["rev-parse",`${candidate.commit}^{tree}`])!==candidate.tree)throw fail();
    const gitVersion=await runtime.git(["--version"]);assertActive();
    const temporary=fs.mkdtempSync(path.join(path.dirname(taskGit.rootPath),"validation-"));
    const checks=[];
    let state="required";
    try{
      const material=await taskGit.materializeSnapshot({revision:candidate,destinationRoot:path.join(temporary,"candidate"),parents:[candidate.head,candidate.delivery]});assertActive();
      checks.push({id:"git-candidate",version:"1",status:"passed",coverage:"exact candidate tree, parents and blob hashes",evidenceHash:material.gitRevision.manifestHash});
      const syntax=await checkCandidateJavascript({...material,assertActive});assertActive();checks.push(syntax);
      if(configured){
        let result;
        try{result=await validateIntegration(candidate,Object.freeze({snapshotRoot:material.snapshotRoot,
          manifest:Object.freeze(material.manifest.map(file=>Object.freeze({...file}))),
          input:Object.freeze({...input}),assertActive}));}
        catch{result=null;}
        assertActive();
        const valid=result?.commit===candidate.commit&&result.policyId===validationPolicyId&&/^[a-f0-9]{64}$/.test(result.evidenceHash||"");
        state=valid&&result.ok===true?"passed":"failed";
        checks.push({id:"project-policy",version:validationPolicyId,status:state,coverage:"host-configured project checks",
          ...(valid?{evidenceHash:result.evidenceHash}:{code:"INVALID_OR_FAILED_CHECK"})});
      }else checks.push({id:"project-policy",version:"unconfigured",status:"required",coverage:"project validation is unavailable"});
      if(syntax.status==="failed")state="failed";
      else if(syntax.status==="required"&&state==="passed")state="required";
      let intact=false;
      try{intact=await unchanged(material.snapshotRoot,material.manifest,assertActive);}catch{/* Record modified/unreadable bytes; active guard below fences stopped work. */}
      assertActive();
      if(!intact)state="failed";
      checks.push({id:"candidate-unchanged",version:"1",status:intact?"passed":"failed",coverage:"candidate files after all checks",
        ...(intact?{evidenceHash:manifestHash(material.manifest)}:{code:"CANDIDATE_CHANGED"})});
      if(!await taskGit.hasRevision(candidate))throw fail();assertActive();
      const report={version:1,policyId,commit:candidate.commit,tree:candidate.tree,head:candidate.head,baseline:candidate.baseline,delivery:candidate.delivery,
        runtime:{git:gitVersion.slice(0,200),node:process.version},state,checks};
      const evidenceHash=hash(report),evidenceId=`candidate-validation:${hash([intentId,evidenceHash])}`;
      store.db.transaction(()=>{
        assertActive();
        if(!records.get(evidenceId))records.put(evidenceId,{kind:"candidate-validation",conversationId:input.conversationId,intentId,report,evidenceHash});
        records.put(recordId(candidate),{kind:"candidate-validation-latest",conversationId:input.conversationId,intentId,evidenceId});
      })();
      return {ok:state==="passed",state,commit:candidate.commit,policyId,evidenceHash};
    }finally{fs.rmSync(temporary,{recursive:true,force:true});}
  }
  return Object.freeze({policyId,validate,get,recordId});
}
module.exports={createCandidateValidation};
