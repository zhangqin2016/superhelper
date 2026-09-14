"use strict";
const fs=require("node:fs"),path=require("node:path"),{createHash}=require("node:crypto");
const {manifestMap}=require("./task-apply-plan");
const {manifestHash}=require("./task-changeset");
const {unchanged}=require("./candidate-validation");
const {executeNodeTests}=require("./node-check-execution");
const hash=value=>createHash("sha256").update(JSON.stringify(value)).digest("hex");
const fail=()=>Object.assign(Error("Invalid pinned check policy"),{code:"COLLAB_CHECK_POLICY_INVALID"});
const PACKAGE=/^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/i;
function dependencyIdentity(root){
  if(typeof root!=="string"||!path.isAbsolute(root)||fs.realpathSync(root)!==root||path.basename(root)!=="node_modules")throw fail();
  const stat=fs.lstatSync(root);if(!stat.isDirectory())throw fail();
  return hash([root,`${stat.dev}:${stat.ino}`]);
}
/** Pinned original checks and the test infrastructure they import are
 * restored from the baseline over the candidate before execution, so a
 * contribution cannot weaken a helper instead of a test. Code under test that
 * a check imports is recorded with whether the candidate changed it, never
 * restored. `dependencyRoot` is the project's own installed node_modules,
 * supplied explicitly and exposed read-only. Nothing is installed. */
function createNodeCheckPolicy({taskGit,record,input,assertActive,candidateParents,dependencyRoot=null}){
  const parents=candidateParents===undefined?null:structuredClone(candidateParents);
  // Capture the trusted registry revision before any asynchronous execution.
  const policy=structuredClone(record?.policy);
  if(![1,2].includes(policy?.version) || policy.type!=="node-test" || record?.id!==`validation-policy:${hash(policy)}`
    || ["conversationId","workspaceId","projectId","targetId"].some(key=>policy.binding?.[key]!==input[key])
    || !Array.isArray(policy.files)||!policy.files.length||policy.files.length>32)throw fail();
  const helpers=policy.version===2?policy.helpers:[],dependencies=policy.version===2?policy.dependencies:[],sourceImports=policy.version===2?policy.sourceImports:[];
  if(!Array.isArray(helpers)||helpers.length>64||!Array.isArray(dependencies)||dependencies.length>64||!Array.isArray(sourceImports)||sourceImports.length>64
    ||dependencies.some(name=>typeof name!=="string"||!PACKAGE.test(name))||new Set(dependencies).size!==dependencies.length)throw fail();
  const manifest=policy.files.map(file=>({path:file.path,sizeBytes:file.sizeBytes,sha256:file.sha256}));
  const helperManifest=helpers.map(file=>({path:file.path,sizeBytes:file.sizeBytes,sha256:file.sha256}));
  const sourceManifest=sourceImports.map(file=>({path:file.path,sizeBytes:file.sizeBytes,sha256:file.sha256}));
  if(sourceManifest.some(file=>file.sha256!==null&&!/^[a-f0-9]{64}$/.test(file.sha256||"")))throw fail();
  manifestMap([...manifest,...helperManifest,...sourceManifest.map(file=>({...file,sha256:file.sha256||"0".repeat(64)}))]);
  if(manifest.some(file=>file.sizeBytes>128*1024)||manifest.reduce((sum,file)=>sum+file.sizeBytes,0)>1024*1024)throw fail();
  if(helperManifest.some(file=>file.sizeBytes>256*1024)||helperManifest.reduce((sum,file)=>sum+file.sizeBytes,0)>4*1024*1024)throw fail();
  for(const [file,pattern] of [...policy.files.map(file=>[file,/\.(?:cjs|mjs|js)$/]),...helpers.map(file=>[file,/\.(?:cjs|mjs|js|json)$/])]){
    const bytes=Buffer.from(file.base64,"base64");
    if(!pattern.test(file.path)||bytes.length!==file.sizeBytes||bytes.toString("base64")!==file.base64
      || createHash("sha256").update(bytes).digest("hex")!==file.sha256)throw fail();
  }
  const dependencyRootId=dependencyRoot===null?null:dependencyIdentity(dependencyRoot);
  const policyId=`node-tests-v${policy.version}:${hash([record.id,process.version])}`;
  async function validate(candidate,context){
    const guard=()=>{assertActive();context.assertActive();};guard();
    const temporary=fs.mkdtempSync(path.join(path.dirname(taskGit.rootPath),"node-validation-"));
    let execution,state="failed",expected,dependencyState=dependencies.length?"unavailable":"none";
    try{
      const material=await taskGit.materializeSnapshot({revision:candidate,destinationRoot:path.join(temporary,"copy"),parents:parents||[candidate.head,candidate.delivery]});guard();
      const files=new Map(material.manifest.map(file=>[file.path,file]));
      const candidateHashes=new Map(material.manifest.map(file=>[file.path,file.sha256]));
      for(const file of [...policy.files,...helpers]){
        guard();const destination=path.join(material.snapshotRoot,file.path);
        fs.mkdirSync(path.dirname(destination),{recursive:true,mode:0o700});
        if(fs.existsSync(destination)){if(!fs.lstatSync(destination).isFile())throw fail();fs.chmodSync(destination,0o600);fs.unlinkSync(destination);}
        fs.writeFileSync(destination,Buffer.from(file.base64,"base64"),{flag:"wx",mode:0o400});
        files.set(file.path,{path:file.path,sizeBytes:file.sizeBytes,sha256:file.sha256});
      }
      expected=[...files.values()];manifestMap(expected);
      const scratch=path.join(temporary,"scratch");fs.mkdirSync(scratch,{mode:0o700});
      // Third-party imports resolve only through the explicitly supplied
      // project node_modules, linked beside the copy so the candidate tree
      // itself can never shadow a dependency.
      if(dependencies.length&&expected.some(file=>file.path.split("/").includes("node_modules")))execution={state:"failed",code:"CANDIDATE_NODE_MODULES"};
      else if(dependencies.length&&!dependencyRoot)execution={state:"required",code:"DEPENDENCIES_UNAVAILABLE"};
      else{
        let dependencyLink=null;
        if(dependencies.length){dependencyLink=path.join(temporary,"node_modules");fs.symlinkSync(dependencyRoot,dependencyLink);dependencyState="linked";}
        execution=await executeNodeTests({snapshotRoot:material.snapshotRoot,scratch,dependencyRoot:dependencyLink?dependencyRoot:null,dependencyLink,
          files:policy.files.map(file=>path.join(material.snapshotRoot,file.path)),assertActive:guard});guard();
      }
      const intact=await unchanged(material.snapshotRoot,expected,guard);guard();
      state=intact?execution.state:"failed";
      const report={version:2,kind:"node-tests",checkPolicyId:record.id,commit:candidate.commit,policyId,
        originalOrigin:policy.origin,originalChecks:manifest,originalHelpers:helperManifest,
        sourceImports:sourceManifest.map(file=>({path:file.path,changed:file.sha256===null?null:candidateHashes.get(file.path)!==file.sha256})),
        dependencies:{specifiers:dependencies,state:dependencyState,rootIdentity:dependencyState==="linked"?dependencyRootId:null},
        executionManifestHash:manifestHash(expected),execution,executionCopyUnchanged:intact,state};
      return {ok:state==="passed",state,commit:candidate.commit,policyId,evidenceHash:hash(report),report};
    }finally{fs.rmSync(temporary,{recursive:true,force:true});}
  }
  return Object.freeze({policyId,validate});
}
module.exports={createNodeCheckPolicy};
