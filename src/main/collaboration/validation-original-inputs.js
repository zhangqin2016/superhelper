"use strict";
const fs=require("node:fs");
const path=require("node:path");
const {createHash}=require("node:crypto");
const {manifestMap}=require("./task-apply-plan");
const hash=value=>createHash("sha256").update(value).digest("hex");
const fail=code=>Object.assign(Error(`COLLAB_VALIDATION_INPUT_${code}`),{code:`COLLAB_VALIDATION_INPUT_${code}`});

/** A host checker can read original assertions/configuration independently of
 * candidate edits. Only the candidate's B/H/D are reachable through this API.
 * Read provenance is evidence of input coverage, never proof a test executed. */
function createValidationOriginalInputs({taskGit,candidate,temporaryRoot,assertActive}){
  candidate=Object.freeze({...candidate});
  const versions={baseline:candidate.baseline,head:candidate.head,delivery:candidate.delivery};
  if(Object.values(versions).some(value=>!/^[a-f0-9]{40}$/.test(value||"")))throw fail("INVALID");
  const trees=new Map(),reads=[];
  let ready,tail=Promise.resolve(),closed=false,pending=0,requests=0,failures=0,totalBytes=0,receipt;
  const guard=()=>{assertActive();if(closed)throw fail("CLOSED");};
  async function initialize(){
    guard();if(!await taskGit.hasRevision(candidate))throw fail("BINDING");guard();
    const runtime=await taskGit.ensure();
    if(await runtime.git(["rev-list","--parents","-n","1",candidate.commit])!==`${candidate.commit} ${candidate.head} ${candidate.delivery}`
      || await runtime.git(["rev-list","--parents","-n","1",candidate.delivery])!==`${candidate.delivery} ${candidate.baseline}`
      || await runtime.git(["rev-list","--parents","-n","1",candidate.baseline])!==candidate.baseline)throw fail("BINDING");
    guard();return runtime;
  }
  async function readOne(request){
    guard();
    const {version,path:relative}=request,commit=versions[version];
    const runtime=await (ready ||= initialize());guard();
    if(!trees.has(commit)){
      const entries=await taskGit.inspectTree(commit);guard();
      const tree=await runtime.git(["rev-parse",`${commit}^{tree}`]);guard();
      trees.set(commit,{entries:new Map(entries.map(file=>[file.path,file])),tree});
    }
    const {entries,tree}=trees.get(commit),file=entries.get(relative),identity={version,commit,tree,path:relative};
    if(!file){const value={...identity,state:"absent"};reads.push(value);return Object.freeze({...value});}
    if(file.sizeBytes>4*1024*1024 || totalBytes+file.sizeBytes>64*1024*1024)throw fail("LIMIT");
    totalBytes+=file.sizeBytes;
    const temporary=fs.mkdtempSync(path.join(temporaryRoot,"original-input-")),destination=path.join(temporary,"blob");
    try{
      const content=await runtime.writeBlob(file.blob,destination,file);guard();
      const fd=fs.openSync(destination,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
      let bytes;
      try{
        const stat=fs.fstatSync(fd);if(!stat.isFile()||stat.nlink!==1||stat.size!==file.sizeBytes)throw fail("CHANGED");
        bytes=Buffer.alloc(file.sizeBytes);let offset=0;
        while(offset<bytes.length){const count=fs.readSync(fd,bytes,offset,bytes.length-offset,offset);if(!count)throw fail("CHANGED");offset+=count;}
        if(hash(bytes)!==content.sha256)throw fail("CHANGED");
      }finally{fs.closeSync(fd);}
      guard();const value={...identity,state:"present",blob:file.blob,...content};reads.push(value);
      return Object.freeze({...value,bytes});
    }finally{fs.rmSync(temporary,{recursive:true,force:true});}
  }
  async function read(request){
    try{
      guard();
      if(!request || Array.isArray(request) || Object.keys(request).sort().join(",")!=="path,version" || !Object.hasOwn(versions,request.version))throw fail("INVALID");
      try{manifestMap([{path:request.path,sha256:"0".repeat(64),sizeBytes:0}]);}catch{throw fail("INVALID");}
      if(++requests>100)throw fail("LIMIT");
      const copy=Object.freeze({...request});pending++;
      const result=tail.then(()=>readOne(copy)).finally(()=>{pending--;});tail=result.catch(()=>{});
      return await result;
    }catch(error){failures++;throw error;}
  }
  function close(){
    if(receipt)return receipt;
    closed=true;
    const details=reads.map(value=>Object.freeze({...value}));
    receipt=Object.freeze({version:1,versions:Object.freeze({...versions}),reads:Object.freeze(details),
      requests,pending,failures,totalBytes,evidenceHash:hash(JSON.stringify({versions,reads:details,requests,pending,failures,totalBytes}))});
    return receipt;
  }
  return Object.freeze({read,close});
}
module.exports={createValidationOriginalInputs};
