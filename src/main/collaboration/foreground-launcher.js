"use strict";
const {spawn}=require("node:child_process");
const {createForegroundWriter}=require("./foreground-writer");
const chunks=[];let size=0;
let launched=false,finished=false;
// Engine wrappers have an owner IPC channel. Owner death must not hide a live
// engine behind an orphan wrapper; persistent jobs intentionally omit the channel.
process.on("disconnect",()=>{
  if(finished)return;
  if(!launched)process.exit(0);
  try{process.kill(-process.pid,"SIGTERM");}catch{}
  setTimeout(()=>{try{process.kill(-process.pid,"SIGKILL");}catch{}},2000);
});
process.stdin.on("data",bytes=>{size+=bytes.length;if(size>2*1024*1024)process.exit(125);chunks.push(bytes);});
process.stdin.on("end",async()=>{
  try{
    const spec=JSON.parse(Buffer.concat(chunks).toString("utf8"));
    const writer=createForegroundWriter({filePath:spec.filePath}),deadline=Date.now()+15000;
    for(;;){
      try{writer.registerCurrentGroup();break;}
      catch(error){if(error.code!=="COLLAB_TASK_APPLICATION_BUSY"||Date.now()>=deadline)throw error;await new Promise(resolve=>setTimeout(resolve,25));}
    }
    // Group TERM also reaches the command. Keep the leader observable until
    // that command exits, allowing the owner to confirm or force group shutdown.
    process.on("SIGTERM",()=>{});
    launched=true;
    const child=spawn(spec.command,spec.args,{cwd:spec.cwd,env:spec.env,shell:spec.shell,stdio:["ignore","inherit","inherit"],windowsHide:true});
    const finish=code=>{finished=true;process.exitCode=code;if(process.connected)process.disconnect();};
    child.on("error",()=>finish(127));
    child.on("exit",code=>finish(Number.isInteger(code)?code:1));
  }catch(error){process.stderr.write(`${error.code||"FOREGROUND_LAUNCH_FAILED"}\n`);finished=true;process.exitCode=125;if(process.connected)process.disconnect();}
});
