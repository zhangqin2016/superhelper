"use strict";
const fs=require("node:fs");
const path=require("node:path");
const {createHash}=require("node:crypto");
const execute=require("node:util").promisify(require("node:child_process").execFile);
const {resolveVenvPython,getBundledPythonEnv}=require("../runtime-python");
const OFFICE_POLICY="office-parts-v2";
const OFFICE_EXTENSIONS=new Set([".docx",".docm",".xlsx",".xlsm",".pptx",".pptm"]);
const script=name=>[process.resourcesPath&&path.join(process.resourcesPath,"resources/runtime-scripts",name),
  path.resolve(__dirname,"../../../resources/runtime-scripts",name)].filter(Boolean).find(file=>fs.existsSync(file))||null;
function officeEnvironment(){
  const env={...getBundledPythonEnv()};
  try{Object.assign(env,require("../runtime-python").getRuntimeEnvExtras());}catch{/* plain Node hosts keep the bundled Python env only */}
  return env;
}
const sofficeAvailable=env=>{
  const program=env.LILY_LIBREOFFICE_PROGRAM;
  return Boolean(program&&["soffice","soffice.exe","soffice.bin"].some(name=>fs.existsSync(path.join(program,name))));
};

/** Inputs/output stay in the caller's private scratch directory. A missing
 * runtime or unsupported package is a conflict, never a successful text merge.
 * When the bundled LibreOffice is available the merged package must also
 * render to at least one page before it is accepted; a package the office
 * suite cannot open is reported as unsupported, not delivered. */
async function mergeOffice(base,local,shared,scratch,{python=resolveVenvPython(),env=null,extension=".docx",render="auto",timeoutMs=60000}={}){
  const suffix=String(extension||"").toLowerCase();
  if(!python||!OFFICE_EXTENSIONS.has(suffix))return {state:"unsupported",reason:"runtime_or_format"};
  const merger=script("merge_office.py"),renderer=script("render_document.py");
  if(!merger)return {state:"unsupported",reason:"script_missing"};
  const environment=env||officeEnvironment();
  const root=fs.mkdtempSync(path.join(scratch,"office-"));
  try{
    const inputs=[base,local,shared].map((bytes,index)=>{
      const name=path.join(root,String(index));fs.writeFileSync(name,bytes,{flag:"wx",mode:0o600});return name;
    });
    const output=path.join(root,`output${suffix}`);
    const {stdout}=await execute(python,[merger,...inputs,output],{cwd:root,env:environment,timeout:timeoutMs,maxBuffer:65536,windowsHide:true});
    const result=JSON.parse(stdout);
    if(result.state!=="resolved")return result.state==="conflict"?{state:"conflict",reason:String(result.reason||"content").slice(0,64),part:typeof result.part==="string"?result.part.slice(0,300):null}:{state:"unsupported",reason:"merge"};
    const info=fs.lstatSync(output);
    if(!info.isFile()||info.nlink!==1||info.size>64*1024*1024||info.size!==result.sizeBytes)return {state:"unsupported",reason:"output"};
    const bytes=fs.readFileSync(output);
    if(createHash("sha256").update(bytes).digest("hex")!==result.sha256||result.policy!==OFFICE_POLICY)return {state:"unsupported",reason:"policy"};
    let rendered=null;
    if(render!=="never"&&renderer&&sofficeAvailable(environment)){
      const pages=path.join(root,"render");fs.mkdirSync(pages,{mode:0o700});
      try{
        const {stdout:renderOut}=await execute(python,[renderer,output,pages,"0.35"],{cwd:root,env:environment,timeout:Math.max(timeoutMs,180000),maxBuffer:65536,windowsHide:true});
        const report=JSON.parse(renderOut);
        if(report?.ok!==true||!Number.isInteger(report.pages)||report.pages<1)return {state:"unsupported",reason:"render_failed",detail:String(report?.error||"").slice(0,300)};
        rendered=report.pages;
      }catch(error){return {state:"unsupported",reason:"render_failed",detail:String(error?.message||error).slice(0,300)};}
    }else if(render==="require")return {state:"unsupported",reason:"render_unavailable"};
    return {state:"resolved",bytes,report:{policy:OFFICE_POLICY,format:result.format,changedParts:result.changedParts,mergedParts:result.mergedParts,
      cells:result.cells,paragraphs:result.paragraphs,recalculateOnLoad:result.recalculateOnLoad===true,metadataFromLocal:result.metadataFromLocal||[],renderedPages:rendered}};
  }catch(error){return {state:"unsupported",reason:"runtime",detail:String(error?.message||error).slice(0,300)};}
  finally{fs.rmSync(root,{recursive:true,force:true});}
}
module.exports={mergeOffice,OFFICE_EXTENSIONS,OFFICE_POLICY,officeEnvironment};
