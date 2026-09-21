"use strict";
const fs=require("node:fs");
const path=require("node:path");
const {spawn}=require("node:child_process");
const {createHash}=require("node:crypto");
const {decodeJsonBuffer}=require("../character-worlds/bounded-json");
const MAX_BYTES=1024*1024;
const hash=value=>createHash("sha256").update(value).digest("hex");

/** Parse stdin with the app's Node runtime. No contributed file is imported,
 * evaluated, passed as a command, or allowed to supply runtime environment. */
async function checkSyntax({source,mode,assertActive,timeoutMs=3000,spawnProcess=spawn}){
  assertActive();
  if(!Buffer.isBuffer(source)||source.length>MAX_BYTES||!["module","commonjs"].includes(mode))throw new TypeError("Invalid syntax input");
  return new Promise((resolve,reject)=>{
    const env={ELECTRON_RUN_AS_NODE:"1"};
    if(process.platform==="win32"&&process.env.SystemRoot)env.SystemRoot=process.env.SystemRoot;
    const child=spawnProcess(process.execPath,["--max-old-space-size=128","--check",`--input-type=${mode}`],
      {env,stdio:["pipe","pipe","pipe"],windowsHide:true});
    let code=null,cancelled=null,bytes=0,diagnostic="";
    const digest=createHash("sha256");
    const stop=reason=>{code ||= reason;child.kill("SIGKILL");};
    const output=chunk=>{
      bytes+=chunk.length;
      if(bytes>64*1024){stop("OUTPUT_LIMIT");return;}
      digest.update(chunk);
      if(diagnostic.length<4096)diagnostic+=chunk.toString("utf8").slice(0,4096-diagnostic.length);
    };
    child.stdout.on("data",output);child.stderr.on("data",output);
    child.stdin.on("error",()=>{});
    child.on("error",()=>{code="RUNTIME_UNAVAILABLE";});
    const timeout=setTimeout(()=>stop("TIMEOUT"),timeoutMs);
    const guard=setInterval(()=>{try{assertActive();}catch(error){cancelled=error;stop("CANCELLED");}},50);
    child.once("close",exitCode=>{
      clearTimeout(timeout);clearInterval(guard);
      try{assertActive();}catch(error){cancelled ||= error;}
      if(cancelled){reject(cancelled);return;}
      resolve({status:code?"required":exitCode===0?"passed":exitCode===1?"failed":"required",
        ...(code?{code}:{}),exitCode,outputHash:digest.digest("hex"),...(diagnostic?{diagnostic}:{})});
    });
    child.stdin.end(source);
  });
}

async function checkCandidateJavascript({snapshotRoot,manifest,assertActive}){
  const entries=new Map(manifest.map(file=>[file.path,file])),details=[];
  const files=manifest.filter(file=>/\.(?:js|cjs|mjs)$/.test(file.path));
  const packages=new Map();let readBytes=0,state="passed";
  const deadline=Date.now()+30000;
  const mark=status=>{if(status==="failed" || status==="required"&&state!=="failed")state=status;};
  function read(file){
    assertActive();
    if(file.sizeBytes>MAX_BYTES || readBytes+file.sizeBytes>20*MAX_BYTES)throw Error("limit");
    const fd=fs.openSync(path.join(snapshotRoot,file.path),fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
    try{
      const stat=fs.fstatSync(fd);
      if(!stat.isFile()||stat.nlink!==1||stat.size!==file.sizeBytes)throw Error("changed");
      const bytes=Buffer.alloc(file.sizeBytes);let offset=0;
      while(offset<bytes.length){const count=fs.readSync(fd,bytes,offset,bytes.length-offset,offset);if(!count)throw Error("changed");offset+=count;}
      readBytes+=bytes.length;if(hash(bytes)!==file.sha256)throw Error("changed");return bytes;
    }finally{fs.closeSync(fd);}
  }
  function mode(file){
    if(file.path.endsWith(".mjs"))return "module";
    if(file.path.endsWith(".cjs"))return "commonjs";
    let directory=path.posix.dirname(file.path);
    for(;;){
      const name=directory==="."?"package.json":`${directory}/package.json`;
      if(entries.has(name)){
        if(!packages.has(name)){
          const value=decodeJsonBuffer(read(entries.get(name)),{maxContainerBytes:MAX_BYTES,maxJsonBytes:MAX_BYTES}).data;
          if(!value||typeof value!=="object"||Array.isArray(value)||value.type!==undefined&&!["module","commonjs"].includes(value.type))throw Error("package");
          packages.set(name,value.type||"auto");
        }
        return packages.get(name);
      }
      if(directory===".")return "auto";directory=path.posix.dirname(directory);
    }
  }
  for(const file of files.slice(0,200)){
    assertActive();
    if(Date.now()>=deadline){mark("required");break;}
    let source,inputMode;
    try{inputMode=mode(file);source=read(file);}catch{
      assertActive();mark("required");details.push({path:file.path,sha256:file.sha256,status:"required",code:"INPUT_UNAVAILABLE"});continue;
    }
    const attempts=[];
    for(const value of inputMode==="auto"?["commonjs","module"]:[inputMode]){
      attempts.push({mode:value,...await checkSyntax({source,mode:value,assertActive,timeoutMs:Math.max(1,Math.min(3000,deadline-Date.now()))})});
      if(attempts.at(-1).status!=="failed")break;
    }
    const status=attempts.at(-1).status;mark(status);
    details.push({path:file.path,sha256:file.sha256,status,attempts});
  }
  if(details.length<files.length)mark("required");
  const coverage={eligible:files.length,attempted:details.length,parsed:details.filter(item=>item.attempts).length,
    otherFiles:manifest.length-files.length,readBytes};
  return {id:"javascript-syntax",version:"1",status:state,coverage:"Node syntax only; no execution, type checking or tests",
    runtime:process.version,counts:coverage,evidenceHash:hash(JSON.stringify({coverage,details})),details};
}
module.exports={checkSyntax,checkCandidateJavascript};
