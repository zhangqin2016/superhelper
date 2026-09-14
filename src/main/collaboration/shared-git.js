"use strict";
const fs=require("node:fs");
const path=require("node:path");
const {createHash}=require("node:crypto");
const {mergeJson,MAX_JSON_BYTES,POLICY}=require("./integration-json-merge");
const {REPAIR_POLICY,REPAIR_LIMITS}=require("./conflict-repair");
const hash=value=>createHash("sha256").update(JSON.stringify(value)).digest("hex");
const sha=value=>typeof value==="string" && /^[a-f0-9]{40}$/.test(value);
const fail=code=>Object.assign(new Error(`COLLAB_SHARED_GIT_${code}`),{code:`COLLAB_SHARED_GIT_${code}`});
const attributes="* !merge -filter -text -eol -working-tree-encoding\n";
function prefix(workspaceId){if(typeof workspaceId!=="string"||!workspaceId||workspaceId.length>200)throw fail("INVALID");return `refs/workspaces/${hash(workspaceId)}`;}
function candidateRef(candidate){
  if(!/^refs\/workspaces\/[a-f0-9]{64}\/head$/.test(candidate.headRef||"")
    || candidate.resolutionHash!==undefined && !/^[a-f0-9]{64}$/.test(candidate.resolutionHash))throw fail("INVALID");
  const identity=[candidate.head,candidate.baseline,candidate.delivery];
  if(candidate.resolutionHash!==undefined)identity.push(candidate.resolutionHash);
  return candidate.headRef.replace(/head$/,`candidates/${hash(identity)}`);
}

/** Published history and candidates live exclusively in the task object DB.
 * This primitive never reads a private working tree. It calls no model itself:
 * an optional `resolve` hook supplied by the caller may propose complete file
 * contents for conflicted paths, which are written as an ordinary resolution
 * with its own identity and still pass the external validator before publication. */
function createSharedGit(taskGit){
  async function runtime(){
    const context=await taskGit.ensure(),info=path.join(context.repository,"info"),file=path.join(info,"attributes");
    try{fs.mkdirSync(info,{mode:0o700});}catch(error){if(error.code!=="EEXIST")throw error;}
    if(!fs.lstatSync(info).isDirectory() || fs.lstatSync(info).isSymbolicLink())throw fail("POLICY_INVALID");
    try{fs.writeFileSync(file,attributes,{flag:"wx",mode:0o600});}catch(error){if(error.code!=="EEXIST")throw error;}
    const stat=fs.lstatSync(file);
    if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||fs.readFileSync(file,"utf8")!==attributes)throw fail("POLICY_INVALID");
    // info/attributes has precedence over contributed .gitattributes. Force
    // the built-in text/binary behavior rather than a supplied union/driver.
    return {...context,merge:args=>context.git(["-c","merge.default=text","-c","merge.renormalize=false",...args])};
  }
  async function verified(revision){if(!await taskGit.hasRevision(revision))throw fail("REVISION_UNAVAILABLE");}
  async function immutable(git,ref,commit){
    try{await git(["update-ref",ref,commit,"0".repeat(40)]);}
    catch(error){if(await git(["rev-parse","--verify",ref]).catch(()=>null)!==commit)throw error;}
  }
  // Replace only the given paths on top of the merged tree in an isolated index.
  async function writeResolutions(git,tree,resolutions){
    const temporary=fs.mkdtempSync(path.join(taskGit.rootPath,"resolution-")),indexEnv={GIT_INDEX_FILE:path.join(temporary,"index")};
    try{
      await git(["read-tree",tree],indexEnv);
      for(const [name,blob] of resolutions)await git(["update-index","--add","--cacheinfo",`100644,${blob},${name}`],indexEnv);
      const resolvedTree=await git(["write-tree"],indexEnv);await taskGit.inspectTree(resolvedTree);return resolvedTree;
    }finally{fs.rmSync(temporary,{recursive:true,force:true});}
  }
  async function resolveJson({tree,paths,baseline,head,delivery}){
    // Only bounded regular files present at the same path on all three sides.
    // Renames, deletes, non-JSON and mixed unresolved conflicts stay pending.
    if(!paths.length || paths.length>32 || paths.some(name=>!name.endsWith(".json")))return null;
    const trees=await Promise.all([baseline,head,delivery].map(commit=>taskGit.inspectTree(commit)));
    const inputs=paths.map(name=>trees.map(entries=>entries.find(file=>file.path===name)));
    if(inputs.flat().some(file=>!file || file.sizeBytes>MAX_JSON_BYTES)
      || inputs.flat().reduce((sum,file)=>sum+file.sizeBytes,0)>6*1024*1024)return null;
    const {git,writeBlob}=await runtime(),temporary=fs.mkdtempSync(path.join(taskGit.rootPath,"json-merge-"));
    try{
      const resolutions=[];
      for(let i=0;i<paths.length;i++){
        const buffers=[];
        for(let j=0;j<3;j++){
          const file=inputs[i][j],destination=path.join(temporary,`${i}-${j}`);
          await writeBlob(file.blob,destination,file);buffers.push(fs.readFileSync(destination));
        }
        const result=mergeJson(...buffers);if(result.state!=="resolved")return null;
        const blob=await git(["hash-object","-w","--stdin"],undefined,result.text);
        resolutions.push([paths[i],blob]);
      }
      return {tree:await writeResolutions(git,tree,resolutions),resolutionHash:hash([POLICY,resolutions])};
    }finally{fs.rmSync(temporary,{recursive:true,force:true});}
  }
  /** Hand the conflicted text files that exist on all three sides to the
   * caller's resolver with their diff3 view. Complete resolutions become blobs;
   * anything else stays an unresolved path with the resolver's questions. */
  async function resolveWith({tree,paths,baseline,head,delivery},resolve){
    if(!paths.length||paths.length>REPAIR_LIMITS.maxFiles*2)return null;
    const trees=await Promise.all([baseline,head,delivery].map(commit=>taskGit.inspectTree(commit)));
    const {git,writeBlob}=await runtime(),temporary=fs.mkdtempSync(path.join(taskGit.rootPath,"repair-"));
    try{
      const files=[];let total=0;
      for(const [index,name] of paths.entries()){
        const sides=trees.map(entries=>entries.find(file=>file.path===name));
        if(sides.some(file=>!file||file.sizeBytes>REPAIR_LIMITS.maxFileBytes)||files.length>=REPAIR_LIMITS.maxFiles)continue;
        const size=sides.reduce((sum,file)=>sum+file.sizeBytes,0);if(total+size>REPAIR_LIMITS.maxTotalBytes)continue;total+=size;
        const [base,ours,theirs]=await Promise.all(sides.map(async(file,side)=>{const destination=path.join(temporary,`${index}-${side}`);await writeBlob(file.blob,destination,file);return destination;}));
        let merged=null;
        try{merged=await git(["merge-file","-p","--diff3","-L","ours","-L","base","-L","theirs",ours,base,theirs]);}
        catch(error){if(typeof error.stdout==="string"&&Number.isInteger(error.code)&&error.code>=1&&error.code<=127)merged=error.stdout;}
        files.push({path:name,base:fs.readFileSync(base),ours:fs.readFileSync(ours),theirs:fs.readFileSync(theirs),...(merged===null?{}:{merged:Buffer.from(merged)})});
      }
      if(!files.length)return null;
      const outcome=await resolve({files});if(!outcome)return null;
      const resolutions=[];
      for(const [name,bytes] of outcome.resolutions||[]){
        if(!files.some(file=>file.path===name)||!Buffer.isBuffer(bytes))throw fail("MERGE_INVALID");
        resolutions.push([name,await git(["hash-object","-w","--stdin"],undefined,bytes.toString("utf8"))]);
      }
      const repair={...outcome.evidence,questions:outcome.questions||[]};
      if(resolutions.length!==paths.length)return {repair,unresolvedPaths:paths.filter(name=>!resolutions.some(([resolved])=>resolved===name))};
      return {tree:await writeResolutions(git,tree,resolutions),resolutionHash:hash([REPAIR_POLICY,resolutions,repair.responseHash]),repair};
    }finally{fs.rmSync(temporary,{recursive:true,force:true});}
  }
  function receiptRef(candidate){
    if(!sha(candidate?.commit)||!sha(candidate.head)||!/^refs\/workspaces\/[a-f0-9]{64}\/head$/.test(candidate.headRef||""))throw fail("INVALID");
    return candidate.headRef.replace(/head$/,`publications/${hash([candidate.head,candidate.commit])}`);
  }
  async function remoteState(git,workspaceId){
    const object=await git(['rev-parse','--verify',`${prefix(workspaceId)}/remote-state`]).catch(()=>null);if(!object)return null;
    if(Number(await git(['cat-file','-s',object]))>4096)throw fail('REMOTE_INVALID');
    let state;try{state=JSON.parse(await git(['cat-file','blob',object]));}catch{throw fail('REMOTE_INVALID');}
    if(!state||Object.keys(state).sort().join(',')!=='commit,publicationId,revision'||!Number.isSafeInteger(state.revision)||state.revision<0||state.revision>=Number.MAX_SAFE_INTEGER
      ||!sha(state.commit)||(state.revision===0?state.publicationId!==null:typeof state.publicationId!=='string'||!/^[A-Za-z0-9_-]{1,200}$/.test(state.publicationId)))throw fail('REMOTE_INVALID');
    return {...state,object};
  }
  return Object.freeze({
    async remoteState(workspaceId){
      const {git}=await runtime();return remoteState(git,workspaceId);
    },
    // A verified remote snapshot replaces only the shared head. Existing local
    // candidates and publication receipts remain reachable for outbox recovery.
    // The remote revision and H share a Git transaction, so a crash cannot save
    // a newer H alongside an older monotonicity checkpoint in SQLite.
    async reconcileRemote({workspaceId,revision,remoteRevision,publicationId,expectedHead,expectedRemoteState,assertCurrent}){
      if(typeof assertCurrent!=='function'||!Number.isSafeInteger(remoteRevision)||remoteRevision<0||remoteRevision>=Number.MAX_SAFE_INTEGER
        ||(expectedHead!==null&&!sha(expectedHead))||(expectedRemoteState!==null&&!sha(expectedRemoteState))
        ||(remoteRevision===0?publicationId!==null:typeof publicationId!=='string'||!/^[A-Za-z0-9_-]{1,200}$/.test(publicationId)))throw fail('INVALID');
      const {git,repository}=await runtime(),ref=`${prefix(workspaceId)}/head`,remoteRef=`${prefix(workspaceId)}/remote-state`;
      if(revision?.repository!==repository||!(remoteRevision===0?/^refs\/tasks\/[a-f0-9]{64}\/baseline$/.test(revision.ref||''):
        new RegExp(`^${prefix(workspaceId)}/candidates/[a-f0-9]{64}$`).test(revision.ref||'')))throw fail('INVALID');
      await verified(revision);await taskGit.inspectTree(revision.commit);
      if(remoteRevision===0&&await git(['rev-list','--parents','-n','1',revision.commit])!==revision.commit)throw fail('ANCESTRY_INVALID');
      const current=await remoteState(git,workspaceId);
      if((current?.object||null)!==expectedRemoteState)throw fail('HEAD_CHANGED');
      if(current){
        if(remoteRevision<current.revision)throw fail('REMOTE_REGRESSED');
        if(remoteRevision===current.revision&&(current.commit!==revision.commit||current.publicationId!==publicationId))throw fail('REMOTE_CONFLICT');
      }
      const object=await git(['hash-object','-w','--stdin'],undefined,JSON.stringify({revision:remoteRevision,commit:revision.commit,publicationId}));
      assertCurrent();
      try{await git(['update-ref','--stdin'],undefined,`start\nupdate ${ref} ${revision.commit} ${expectedHead||'0'.repeat(40)}\nupdate ${remoteRef} ${object} ${expectedRemoteState||'0'.repeat(40)}\nprepare\ncommit\n`);}
      catch{throw fail('HEAD_CHANGED');}
      assertCurrent();return {repository,ref,commit:revision.commit,remoteRevision,publicationId};
    },
    async publication(candidate){
      const {git,repository}=await runtime(),ref=receiptRef(candidate);
      const commit=await git(["rev-parse","--verify",ref]).catch(()=>null);
      if(commit && commit!==candidate.commit)throw fail("RECEIPT_CONFLICT");
      if(commit)await git(["fsck","--strict","--no-reflogs","--no-dangling",commit]);
      return commit?{repository,ref:candidate.headRef,commit,receiptRef:ref}:null;
    },
    async initialize({workspaceId,baseline}){
      const {git,repository}=await runtime();await verified(baseline);
      if(!baseline.ref.endsWith("/baseline"))throw fail("INVALID");
      if(await git(["rev-list","--parents","-n","1",baseline.commit])!==baseline.commit)throw fail("ANCESTRY_INVALID");
      await taskGit.inspectTree(baseline.commit);
      const ref=`${prefix(workspaceId)}/head`;
      const existing=await git(["rev-parse","--verify",ref]).catch(()=>null);
      if(existing){await verified({ref,commit:existing});await taskGit.inspectTree(existing);return {repository,ref,commit:existing};}
      await immutable(git,ref,baseline.commit);return {repository,ref,commit:baseline.commit};
    },
    async prepare({workspaceId,baseline,delivery,expectedHead,resolve=null}){
      const {git,merge,repository}=await runtime();await verified(baseline);await verified(delivery);
      if(!sha(expectedHead) || !baseline.ref.endsWith("/baseline") || !delivery.ref.startsWith(baseline.ref.replace(/baseline$/,"deliveries/")))throw fail("INVALID");
      const parent=(await git(["rev-list","--parents","-n","1",delivery.commit])).split(" ").slice(1);
      if(JSON.stringify(parent)!==JSON.stringify([baseline.commit]))throw fail("ANCESTRY_INVALID");
      const headRef=`${prefix(workspaceId)}/head`;
      if(await git(["rev-parse","--verify",headRef])!==expectedHead)throw fail("HEAD_CHANGED");
      let output,conflicts=false;
      try{output=await merge(["merge-tree","--write-tree","--no-messages","--name-only","-z",`--merge-base=${baseline.commit}`,expectedHead,delivery.commit]);}
      catch(error){if(error.code!==1 || typeof error.stdout!=="string")throw fail("MERGE_UNAVAILABLE");output=error.stdout;conflicts=true;}
      let [tree,...names]=output.split("\0");if(!sha(tree))throw fail("MERGE_INVALID");
      await taskGit.inspectTree(tree);
      let resolution={};
      if(conflicts){
        const unresolved={state:"conflicts",tree,paths:[...new Set(names.filter(Boolean))].sort(),head:expectedHead,delivery:delivery.commit,baseline:baseline.commit};
        let resolved=await resolveJson(unresolved);
        if(!resolved&&typeof resolve==="function"){
          const outcome=await resolveWith(unresolved,resolve);
          if(outcome?.tree)resolved=outcome;
          else if(outcome)return {...unresolved,repair:outcome.repair,unresolvedPaths:outcome.unresolvedPaths};
        }
        if(!resolved)return unresolved;
        tree=resolved.tree;resolution={resolutionHash:resolved.resolutionHash,...(resolved.repair?{repair:resolved.repair}:{})};
      }
      const commit=await git(["commit-tree",tree,"-p",expectedHead,"-p",delivery.commit,"-m",`Shared task integration\n\n${JSON.stringify({baseline:baseline.commit,delivery:delivery.commit,...resolution})}`]);
      const ref=candidateRef({headRef,head:expectedHead,baseline:baseline.commit,delivery:delivery.commit,...resolution});
      await immutable(git,ref,commit);
      return {state:"ready",repository,ref,commit,tree,headRef,head:expectedHead,delivery:delivery.commit,baseline:baseline.commit,...resolution};
    },
    async publish({candidate,validate,canonicalHead}){
      candidate=Object.freeze({...candidate});
      if(candidate.state!=="ready" || typeof validate!=="function" || !sha(candidate.head)||!sha(candidate.delivery)||!sha(candidate.tree)||!sha(candidate.baseline)
        || !/^refs\/workspaces\/[a-f0-9]{64}\/head$/.test(candidate.headRef||"")
        || candidate.ref!==candidateRef(candidate))throw fail("INVALID");
      const {git,repository}=await runtime();if(candidate.repository!==repository)throw fail("INVALID");await verified(candidate);
      if(await git(["rev-parse",`${candidate.commit}^{tree}`])!==candidate.tree
        || await git(["rev-list","--parents","-n","1",candidate.commit])!==`${candidate.commit} ${candidate.head} ${candidate.delivery}`)throw fail("ANCESTRY_INVALID");
      await taskGit.inspectTree(candidate.commit);
      const result=await validate(candidate);
      if(result?.ok!==true || result.commit!==candidate.commit)throw fail("VALIDATION_FAILED");
      const receipt=receiptRef(candidate);
      if(await git(["rev-parse","--verify",receipt]).catch(()=>null)!==candidate.commit){
        let headCommand=`update ${candidate.headRef} ${candidate.commit} ${candidate.head}`;
        if(canonicalHead){
          if(canonicalHead.ref!==candidate.headRef||canonicalHead.repository!==repository)throw fail('INVALID');
          await verified(canonicalHead);
          try{await git(['merge-base','--is-ancestor',candidate.commit,canonicalHead.commit]);}catch{throw fail('ANCESTRY_INVALID');}
          headCommand=`verify ${candidate.headRef} ${canonicalHead.commit}`;
        }
        try{await git(["update-ref","--stdin"],undefined,`start\n${headCommand}\ncreate ${receipt} ${candidate.commit}\nprepare\ncommit\n`);}
        catch{if(await git(["rev-parse","--verify",receipt]).catch(()=>null)!==candidate.commit)throw fail("HEAD_CHANGED");}
      }
      return {repository:candidate.repository,ref:candidate.headRef,commit:candidate.commit,receiptRef:receipt};
    },
  });
}
module.exports={createSharedGit,candidateRef};
