"use strict";
const fs=require("node:fs");
const path=require("node:path");
const {createHash}=require("node:crypto");
const {promisify}=require("node:util");
const execute=promisify(require("node:child_process").execFile);
const {WorkspaceGit}=require("../workspace-git");
const {manifestMap}=require("./task-apply-plan");
const {readTaskFile,safeTaskRoot}=require("./task-application");
const {mergeJson}=require("./integration-json-merge");
const fail=code=>Object.assign(Error(`COLLAB_LOCAL_CANDIDATE_${code}`),{code:`COLLAB_LOCAL_CANDIDATE_${code}`});
const hash=bytes=>createHash("sha256").update(bytes).digest("hex");
const entry=(name,bytes)=>({path:name,sha256:hash(bytes),sizeBytes:bytes.length});
const overlap=(a,b)=>a===b||a.startsWith(b+path.sep)||b.startsWith(a+path.sep);
function text(bytes){
  if(bytes.length>1024*1024||bytes.includes(0))return false;
  try{new TextDecoder("utf-8",{fatal:true}).decode(bytes);return true;}catch{return false;}
}
async function mergeFile(base,local,shared,scratch,runtime){
  if(![base,local,shared].every(text))return null;
  for(const [name,bytes]of [["a",base],["w",local],["m",shared]])fs.writeFileSync(path.join(scratch,name),bytes,{mode:0o600});
  const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>!key.startsWith("GIT_")));
  Object.assign(env,runtime.env,{PATH:[...runtime.pathEntries,process.env.PATH||""].join(path.delimiter),
    GIT_CONFIG_NOSYSTEM:"1",GIT_CONFIG_GLOBAL:process.platform==="win32"?"NUL":"/dev/null",
    GIT_CEILING_DIRECTORIES:path.dirname(scratch),GIT_TERMINAL_PROMPT:"0"});
  try{
    const result=await execute(runtime.executable,["merge-file","--stdout","--diff3","w","a","m"],
      {cwd:scratch,env,encoding:"buffer",timeout:20000,maxBuffer:4*1024*1024,windowsHide:true});
    return result.stdout;
  }catch(error){
    if(Number.isInteger(error.code)&&error.code>=1&&error.code<=127)return null;
    throw fail("MERGE_UNAVAILABLE");
  }
}

/** A and M are authenticated immutable snapshots. Read only their path union
 * from W: unrelated private files remain untouched and never enter a shared
 * object DB. Output is a private candidate, not validation or a write receipt. */
async function prepareLocalCandidate({base,shared,rootPath,destinationRoot,assertActive,gitOptions}={}){
  if(typeof assertActive!=="function")throw fail("INVALID");
  assertActive();
  const localRoot=safeTaskRoot(rootPath),aRoot=safeTaskRoot(base.rootPath),mRoot=safeTaskRoot(shared.rootPath),storage=safeTaskRoot(destinationRoot);
  if([aRoot,mRoot,localRoot].some(root=>overlap(root,storage))||overlap(localRoot,aRoot)||overlap(localRoot,mRoot))throw fail("ROOT_OVERLAP");
  const a=manifestMap(base.manifest),m=manifestMap(shared.manifest);
  const union=new Map([...a,...m]);
  manifestMap([...union.values()]);
  if([...a.values(),...m.values()].reduce((sum,file)=>sum+file.sizeBytes,0)>1024*1024*1024)throw fail("LIMIT_EXCEEDED");
  const rootIdentity=fs.statSync(localRoot),sameRoot=()=>{safeTaskRoot(localRoot);const now=fs.statSync(localRoot);if(now.ino!==rootIdentity.ino||now.dev!==rootIdentity.dev)throw fail("INPUT_CHANGED");};
  const attempt=fs.mkdtempSync(path.join(storage,"candidate-")),snapshotRoot=path.join(attempt,"snapshot"),scratch=path.join(attempt,"merge");
  fs.mkdirSync(snapshotRoot,{mode:0o700});fs.mkdirSync(scratch,{mode:0o700});
  const currentManifest=[],manifest=[],conflicts=[],paths=[];
  let total=0,outputBytes=0,runtime;
  try{
    for(const [key,file]of union){
      assertActive();sameRoot();paths.push(file.path);
      const before=a.get(key),after=m.get(key);
      if(before&&after&&before.path!==after.path)throw fail("PATH_CONFLICT");
      const read=(root,expected)=>{
        if(!expected)return null;
        const value=readTaskFile(root,expected.path);
        if(!value||value.sha256!==expected.sha256||value.sizeBytes!==expected.sizeBytes)throw fail("SNAPSHOT_CHANGED");
        return value;
      };
      const original=read(aRoot,before),incoming=read(mRoot,after),local=readTaskFile(localRoot,file.path);
      if(local){currentManifest.push(entry(file.path,local.bytes));total+=local.bytes.length;}
      if(total>512*1024*1024)throw fail("LIMIT_EXCEEDED");
      const same=(x,y)=>(x?.sha256||null)===(y?.sha256||null);
      let bytes;
      if(same(original,incoming)||same(local,incoming))bytes=local?.bytes||null;
      else if(same(original,local))bytes=incoming?.bytes||null;
      else if(original&&local&&incoming){
        runtime ||= await new WorkspaceGit(gitOptions).runtime();assertActive();
        bytes=await mergeFile(original.bytes,local.bytes,incoming.bytes,scratch,runtime);assertActive();
        if(bytes===null&&file.path.endsWith(".json")){
          const result=mergeJson(original.bytes,local.bytes,incoming.bytes);
          if(result.state==="resolved")bytes=Buffer.from(result.text);
        }
        if(bytes===null){conflicts.push({path:file.path,reason:"content"});continue;}
      }else{conflicts.push({path:file.path,reason:!incoming?"delete_modify":!local?"modify_delete":"add_add"});continue;}
      if(bytes!==null){
        outputBytes+=bytes.length;if(outputBytes>512*1024*1024)throw fail("LIMIT_EXCEEDED");
        const destination=path.join(snapshotRoot,file.path);fs.mkdirSync(path.dirname(destination),{recursive:true,mode:0o700});
        fs.writeFileSync(destination,bytes,{flag:"wx",mode:0o600});manifest.push(entry(file.path,bytes));
      }
    }
    // A merge subprocess yields. Never label a candidate ready for a W that
    // changed during preparation; the application broker rechecks again later.
    assertActive();sameRoot();const current=new Map(currentManifest.map(file=>[file.path,file]));
    for(const name of paths)if((readTaskFile(localRoot,name)?.sha256||null)!==(current.get(name)?.sha256||null))throw fail("INPUT_CHANGED");
    manifestMap(manifest);
    return {state:conflicts.length?"conflicts":"ready",snapshotRoot,manifest,currentManifest,paths,conflicts};
  }catch(error){fs.rmSync(attempt,{recursive:true,force:true});throw error;}
  finally{if(fs.existsSync(scratch))fs.rmSync(scratch,{recursive:true,force:true});}
}
module.exports={prepareLocalCandidate};
