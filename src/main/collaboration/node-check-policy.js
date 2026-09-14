"use strict";
const fs=require("node:fs"),path=require("node:path"),{createHash}=require("node:crypto");
const {manifestMap}=require("./task-apply-plan");
const {manifestHash}=require("./task-changeset");
const {unchanged}=require("./candidate-validation");
const {executeNodeTests}=require("./node-check-execution");
const hash=value=>createHash("sha256").update(JSON.stringify(value)).digest("hex");
const fail=()=>Object.assign(Error("Invalid pinned check policy"),{code:"COLLAB_CHECK_POLICY_INVALID"});
function createNodeCheckPolicy({taskGit,record,input,assertActive}){
  // Capture the trusted registry revision before any asynchronous execution.
  const policy=structuredClone(record?.policy);
  if(policy?.version!==1 || policy.type!=="node-test" || record?.id!==`validation-policy:${hash(policy)}`
    || ["conversationId","workspaceId","projectId","targetId"].some(key=>policy.binding?.[key]!==input[key])
    || !Array.isArray(policy.files)||!policy.files.length||policy.files.length>32)throw fail();
  const manifest=policy.files.map(file=>({path:file.path,sizeBytes:file.sizeBytes,sha256:file.sha256}));
  manifestMap(manifest);
  if(manifest.some(file=>file.sizeBytes>128*1024)||manifest.reduce((sum,file)=>sum+file.sizeBytes,0)>1024*1024)throw fail();
  for(const file of policy.files){
    const bytes=Buffer.from(file.base64,"base64");
    if(!/\.(?:cjs|mjs|js)$/.test(file.path)||bytes.length!==file.sizeBytes||bytes.toString("base64")!==file.base64
      || createHash("sha256").update(bytes).digest("hex")!==file.sha256)throw fail();
  }
  const policyId=`node-tests-v1:${hash([record.id,process.version])}`;
  async function validate(candidate,context){
    const guard=()=>{assertActive();context.assertActive();};guard();
    const temporary=fs.mkdtempSync(path.join(path.dirname(taskGit.rootPath),"node-validation-"));
    let execution,state="failed",expected;
    try{
      const material=await taskGit.materializeSnapshot({revision:candidate,destinationRoot:path.join(temporary,"copy"),parents:[candidate.head,candidate.delivery]});guard();
      const files=new Map(material.manifest.map(file=>[file.path,file]));
      for(const file of policy.files){
        guard();const destination=path.join(material.snapshotRoot,file.path);
        fs.mkdirSync(path.dirname(destination),{recursive:true,mode:0o700});
        if(fs.existsSync(destination)){if(!fs.lstatSync(destination).isFile())throw fail();fs.chmodSync(destination,0o600);fs.unlinkSync(destination);}
        fs.writeFileSync(destination,Buffer.from(file.base64,"base64"),{flag:"wx",mode:0o400});
        files.set(file.path,{path:file.path,sizeBytes:file.sizeBytes,sha256:file.sha256});
      }
      expected=[...files.values()];manifestMap(expected);
      const scratch=path.join(temporary,"scratch");fs.mkdirSync(scratch,{mode:0o700});
      execution=await executeNodeTests({snapshotRoot:material.snapshotRoot,scratch,
        files:policy.files.map(file=>path.join(material.snapshotRoot,file.path)),assertActive:guard});guard();
      const intact=await unchanged(material.snapshotRoot,expected,guard);guard();
      state=intact?execution.state:"failed";
      const report={version:1,kind:"node-tests",checkPolicyId:record.id,commit:candidate.commit,policyId,
        originalOrigin:policy.origin,originalChecks:manifest,executionManifestHash:manifestHash(expected),
        execution,executionCopyUnchanged:intact,state};
      return {ok:state==="passed",state,commit:candidate.commit,policyId,evidenceHash:hash(report),report};
    }finally{fs.rmSync(temporary,{recursive:true,force:true});}
  }
  return Object.freeze({policyId,validate});
}
module.exports={createNodeCheckPolicy};
