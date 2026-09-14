"use strict";
const fs=require("node:fs");
const path=require("node:path");
const {createHash}=require("node:crypto");
const hash=value=>createHash("sha256").update(JSON.stringify(value)).digest("hex");
const sha=value=>typeof value==="string" && /^[a-f0-9]{40}$/.test(value);
const fail=code=>Object.assign(new Error(`COLLAB_SHARED_GIT_${code}`),{code:`COLLAB_SHARED_GIT_${code}`});
const attributes="* !merge -filter -text -eol -working-tree-encoding\n";
function prefix(workspaceId){if(typeof workspaceId!=="string"||!workspaceId||workspaceId.length>200)throw fail("INVALID");return `refs/workspaces/${hash(workspaceId)}`;}

/** Published history and candidates live exclusively in the task object DB.
 * This primitive never reads a private working tree and does not call a model.
 * Publication requires an external validator bound to the exact candidate;
 * durable validation/outbox and cross-device publication are coordinated above. */
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
  return Object.freeze({
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
    async prepare({workspaceId,baseline,delivery,expectedHead}){
      const {git,merge,repository}=await runtime();await verified(baseline);await verified(delivery);
      if(!sha(expectedHead) || !baseline.ref.endsWith("/baseline") || !delivery.ref.startsWith(baseline.ref.replace(/baseline$/,"deliveries/")))throw fail("INVALID");
      const parent=(await git(["rev-list","--parents","-n","1",delivery.commit])).split(" ").slice(1);
      if(JSON.stringify(parent)!==JSON.stringify([baseline.commit]))throw fail("ANCESTRY_INVALID");
      const headRef=`${prefix(workspaceId)}/head`;
      if(await git(["rev-parse","--verify",headRef])!==expectedHead)throw fail("HEAD_CHANGED");
      let output,conflicts=false;
      try{output=await merge(["merge-tree","--write-tree","--no-messages","--name-only","-z",`--merge-base=${baseline.commit}`,expectedHead,delivery.commit]);}
      catch(error){if(error.code!==1 || typeof error.stdout!=="string")throw fail("MERGE_UNAVAILABLE");output=error.stdout;conflicts=true;}
      const [tree,...names]=output.split("\0");if(!sha(tree))throw fail("MERGE_INVALID");
      await taskGit.inspectTree(tree);
      if(conflicts)return {state:"conflicts",tree,paths:[...new Set(names.filter(Boolean))].sort(),head:expectedHead,delivery:delivery.commit,baseline:baseline.commit};
      const commit=await git(["commit-tree",tree,"-p",expectedHead,"-p",delivery.commit,"-m",`Shared task integration\n\n${JSON.stringify({baseline:baseline.commit,delivery:delivery.commit})}`]);
      const ref=`${prefix(workspaceId)}/candidates/${hash([expectedHead,baseline.commit,delivery.commit])}`;
      await immutable(git,ref,commit);
      return {state:"ready",repository,ref,commit,tree,headRef,head:expectedHead,delivery:delivery.commit,baseline:baseline.commit};
    },
    async publish({candidate,validate}){
      candidate=Object.freeze({...candidate});
      if(candidate.state!=="ready" || typeof validate!=="function" || !sha(candidate.head)||!sha(candidate.delivery)||!sha(candidate.tree)||!sha(candidate.baseline)
        || !/^refs\/workspaces\/[a-f0-9]{64}\/head$/.test(candidate.headRef||"")
        || candidate.ref!==candidate.headRef.replace(/head$/,`candidates/${hash([candidate.head,candidate.baseline,candidate.delivery])}`))throw fail("INVALID");
      const {git,repository}=await runtime();if(candidate.repository!==repository)throw fail("INVALID");await verified(candidate);
      if(await git(["rev-parse",`${candidate.commit}^{tree}`])!==candidate.tree
        || await git(["rev-list","--parents","-n","1",candidate.commit])!==`${candidate.commit} ${candidate.head} ${candidate.delivery}`)throw fail("ANCESTRY_INVALID");
      await taskGit.inspectTree(candidate.commit);
      const result=await validate(candidate);
      if(result?.ok!==true || result.commit!==candidate.commit)throw fail("VALIDATION_FAILED");
      try{await git(["update-ref",candidate.headRef,candidate.commit,candidate.head]);}
      catch{if(await git(["rev-parse","--verify",candidate.headRef])!==candidate.commit)throw fail("HEAD_CHANGED");}
      return {repository:candidate.repository,ref:candidate.headRef,commit:candidate.commit};
    },
  });
}
module.exports={createSharedGit};
