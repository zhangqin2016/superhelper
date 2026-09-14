"use strict";
const fs=require("node:fs");
const path=require("node:path");
const {createHash}=require("node:crypto");
const {createTaskRecords}=require("./task-records");
const {manifestMap}=require("./task-apply-plan");
const {assertScopeWritable,isConversationRevoked}=require("./access-revocation");
const hash=value=>createHash("sha256").update(JSON.stringify(value)).digest("hex");
const fail=code=>Object.assign(Error(`COLLAB_CHECK_POLICY_${code}`),{code:`COLLAB_CHECK_POLICY_${code}`});
function createIntegrationCheckPolicy({store,assertActive}){
  const records=createTaskRecords({store,assertActive});
  function binding(input,sourceIdentity){
    assertActive();
    const value={accountId:store.accountId,conversationId:input.conversationId,workspaceId:input.workspaceId,
      projectId:input.projectId,targetId:input.targetId,sourceIdentity};
    if(Object.values(value).some(v=>typeof v!=="string"||!v||v.length>200||v.includes("\0"))
      || !/^[a-f0-9]{64}$/.test(sourceIdentity))throw fail("INVALID");
    const conversation=store.getConversation({conversationId:input.conversationId});
    if(!conversation||isConversationRevoked(store,input.conversationId))throw fail("ACCESS");
    assertScopeWritable(store,conversation.scopeId);return value;
  }
  const pointerId=value=>`validation-policy-current:${hash(value)}`;
  function current(input,sourceIdentity){
    const bound=binding(input,sourceIdentity),pointer=records.get(pointerId(bound));if(!pointer)return null;
    const record=records.get(pointer.policyId);
    if(pointer.kind!=="validation-policy-current" || !record || record.kind!=="validation-policy"
      || record.id!==`validation-policy:${hash(record.policy)}` || JSON.stringify(record.policy.binding)!==JSON.stringify(bound))throw fail("INVALID");
    return record;
  }
  async function install({input,sourceIdentity,taskGit,baseline,paths,expectedPolicyId,authorize,selectedHashes,assertCurrent=()=>{}}){
    const bound=binding(input,sourceIdentity);
    if(typeof authorize!=="function"||await authorize()!==true)throw fail("ACCESS");assertActive();
    if((current(input,sourceIdentity)?.id||null)!==expectedPolicyId)throw fail("CHANGED");
    if(!Array.isArray(paths)||!paths.length||paths.length>32 || paths.some(name=>typeof name!=="string"||!/\.(?:cjs|mjs|js)$/.test(name)))throw fail("INVALID");
    try{manifestMap(paths.map(name=>({path:name,sizeBytes:0,sha256:"0".repeat(64)})));}catch{throw fail("INVALID");}
    if(baseline?.commit!==input.baselineCommit || !baseline.ref?.endsWith("/baseline") || !await taskGit.hasRevision(baseline))throw fail("INVALID");
    const runtime=await taskGit.ensure();assertActive();
    if(await runtime.git(["rev-list","--parents","-n","1",baseline.commit])!==baseline.commit)throw fail("INVALID");
    const entries=new Map((await taskGit.inspectTree(baseline.commit)).map(file=>[file.path,file]));assertActive();
    const selected=[...paths].sort().map(name=>entries.get(name));
    if(selected.some(file=>!file||file.sizeBytes>128*1024) || selected.reduce((sum,file)=>sum+file.sizeBytes,0)>1024*1024)throw fail("LIMIT");
    const temporary=fs.mkdtempSync(path.join(taskGit.rootPath,"check-policy-")),files=[];
    try{
      for(let i=0;i<selected.length;i++){
        assertActive();const file=selected[i],destination=path.join(temporary,String(i));
        const content=await runtime.writeBlob(file.blob,destination,file);assertActive();
        if(selectedHashes && selectedHashes[file.path]!==content.sha256)throw fail("SOURCE_CHANGED");
        const fd=fs.openSync(destination,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);let bytes;
        try{
          const stat=fs.fstatSync(fd);if(!stat.isFile()||stat.nlink!==1||stat.size!==file.sizeBytes)throw fail("SOURCE_CHANGED");
          bytes=Buffer.alloc(file.sizeBytes);let offset=0;
          while(offset<bytes.length){const count=fs.readSync(fd,bytes,offset,bytes.length-offset,offset);if(!count)throw fail("SOURCE_CHANGED");offset+=count;}
          if(createHash("sha256").update(bytes).digest("hex")!==content.sha256)throw fail("SOURCE_CHANGED");
        }finally{fs.closeSync(fd);}
        files.push({path:file.path,blob:file.blob,...content,base64:bytes.toString("base64")});
      }
      if(await authorize()!==true)throw fail("ACCESS");assertActive();
      const policy={version:1,type:"node-test",binding:bound,origin:{commit:baseline.commit,ref:baseline.ref},files};
      const id=`validation-policy:${hash(policy)}`;
      return store.db.transaction(()=>{
        binding(input,sourceIdentity);assertCurrent();
        if((current(input,sourceIdentity)?.id||null)!==expectedPolicyId)throw fail("CHANGED");
        const record=records.get(id)||records.put(id,{kind:"validation-policy",conversationId:input.conversationId,policy,createdAt:store.now()});
        records.put(pointerId(bound),{kind:"validation-policy-current",conversationId:input.conversationId,policyId:id});
        return record;
      })();
    }finally{fs.rmSync(temporary,{recursive:true,force:true});}
  }
  return Object.freeze({current,install});
}
module.exports={createIntegrationCheckPolicy};
