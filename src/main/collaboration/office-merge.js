"use strict";
const fs=require("node:fs");
const path=require("node:path");
const {createHash}=require("node:crypto");
const execute=require("node:util").promisify(require("node:child_process").execFile);
const {resolveVenvPython,getBundledPythonEnv}=require("../runtime-python");

/** Inputs/output stay in the caller's private scratch directory. A missing
 * runtime or unsupported package is a conflict, never a successful text merge. */
async function mergeOffice(base,local,shared,scratch,{python=resolveVenvPython(),env=getBundledPythonEnv()}={}){
  if(!python)return {state:"unsupported"};
  const script=[process.resourcesPath&&path.join(process.resourcesPath,"resources/runtime-scripts/merge_office.py"),
    path.resolve(__dirname,"../../../resources/runtime-scripts/merge_office.py")].filter(Boolean).find(name=>fs.existsSync(name));
  if(!script)return {state:"unsupported"};
  const root=fs.mkdtempSync(path.join(scratch,"office-"));
  try{
    const inputs=[base,local,shared].map((bytes,index)=>{
      const name=path.join(root,String(index));fs.writeFileSync(name,bytes,{flag:"wx",mode:0o600});return name;
    });
    const output=path.join(root,"output.docx");
    const {stdout}=await execute(python,[script,...inputs,output],{cwd:root,env,timeout:30000,maxBuffer:16384,windowsHide:true});
    const result=JSON.parse(stdout);
    if(result.state!=="resolved")return {state:result.state==="conflict"?"conflict":"unsupported"};
    const info=fs.lstatSync(output);
    if(!info.isFile()||info.nlink!==1||info.size>64*1024*1024||info.size!==result.sizeBytes)return {state:"unsupported"};
    const bytes=fs.readFileSync(output);
    if(createHash("sha256").update(bytes).digest("hex")!==result.sha256||result.policy!=="docx-parts-v1")return {state:"unsupported"};
    return {state:"resolved",bytes};
  }catch{return {state:"unsupported"};}
  finally{fs.rmSync(root,{recursive:true,force:true});}
}
module.exports={mergeOffice};
