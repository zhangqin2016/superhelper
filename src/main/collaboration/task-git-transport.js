"use strict";
const fs = require("node:fs");
const path = require("node:path");
const {createHash} = require("node:crypto");
const {pipeline} = require("node:stream/promises");
const {Transform} = require("node:stream");
const oid = value => typeof value === "string" && /^[0-9a-f]{40}$/.test(value);
const taskRef = value => typeof value === "string" && /^refs\/tasks\/[0-9a-f]{64}\/(baseline|deliveries\/[0-9a-f]{64})$/.test(value);
const sharedRef = value => typeof value === "string" && /^refs\/workspaces\/[0-9a-f]{64}\/candidates\/[0-9a-f]{64}$/.test(value);
const fail = code => Object.assign(new Error(`COLLAB_TASK_GIT_${code}`),{code:`COLLAB_TASK_GIT_${code}`});
const limit = 256 * 1024 * 1024;
function prerequisites(values) {
  if (!Array.isArray(values) || values.length > 256 || values.some(value=>!oid(value)) || new Set(values).size !== values.length) throw fail("DESCRIPTOR_INVALID");
  return [...values].sort();
}
function descriptor(value,validRef=taskRef) {
  if (!value || Object.keys(value).some(key=>!["version","format","ref","commit","prerequisites","sha256","sizeBytes"].includes(key))
    || value.version !== 1 || value.format !== "git-bundle-v2" || !validRef(value.ref) || !oid(value.commit)
    || typeof value.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(value.sha256)
    || !Number.isSafeInteger(value.sizeBytes) || value.sizeBytes < 1 || value.sizeBytes > limit) throw fail("DESCRIPTOR_INVALID");
  return {...value,prerequisites:prerequisites(value.prerequisites)};
}
function checkPath(file) {
  if (typeof file !== "string" || !path.isAbsolute(file) || path.resolve(file) !== file
    || fs.realpathSync(path.dirname(file)) !== path.dirname(file)) throw fail("UNSAFE_PATH");
}
async function copyVerified(source,destination) {
  checkPath(source);
  const before = fs.lstatSync(source);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > limit) throw fail("INTEGRITY");
  const fd = fs.openSync(source,fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  const digest = createHash("sha256"); let sizeBytes = 0;
  try {
    const opened = fs.fstatSync(fd);
    if (opened.dev !== before.dev || opened.ino !== before.ino) throw fail("INTEGRITY");
    await pipeline(fs.createReadStream(source,{fd,autoClose:false}),new Transform({transform(chunk,_encoding,callback) {
      sizeBytes += chunk.length;
      if (sizeBytes > limit) return callback(fail("INTEGRITY"));
      digest.update(chunk);callback(null,chunk);
    }}),fs.createWriteStream(destination,{flags:"wx",mode:0o600}));
    const after = fs.fstatSync(fd);
    if (sizeBytes !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) throw fail("INTEGRITY");
    return {sizeBytes,sha256:digest.digest("hex")};
  } finally {fs.closeSync(fd);}
}
function header(file) {
  const fd = fs.openSync(file,"r");
  try {
    const bytes = Buffer.alloc(65536), length = fs.readSync(fd,bytes,0,bytes.length,0);
    const end = bytes.subarray(0,length).indexOf("\n\n");
    if (end < 0) throw fail("DESCRIPTOR_INVALID");
    const lines = bytes.subarray(0,end).toString("utf8").split("\n");
    if (lines.shift() !== "# v2 git bundle") throw fail("DESCRIPTOR_INVALID");
    const required = [], heads = [];
    for (const line of lines) {
      if (/^-[0-9a-f]{40}(?: |$)/.test(line)) required.push(line.slice(1,41));
      else heads.push(line);
    }
    return {required:prerequisites(required),heads};
  } finally {fs.closeSync(fd);}
}

// Local Git plumbing only. Network callers must authorize the task and bind
// this descriptor to a verified encrypted object before passing it here.
function createTransport(taskGit,validRef) {
  return {
    async exportBundle({revision,prerequisites:known=[],destination}) {
      const {repository,git} = await taskGit.ensure();
      if (revision?.repository !== repository || !validRef(revision.ref) || !oid(revision.commit)
        || await git(["rev-parse","--verify",revision.ref]) !== revision.commit) throw fail("BASELINE_CONFLICT");
      const required = prerequisites(known);
      if (required.includes(revision.commit)) throw fail("NO_MISSING_OBJECTS");
      for (const commit of required) {
        try {await git(["merge-base","--is-ancestor",commit,revision.commit]);}
        catch {throw fail("PREREQUISITE");}
      }
      checkPath(destination);
      if (fs.existsSync(destination)) throw fail("DESTINATION_EXISTS");
      const temporary = fs.mkdtempSync(path.join(taskGit.rootPath,"export-"));
      try {
        const raw = path.join(temporary,"raw.bundle"), verified = path.join(temporary,"verified.bundle");
        await git(["bundle","create","--version=2",raw,revision.ref,...required.map(commit=>`^${commit}`)]);
        const metadata = await copyVerified(raw,verified), actual = header(verified);
        if (actual.heads.length !== 1 || actual.heads[0] !== `${revision.commit} ${revision.ref}`) throw fail("DESCRIPTOR_INVALID");
        for(const commit of actual.required){
          if(required.includes(commit))continue;
          // A shared merge can cross the excluded H boundary at its baseline
          // as well. Every such boundary must already be reachable from H.
          if(validRef!==sharedRef)throw fail("DESCRIPTOR_INVALID");
          let covered=false;for(const known of required){try{await git(["merge-base","--is-ancestor",commit,known]);covered=true;break;}catch{}}
          if(!covered)throw fail("DESCRIPTOR_INVALID");
        }
        // Exclusive creation preserves a caller's existing output on races.
        fs.copyFileSync(verified,destination,fs.constants.COPYFILE_EXCL);
        fs.chmodSync(destination,0o400);
        return {packagePath:destination,descriptor:{version:1,format:"git-bundle-v2",ref:revision.ref,commit:revision.commit,prerequisites:actual.required,...metadata}};
      } finally {fs.rmSync(temporary,{recursive:true,force:true});}
    },
    async importBundle({packagePath,descriptor:input}) {
      const info = descriptor(input,validRef), {repository,git} = await taskGit.ensure();
      const temporary = fs.mkdtempSync(path.join(taskGit.rootPath,"import-"));
      try {
        const verified = path.join(temporary,"verified.bundle"), actual = await copyVerified(packagePath,verified);
        if (actual.sha256 !== info.sha256 || actual.sizeBytes !== info.sizeBytes) throw fail("INTEGRITY");
        const parsed = header(verified);
        if (parsed.heads.length !== 1 || parsed.heads[0] !== `${info.commit} ${info.ref}`
          || JSON.stringify(parsed.required) !== JSON.stringify(info.prerequisites)) throw fail("DESCRIPTOR_INVALID");
        try {await git(["bundle","verify",verified]);} catch {throw fail("PREREQUISITE");}
        const current = await git(["show-ref","--verify","--hash",info.ref]).catch(error=>{
          if (error.code === 1 || error.code === 128) return null;throw error;
        });
        if (current && current !== info.commit) throw fail("TARGET_CONFLICT");
        await git(["-c","protocol.file.allow=always","fetch","--no-tags","--no-write-fetch-head","--no-auto-gc",verified,info.ref]);
        await git(["fsck","--strict","--no-reflogs","--no-dangling",info.commit]);
        try {await git(["update-ref",info.ref,info.commit,"0".repeat(40)]);}
        catch (error) {
          if (await git(["rev-parse","--verify",info.ref]) !== info.commit) throw fail("TARGET_CONFLICT");
        }
        return {repository,ref:info.ref,commit:info.commit};
      } finally {fs.rmSync(temporary,{recursive:true,force:true});}
    },
  };
}
const createTaskGitTransport=taskGit=>createTransport(taskGit,taskRef);
const createSharedGitTransport=taskGit=>createTransport(taskGit,sharedRef);
module.exports = {createTaskGitTransport,createSharedGitTransport,parseGitDescriptor:value=>descriptor(value),parseSharedGitDescriptor:value=>descriptor(value,sharedRef)};
