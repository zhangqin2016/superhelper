"use strict";
const fs=require("node:fs"),path=require("node:path"),{spawn}=require("node:child_process");
const {createHash}=require("node:crypto");
const {StringDecoder}=require("node:string_decoder");
const hash=value=>createHash("sha256").update(value).digest("hex");
function sandboxProfile(snapshotRoot,scratch,bootstrap,dependencies=null){
  const executable=fs.realpathSync(process.execPath),appEnd=executable.indexOf(".app/");
  const literals=[executable,"/","/dev/null","/dev/random","/dev/urandom"];
  if(bootstrap)literals.push(bootstrap);
  if(dependencies)literals.push(dependencies.link);
  const directories=[snapshotRoot,scratch,"/System","/usr/lib","/usr/share/zoneinfo","/private/var/db/timezone"];
  if(dependencies)directories.push(dependencies.root);
  if(appEnd>=0)directories.push(executable.slice(0,appEnd+4));
  if([...literals,...directories].some(value=>/[\x00-\x1f]/.test(value)))throw Error("Unsupported sandbox path");
  return `(version 1)(deny default)
    (allow file-read-metadata)(allow sysctl-read)(allow process-fork)
    (allow process-exec (literal ${JSON.stringify(executable)}))
    (allow signal (target same-sandbox))
    (allow file-read-data ${literals.map(value=>`(literal ${JSON.stringify(value)})`).join(" ")} ${directories.map(value=>`(subpath ${JSON.stringify(value)})`).join(" ")})
    (allow file-write* (subpath ${JSON.stringify(scratch)}) (literal "/dev/null"))`;
}
async function executeNodeTests({snapshotRoot,scratch,files,assertActive,timeoutMs=45000,dependencyRoot=null,dependencyLink=null}){
  assertActive();
  if(process.platform!=="darwin"||!fs.existsSync("/usr/bin/sandbox-exec"))return {state:"required",code:"SANDBOX_UNAVAILABLE"};
  if(!Array.isArray(files)||!files.length||files.length>32 || [snapshotRoot,scratch,...files].some(value=>!path.isAbsolute(value)||fs.realpathSync(value)!==value))throw Error("Invalid check roots");
  if((dependencyRoot===null)!==(dependencyLink===null))throw Error("Invalid dependency roots");
  if(dependencyRoot!==null&&(!path.isAbsolute(dependencyRoot)||fs.realpathSync(dependencyRoot)!==dependencyRoot||!path.isAbsolute(dependencyLink)
    ||!fs.lstatSync(dependencyLink).isSymbolicLink()||fs.realpathSync(dependencyLink)!==dependencyRoot))throw Error("Invalid dependency roots");
  const dependencies=dependencyRoot===null?null:{root:dependencyRoot,link:dependencyLink};
  // Node 24 also inherits -e from its internal option binding. Use a trusted
  // file outside the writable scratch tree so test children receive no bootstrap.
  const source=fs.readFileSync(path.join(__dirname,"node-check-host.cjs"),"utf8");
  const hostRoot=fs.mkdtempSync(path.join(path.dirname(scratch),"node-check-host-"));
  try{
  const bootstrap=path.join(hostRoot,"host.cjs");
  fs.writeFileSync(bootstrap,source,{flag:"wx",mode:0o400});
  const profile=sandboxProfile(snapshotRoot,scratch,bootstrap,dependencies);
  return await new Promise((resolve,reject)=>{
    const child=spawn("/usr/bin/sandbox-exec",["-p",profile,process.execPath,"--max-old-space-size=256",bootstrap],
      {cwd:snapshotRoot,env:{ELECTRON_RUN_AS_NODE:"1",TMPDIR:scratch,TMP:scratch,TEMP:scratch},detached:true,stdio:["pipe","pipe","pipe","pipe"],windowsHide:true});
    let report="",diagnostic="",size=0,code=null,cancelled=null;
    const reportDecoder=new StringDecoder("utf8");
    const kill=()=>{try{process.kill(-child.pid,"SIGKILL");}catch{child.kill("SIGKILL");}};
    const output=(chunk,isReport)=>{
      size+=chunk.length;if(size>256*1024){code="OUTPUT_LIMIT";kill();return;}
      if(isReport)report+=reportDecoder.write(chunk);else if(diagnostic.length<4000)diagnostic+=chunk.toString("utf8").slice(0,4000-diagnostic.length);
    };
    child.stdout.on("data",chunk=>output(chunk,false));child.stderr.on("data",chunk=>output(chunk,false));child.stdio[3].on("data",chunk=>output(chunk,true));
    child.stdin.on("error",()=>{});child.on("error",()=>{code="RUNTIME_UNAVAILABLE";});
    const timer=setTimeout(()=>{code="TIMEOUT";kill();},timeoutMs);
    const guard=setInterval(()=>{try{assertActive();}catch(error){cancelled=error;kill();}},50);
    child.once("close",(exitCode,signal)=>{
      clearTimeout(timer);clearInterval(guard);kill();
      try{assertActive();}catch(error){cancelled ||= error;}
      if(cancelled){reject(cancelled);return;}
      report+=reportDecoder.end();
      let result;try{result=JSON.parse(report);}catch{}
      if(!code&&result?.limited&&result.limitReason==='SCRATCH_LIMIT')code='SCRATCH_LIMIT';
      const validCounts=value=>value?.success===true&&Number.isSafeInteger(value.counts?.tests)&&value.counts.tests>0
        && ["failed","cancelled","skipped","todo"].every(key=>value.counts[key]===0);
      const covered=new Set((result?.perFile||[]).filter(validCounts).map(value=>value.file));
      const ok=!code&&exitCode===0&&result?.version===1&&!result.limited&&validCounts(result.summary)&&files.every(file=>covered.has(file));
      resolve({state:ok?"passed":"failed",...(code?{code}:{}),exitCode,signal,runtime:process.version,sandbox:"macos-seatbelt-v1",
        ...(result||{}),diagnostic,evidenceHash:hash(JSON.stringify({exitCode,code,report,diagnostic}))});
    });
    child.stdin.end(JSON.stringify({snapshotRoot,scratch,files,dependencyPaths:dependencies?[dependencies.link,dependencies.root]:[]}));
  });
  }finally{fs.rmSync(hostRoot,{recursive:true,force:true});}
}
module.exports={executeNodeTests,sandboxProfile};
