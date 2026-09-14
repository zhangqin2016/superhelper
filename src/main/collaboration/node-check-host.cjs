"use strict";
// Trusted parent: candidate output is a test:stdout event, never a result.
const fs=require("node:fs"),path=require("node:path"),{run}=require("node:test");
const input=JSON.parse(fs.readFileSync(0,"utf8")),abort=new AbortController();
// Do not propagate caller V8 flags; children receive the limits below.
process.execArgv=[];
const perFile=[],failures=[],logs=[];let summary=null,bytes=0,events=0,limited=false,limitReason=null;
const stream=run({files:input.files,concurrency:1,isolation:"process",signal:abort.signal,timeout:20000,
  execArgv:["--permission",`--allow-fs-read=${input.snapshotRoot}`,`--allow-fs-read=${input.scratch}`,`--allow-fs-write=${input.scratch}`,"--max-old-space-size=128"]});
// Inspect writable scratch inside the OS sandbox, never in the unrestricted
// main process. A concurrent path replacement cannot expose private files.
function checkScratch(){
  let entries=0,size=0;
  const inspect=root=>{
    const dir=fs.opendirSync(root);try{
      let entry;while((entry=dir.readSync())){
        if(++entries>256)throw Error('scratch entries');
        const target=path.join(root,entry.name);let stat;
        try{stat=fs.lstatSync(target);}catch(error){if(error.code==='ENOENT')continue;throw error;}
        if(stat.isDirectory())inspect(target);
        else if(!stat.isFile()||stat.nlink!==1)throw Error('scratch type');
        else if((size+=stat.size)>16*1024*1024)throw Error('scratch size');
      }
    }finally{dir.closeSync();}
  };
  try{inspect(input.scratch);}catch{limited=true;limitReason='SCRATCH_LIMIT';abort.abort();}
}
const scratchGuard=setInterval(checkScratch,50);scratchGuard.unref();
stream.on("data",event=>{
  if(++events>10000){limited=true;abort.abort();return;}
  const data=event.data;
  if(event.type==="test:summary"){
    const value={success:data.success,counts:data.counts,...(data.file?{file:data.file}:{})};
    if(data.file)perFile.push(value);else summary=value;
  }
  if(event.type==="test:fail"&&failures.length<32)failures.push({name:String(data.name).slice(0,200),file:data.file,
    message:String(data.details?.error?.message||"Test failed").slice(0,2000)});
  if(["test:stdout","test:stderr"].includes(event.type)){
    const message=String(data.message);bytes+=Buffer.byteLength(message);
    if(bytes>1024*1024){limited=true;abort.abort();return;}
    if(logs.length<16)logs.push(message.slice(0,2000));
  }
});
stream.on("error",()=>{limited=true;});
stream.on("end",()=>{
  clearInterval(scratchGuard);
  checkScratch();
  const report=fs.createWriteStream(null,{fd:3});
  report.on('error',()=>{process.exitCode=1;});
  report.end(JSON.stringify({version:1,summary,perFile,failures,logs,limited,limitReason,outputBytes:bytes,events}));
});
