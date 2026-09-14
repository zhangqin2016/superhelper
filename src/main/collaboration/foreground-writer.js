"use strict";
const fs=require("node:fs");
const path=require("node:path");
const {randomUUID}=require("node:crypto");
const {spawn,execFileSync}=require("node:child_process");
const {createLocalWriter}=require("./local-writer");
const fail=code=>Object.assign(Error(`COLLAB_TASK_APPLICATION_${code}`),{code:`COLLAB_TASK_APPLICATION_${code}`});
function sync(directory){const fd=fs.openSync(directory,"r");try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}}
function createForegroundWriter(options={}){
  const writer=createLocalWriter(options),directory=path.join(path.dirname(writer.filePath),"foreground-groups");
  function root(){
    fs.mkdirSync(directory,{recursive:true,mode:0o700});
    if(fs.realpathSync(directory)!==directory||!fs.lstatSync(directory).isDirectory())throw fail("UNSAFE_PATH");
  }
  function registerCurrentGroup(){
    if(process.platform==="win32")throw fail("COORDINATION_UNAVAILABLE");
    return writer.run(()=>{
      root();
      const group=Number(execFileSync("ps",["-p",String(process.pid),"-o","pgid="],{encoding:"utf8",timeout:2000,stdio:["ignore","pipe","ignore"]}).trim());
      if(group!==process.pid||group<=1)throw fail("COORDINATION_UNAVAILABLE");
      // The filename is the entire record. A crash after creation cannot leave
      // an undecodable partial PID. Never remove it on leader exit: tools may live.
      const target=path.join(directory,`actor-${group}-${randomUUID()}`);
      const fd=fs.openSync(target,fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_WRONLY|fs.constants.O_NOFOLLOW,0o600);
      try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}sync(directory);
    });
  }
  function run(operation){
    if(process.platform==="win32")throw fail("COORDINATION_UNAVAILABLE");
    return writer.run(()=>{
      root();let removed=false;
      for(const name of fs.readdirSync(directory)){
        const match=/^actor-([1-9][0-9]*)-[a-f0-9-]{36}$/.exec(name),target=path.join(directory,name),stat=fs.lstatSync(target);
        const pid=Number(match?.[1]);
        if(!match||!Number.isSafeInteger(pid)||pid<=1||!stat.isFile()||stat.nlink!==1||stat.size!==0)throw fail("COORDINATION_UNAVAILABLE");
        try{process.kill(-pid,0);}catch(error){
          if(error.code!=="ESRCH")throw fail("BUSY");
          fs.unlinkSync(target);removed=true;continue;
        }
        throw fail("BUSY");
      }
      if(removed)sync(directory);
      return operation();
    });
  }
  return {run,registerCurrentGroup};
}

/** Detached wrapper registers its own group before spawning any workspace
 * command. Secrets/options travel on stdin, never in process-list arguments. */
function spawnForeground(command,args,options={},coordination={}){
  if(process.platform==="win32")return spawn(command,args,options);
  const stdio=options.stdio||["ignore","pipe","pipe"];
  const child=spawn(process.execPath,[path.join(__dirname,"foreground-launcher.js")],{
    cwd:options.cwd,env:{...process.env,ELECTRON_RUN_AS_NODE:"1"},detached:true,windowsHide:true,
    stdio:["pipe",stdio[1],stdio[2],...(coordination.parentBound?["ipc"]:[])],
  });
  child.stdin.on("error",()=>{});
  const start=()=>child.stdin.end(JSON.stringify({command,args,cwd:options.cwd,env:options.env||process.env,shell:options.shell||false,filePath:coordination.filePath}));
  if(coordination.deferLaunch)child.startForeground=()=>{delete child.startForeground;start();};
  else start();
  return child;
}
module.exports={createForegroundWriter,spawnForeground};
