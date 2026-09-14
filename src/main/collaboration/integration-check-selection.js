"use strict";
const fs=require("node:fs");
const path=require("node:path");
const {createHash}=require("node:crypto");
const fail=()=>Object.assign(Error("COLLAB_CHECK_POLICY_SOURCE_CHANGED"),{code:"COLLAB_CHECK_POLICY_SOURCE_CHANGED"});
function sourceIdentity(root){
  const stat=fs.lstatSync(root,{bigint:true});
  if(!stat.isDirectory()||stat.isSymbolicLink()||fs.realpathSync(root)!==root)throw fail();
  return createHash("sha256").update(JSON.stringify([String(stat.dev),String(stat.ino),String(stat.birthtimeNs)])).digest("hex");
}
function selectedChecks(root,filePaths){
  sourceIdentity(root);
  if(!Array.isArray(filePaths)||!filePaths.length||filePaths.length>32)throw fail();
  const paths=[],hashes=Object.create(null);let total=0;
  for(const file of filePaths){
    if(typeof file!=="string"||!path.isAbsolute(file)||path.resolve(file)!==file||fs.realpathSync(file)!==file)throw fail();
    const relative=path.relative(root,file).split(path.sep).join("/");
    if(relative.startsWith("../")||path.isAbsolute(relative)||!relative||Object.hasOwn(hashes,relative))throw fail();
    const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
    try{
      const stat=fs.fstatSync(fd);
      if(!stat.isFile()||stat.nlink!==1||stat.size>128*1024 || (total+=stat.size)>1024*1024)throw fail();
      const bytes=Buffer.alloc(stat.size);let offset=0;
      while(offset<bytes.length){const count=fs.readSync(fd,bytes,offset,bytes.length-offset,offset);if(!count)throw fail();offset+=count;}
      hashes[relative]=createHash("sha256").update(bytes).digest("hex");paths.push(relative);
    }finally{fs.closeSync(fd);}
  }
  return {paths,hashes};
}
function chooseChecks(dialog,window,sourceRoot){
  let locale="en";try{locale=require("../locale-settings").getLocale();}catch{}
  const title={en:"Select trusted Node tests for automatic validation", "zh-CN":"选择可信的 Node 测试用于自动验证",ar:"اختر اختبارات Node الموثوقة للتحقق التلقائي"}[locale]||"Select trusted Node tests for automatic validation";
  return dialog.showOpenDialog(window,{title,defaultPath:sourceRoot,properties:["openFile","multiSelections"],filters:[{name:"Node tests",extensions:["cjs","mjs","js"]}]});
}
module.exports={sourceIdentity,selectedChecks,chooseChecks};
