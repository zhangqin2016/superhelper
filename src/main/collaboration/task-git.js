"use strict";
const fs = require("node:fs");
const path = require("node:path");
const jsonFile = require("../json-file");
const {createHash} = require("node:crypto");
const {execFile,spawn} = require("node:child_process");
const {promisify} = require("node:util");
const {pipeline} = require("node:stream/promises");
const {Transform} = require("node:stream");
const {WorkspaceGit} = require("../workspace-git");
const {manifestMap} = require("./task-apply-plan");
const {controlPath} = require("./task-bundle");
const {taskChangeset,manifestHash} = require("./task-changeset");
const {taskFileIdentity} = require("./task-file-identity");
const {collaborationLimits,assertCapacity} = require("./resource-policy");
const execute = promisify(execFile);
const fail = code => Object.assign(new Error(`COLLAB_TASK_GIT_${code}`),{code:`COLLAB_TASK_GIT_${code}`});
const identity = stat => `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
function directory(root) {
  if (!path.isAbsolute(root) || path.resolve(root) !== root || fs.realpathSync(root) !== root || !fs.lstatSync(root).isDirectory()) throw fail("UNSAFE_PATH");
}

// The resolver is shared with private workspace versioning; repository, index,
// configuration and refs are deliberately independent of that version vault.
class TaskGit {
  constructor({rootPath,gitOptions,limits,capacityProbe} = {}) {
    this.rootPath = rootPath;
    this.git = new WorkspaceGit(gitOptions);
    this.ready = null;
    this.limits = limits || collaborationLimits();
    this.capacityProbe = capacityProbe;
  }
  capacity(root,bytes) {return assertCapacity({root,bytes,limits:this.limits,...(this.capacityProbe?{probe:this.capacityProbe}:{})});}
  async ensure() {
    if (!this.ready) this.ready = this.initialize().catch(error=>{this.ready=null;throw error;});
    return this.ready;
  }
  async initialize() {
    if (typeof this.rootPath !== "string" || !path.isAbsolute(this.rootPath) || path.resolve(this.rootPath) !== this.rootPath) throw fail("UNSAFE_PATH");
    fs.mkdirSync(this.rootPath,{recursive:true,mode:0o700});
    directory(this.rootPath);
    const runtime = await this.git.runtime();
    // Inherited Git variables can redirect writes to a caller's private repo,
    // object alternates or index. Use only the resolved runtime's Git settings.
    const env = Object.fromEntries(Object.entries(process.env).filter(([key])=>!key.startsWith("GIT_")));
    Object.assign(env,runtime.env,{
      PATH:[...runtime.pathEntries,process.env.PATH || ""].join(path.delimiter),
      GIT_CONFIG_NOSYSTEM:"1",GIT_CONFIG_GLOBAL:process.platform === "win32" ? "NUL" : "/dev/null",
      GIT_TERMINAL_PROMPT:"0",GIT_AUTHOR_NAME:"Lily Workbench",GIT_AUTHOR_EMAIL:"tasks@local.invalid",
      GIT_COMMITTER_NAME:"Lily Workbench",GIT_COMMITTER_EMAIL:"tasks@local.invalid",
      GIT_AUTHOR_DATE:"2000-01-01T00:00:00Z",GIT_COMMITTER_DATE:"2000-01-01T00:00:00Z",
    });
    const repository = path.join(this.rootPath,"tasks.git");
    const run = async (args,extra={},input) => {
      const pending=execute(runtime.executable,["-c","core.hooksPath=" ,"-c","commit.gpgsign=false",...args],
        {cwd:this.rootPath,env:{...env,...extra},encoding:"utf8",timeout:120000,maxBuffer:1024*1024,windowsHide:true});
      pending.child.stdin.on("error",()=>{}); // Process exit supplies the command error.
      pending.child.stdin.end(input);
      return (await pending).stdout.trim();
    };
    if (!fs.existsSync(repository)) await run(["init","--bare","--template=","--object-format=sha1",repository]);
    directory(repository);
    const git = (args,extra,input)=>run(["--git-dir",repository,...args],extra,input);
    if (await git(["rev-parse","--is-bare-repository"]) !== "true" || fs.existsSync(path.join(repository,"objects","info","alternates"))) throw fail("REPOSITORY_INVALID");
    // NUL-delimited streaming over a single process: tree listings are bounded
    // by the record count and file limits, never by a stdout buffer.
    const stream = async (args,onRecord,maxRecords) => {
      const child = spawn(runtime.executable,["--git-dir",repository,...args],{cwd:this.rootPath,env,stdio:["ignore","pipe","pipe"],windowsHide:true});
      child.stderr.resume();
      let pending = "",count = 0;
      const exit = new Promise((resolve,reject)=>{child.once("error",reject);child.once("close",code=>code===0?resolve():reject(fail("OBJECT_READ_FAILED")));});
      try {
        child.stdout.setEncoding("utf8");
        for await (const chunk of child.stdout) {
          pending += chunk;
          let index;
          while ((index = pending.indexOf("\0")) >= 0) {
            const record = pending.slice(0,index); pending = pending.slice(index+1);
            if (++count > maxRecords) throw fail("LIMIT_EXCEEDED");
            onRecord(record);
          }
          if (pending.length > 1024*1024) throw fail("TREE_INVALID");
        }
        if (pending) {if (++count > maxRecords) throw fail("LIMIT_EXCEEDED"); onRecord(pending);}
        await exit;
      } finally {if (child.exitCode === null) child.kill();}
    };
    // One `cat-file --batch` process serves a whole materialization: each blob
    // is streamed straight to its destination with a running hash and a size
    // guard, so memory stays bounded and no per-file process is spawned.
    const openBlobReader = () => {
      const child = spawn(runtime.executable,["--git-dir",repository,"cat-file","--batch"],{cwd:this.rootPath,env,stdio:["pipe","pipe","pipe"],windowsHide:true});
      child.stderr.resume(); child.stdin.on("error",()=>{});
      const chunks = []; let waiting = null, closed = false, failure = null;
      child.stdout.on("data",chunk=>{chunks.push(chunk); waiting?.();});
      child.on("close",()=>{closed = true; waiting?.();});
      child.on("error",error=>{failure = error; closed = true; waiting?.();});
      const next = async () => {
        while (!chunks.length) {
          if (failure) throw fail("OBJECT_READ_FAILED");
          if (closed) throw fail("OBJECT_READ_FAILED");
          await new Promise(resolve=>{waiting = resolve;}); waiting = null;
        }
        return chunks.shift();
      };
      let buffer = Buffer.alloc(0);
      const take = async (length) => {
        while (buffer.length < length) buffer = Buffer.concat([buffer,await next()]);
        const value = buffer.subarray(0,length); buffer = buffer.subarray(length); return value;
      };
      const line = async () => {
        for (;;) {
          const index = buffer.indexOf(10);
          if (index >= 0) {const value = buffer.subarray(0,index).toString("utf8"); buffer = buffer.subarray(index+1); return value;}
          if (buffer.length > 256) throw fail("OBJECT_READ_FAILED");
          buffer = Buffer.concat([buffer,await next()]);
        }
      };
      return {
        async write(blob,destination,file) {
          if (!/^[0-9a-f]{40}$/.test(blob)) throw fail("OBJECT_READ_FAILED");
          child.stdin.write(`${blob}\n`);
          const header = /^([0-9a-f]{40}) blob ([0-9]+)$/.exec(await line());
          if (!header || header[1] !== blob) throw fail("OBJECT_READ_FAILED");
          const size = Number(header[2]);
          if (size !== file.sizeBytes) throw fail("SNAPSHOT_CHANGED");
          const fd = fs.openSync(destination,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,0o600);
          const digest = createHash("sha256"); let remaining = size;
          try {
            while (remaining > 0) {
              if (!buffer.length) buffer = await next();
              const piece = buffer.subarray(0,Math.min(remaining,buffer.length)); buffer = buffer.subarray(piece.length);
              digest.update(piece); fs.writeSync(fd,piece); remaining -= piece.length;
            }
          } finally {fs.closeSync(fd);}
          if ((await take(1))[0] !== 10) throw fail("OBJECT_READ_FAILED");
          const sha256 = digest.digest("hex");
          if (file.sha256 && sha256 !== file.sha256) throw fail("SNAPSHOT_CHANGED");
          return {sha256,sizeBytes:size};
        },
        close() {try {child.stdin.end();} catch {} if (child.exitCode === null) setTimeout(()=>{if (child.exitCode === null) child.kill();},2000).unref();},
      };
    };
    const writeBlob = async (blob,destination,file) => {
      const child = spawn(runtime.executable,["--git-dir",repository,"cat-file","blob",blob],{cwd:this.rootPath,env,stdio:["ignore","pipe","pipe"],windowsHide:true});
      child.stderr.resume();
      const finished = new Promise((resolve,reject)=>{
        child.once("error",reject);
        child.once("close",code=>code === 0 ? resolve() : reject(fail("OBJECT_READ_FAILED")));
      });
      const digest = createHash("sha256"); let size = 0;
      try {
        await Promise.all([finished,pipeline(child.stdout,new Transform({transform(chunk,_encoding,callback) {
          size += chunk.length;
          if (size > file.sizeBytes) return callback(fail("SNAPSHOT_CHANGED"));
          digest.update(chunk); callback(null,chunk);
        }}),fs.createWriteStream(destination,{flags:"wx",mode:0o600}))]);
        const sha256 = digest.digest("hex");
        if (size !== file.sizeBytes || file.sha256 && sha256 !== file.sha256) throw fail("SNAPSHOT_CHANGED");
        return {sha256,sizeBytes:size};
      } finally {if (child.exitCode === null) child.kill();}
    };
    return {repository,git,writeBlob,stream,openBlobReader};
  }
  async hasRevision(revision) {
    if (!/^[0-9a-f]{40}$/.test(revision?.commit || "") || !/^refs\/(tasks\/[0-9a-f]{64}\/(baseline|deliveries\/[0-9a-f]{64})|workspaces\/[0-9a-f]{64}\/(head|candidates\/[0-9a-f]{64}))$/.test(revision?.ref || "")) return false;
    const {git} = await this.ensure();
    try {
      if (await git(["rev-parse","--verify",revision.ref]) !== revision.commit) return false;
      await git(["fsck","--strict","--no-reflogs","--no-dangling",revision.commit]);
      return true;
    } catch {return false;}
  }
  async inspectTree(commit) {
    if (!/^[0-9a-f]{40}$/.test(commit || "")) throw fail("REVISION_UNAVAILABLE");
    const {stream}=await this.ensure();
    const entries = [], limits = this.limits; let total = 0;
    await stream(["ls-tree","-r","-l","-z",commit],value=>{
      if (!value) return;
      const match = /^100644 blob ([0-9a-f]{40}) +([0-9]+)\t(.+)$/.exec(value);
      if (!match || controlPath(match[3])) throw fail("TREE_INVALID");
      const sizeBytes = Number(match[2]); total += sizeBytes;
      if (sizeBytes > limits.maxFileBytes || total > limits.maxTotalBytes) throw fail("LIMIT_EXCEEDED");
      entries.push({blob:match[1],path:match[3],sizeBytes});
    },limits.maxFiles);
    manifestMap(entries.map(file=>({path:file.path,sha256:"0".repeat(64),sizeBytes:file.sizeBytes})));
    return entries;
  }
  async materializeSnapshot({revision,destinationRoot,parentCommit,parents}) {
    if (!(await this.hasRevision(revision))) throw fail("REVISION_UNAVAILABLE");
    const {repository,git,openBlobReader} = await this.ensure();
    const expected=parents===undefined?(parentCommit?[parentCommit]:[]):parents;
    if (!Array.isArray(expected) || expected.length>2 || expected.some(value=>!/^[0-9a-f]{40}$/.test(value)) || parents!==undefined && parentCommit) throw fail("ANCESTRY_INVALID");
    const lineage = (await git(["rev-list","--parents","-n","1",revision.commit])).split(" ").slice(1);
    if (JSON.stringify(lineage)!==JSON.stringify(expected)) throw fail("ANCESTRY_INVALID");
    const entries=await this.inspectTree(revision.commit);
    if (typeof destinationRoot !== "string" || !path.isAbsolute(destinationRoot) || path.resolve(destinationRoot)!==destinationRoot
      || destinationRoot===this.rootPath || destinationRoot.startsWith(`${this.rootPath}${path.sep}`)
      || this.rootPath.startsWith(`${destinationRoot}${path.sep}`)) throw fail("UNSAFE_PATH");
    directory(path.dirname(destinationRoot));
    fs.mkdirSync(destinationRoot,{mode:0o700});
    this.capacity(destinationRoot,entries.reduce((sum,file)=>sum+file.sizeBytes,0));
    const snapshotRoot=path.join(destinationRoot,"snapshot");fs.mkdirSync(snapshotRoot,{mode:0o700});
    const manifest=[], reader=openBlobReader();
    try {
      for (const file of entries) {
        const destination=path.join(snapshotRoot,file.path);
        fs.mkdirSync(path.dirname(destination),{recursive:true,mode:0o700});
        const content=await reader.write(file.blob,destination,file);
        fs.chmodSync(destination,0o400);manifest.push({path:file.path,...content});
      }
    } finally {reader.close();}
    return {snapshotRoot,manifest,gitRevision:{repository,ref:revision.ref,commit:revision.commit,
      tree:await git(["rev-parse",`${revision.commit}^{tree}`]),manifestHash:manifestHash(manifest)}};
  }
  async ensureWorktree({baseline,workRoot,manifest,materializePaths=null}) {
    const files = manifestMap(manifest);
    const {repository,git,stream,openBlobReader} = await this.ensure();
    const selected = materializePaths===null?null:new Set(materializePaths);
    if (selected && [...selected].some(name=>files.get(String(name).toLowerCase())?.path!==name)) throw fail("INVENTORY_INVALID");
    if (baseline?.repository !== repository || !/^[0-9a-f]{40}$/.test(baseline.commit || "")
      || !/^refs\/tasks\/[0-9a-f]{64}\/baseline$/.test(baseline.ref || "")
      || await git(["rev-parse","--verify",baseline.ref]) !== baseline.commit) throw fail("BASELINE_CONFLICT");
    if (typeof workRoot !== "string" || !path.isAbsolute(workRoot) || path.resolve(workRoot) !== workRoot
      || workRoot === this.rootPath || workRoot.startsWith(`${this.rootPath}${path.sep}`)
      || this.rootPath.startsWith(`${workRoot}${path.sep}`)) throw fail("UNSAFE_PATH");
    directory(path.dirname(workRoot));
    const metadata = () => {
      directory(workRoot);
      const link = path.join(workRoot,".git");
      const stat = fs.lstatSync(link);
      if (!stat.isFile() || stat.nlink !== 1) throw fail("UNSAFE_PATH");
      const value = fs.readFileSync(link,"utf8").trim();
      if (!value.startsWith("gitdir: ")) throw fail("WORKTREE_CONFLICT");
      const target = value.slice(8);
      if (path.dirname(target) !== path.join(repository,"worktrees")) throw fail("WORKTREE_CONFLICT");
      directory(target);
      if (fs.readFileSync(path.join(target,"gitdir"),"utf8").trim() !== link) throw fail("WORKTREE_CONFLICT");
      return target;
    };
    if (fs.existsSync(workRoot)) {
      const marker = path.join(metadata(),"lily-task.json");
      if (!fs.existsSync(marker)) throw fail("WORKTREE_INCOMPLETE");
      const saved = JSON.parse(fs.readFileSync(marker,"utf8")), stat = fs.statSync(workRoot);
      if (saved.commit !== baseline.commit || saved.ref !== baseline.ref || saved.workRoot !== workRoot
        || saved.dev !== stat.dev || saved.ino !== stat.ino) throw fail("WORKTREE_CONFLICT");
      return {workRoot,fileIdentities:saved.fileIdentities || [],materializedPaths:saved.materializedPaths || (saved.fileIdentities || []).map(file=>file.path)};
    }
    const entries = [];
    await stream(["ls-tree","-r","-z",baseline.commit],value=>{
      if (!value) return;
      const match = /^(100644) blob ([0-9a-f]{40})\t(.+)$/.exec(value);
      if (!match) throw fail("TREE_INVALID");
      const file = files.get(match[3].toLowerCase());
      if (!file || file.path !== match[3] || controlPath(file.path)) throw fail("TREE_INVALID");
      entries.push({blob:match[2],file});
    },this.limits.maxFiles);
    if (entries.length !== files.size) throw fail("TREE_INVALID");
    // The inventory is complete in the index; only the selected paths become
    // real files. Absent paths are online-only entries, never placeholders.
    const chosen = selected ? entries.filter(({file})=>selected.has(file.path)) : entries;
    this.capacity(path.dirname(workRoot),chosen.reduce((sum,{file})=>sum+file.sizeBytes,0));
    await git(["worktree","add","--detach","--no-checkout",workRoot,baseline.commit]);
    const target = metadata();
    await git(["--git-dir",target,"read-tree",baseline.commit]);
    const reader = openBlobReader();
    try {
      for (const {blob,file} of chosen) {
        const destination = path.join(workRoot,file.path);
        fs.mkdirSync(path.dirname(destination),{recursive:true,mode:0o700});
        await reader.write(blob,destination,file);
      }
    } finally {reader.close();}
    const fileIdentities = chosen.map(({file})=>({path:file.path,identity:taskFileIdentity(fs.lstatSync(path.join(workRoot,file.path),{bigint:true}))})).filter(file=>file.identity);
    const materializedPaths = chosen.map(({file})=>file.path);
    const stat = fs.statSync(workRoot);
    jsonFile.writeJsonExclusive(path.join(target,"lily-task.json"),{commit:baseline.commit,ref:baseline.ref,workRoot,dev:stat.dev,ino:stat.ino,fileIdentities,materializedPaths},{indent:0,mode:0o600,createDir:false});
    return {workRoot,fileIdentities,materializedPaths};
  }
  /** Bring more online-only inventory entries onto disk in an existing task
   * worktree. Paths already present must match the baseline bytes exactly;
   * anything else is a conflict, and the worktree marker records the result. */
  async materializePaths({baseline,workRoot,manifest,paths}) {
    const files = manifestMap(manifest);
    if (!Array.isArray(paths) || paths.some(name=>files.get(String(name).toLowerCase())?.path!==name)) throw fail("INVENTORY_INVALID");
    const {repository,git,stream,openBlobReader} = await this.ensure();
    if (baseline?.repository !== repository || await git(["rev-parse","--verify",baseline.ref]) !== baseline.commit) throw fail("BASELINE_CONFLICT");
    directory(workRoot);
    const link = path.join(workRoot,".git"), target = fs.readFileSync(link,"utf8").trim().slice(8);
    if (path.dirname(target) !== path.join(repository,"worktrees")) throw fail("WORKTREE_CONFLICT");
    const marker = path.join(target,"lily-task.json"), saved = JSON.parse(fs.readFileSync(marker,"utf8"));
    if (saved.commit !== baseline.commit || saved.workRoot !== workRoot) throw fail("WORKTREE_CONFLICT");
    const have = new Set(saved.materializedPaths || (saved.fileIdentities || []).map(file=>file.path));
    const wanted = new Set(paths.filter(name=>!have.has(name)));
    const entries = [];
    await stream(["ls-tree","-r","-z",baseline.commit],value=>{
      const match = /^(100644) blob ([0-9a-f]{40})\t(.+)$/.exec(value || "");
      if (match && wanted.has(match[3])) entries.push({blob:match[2],file:files.get(match[3].toLowerCase())});
    },this.limits.maxFiles);
    if (entries.length !== wanted.size) throw fail("TREE_INVALID");
    this.capacity(workRoot,entries.reduce((sum,{file})=>sum+file.sizeBytes,0));
    const reader = openBlobReader();
    try {
      for (const {blob,file} of entries) {
        const destination = path.join(workRoot,file.path);
        if (fs.existsSync(destination)) throw fail("MATERIALIZE_CONFLICT");
        fs.mkdirSync(path.dirname(destination),{recursive:true,mode:0o700});
        await reader.write(blob,destination,file);
      }
    } finally {reader.close();}
    const added = entries.map(({file})=>({path:file.path,identity:taskFileIdentity(fs.lstatSync(path.join(workRoot,file.path),{bigint:true}))})).filter(file=>file.identity);
    const fileIdentities = [...(saved.fileIdentities || []),...added], materializedPaths = [...have,...entries.map(({file})=>file.path)];
    // The one atomic writer: a random temp name, and the app-wide transient-lock
    // retry a bare rename would not get on Windows.
    jsonFile.writeJson(marker,{...saved,fileIdentities,materializedPaths},{indent:0,mode:0o600,createDir:false});
    return {workRoot,fileIdentities,materializedPaths,added:entries.map(({file})=>file.path)};
  }
  async captureBaseline({taskId,snapshotRoot,manifest}) {
    if (typeof taskId !== "string" || !taskId || taskId.length > 512) throw fail("TASK_INVALID");
    const key = createHash("sha256").update(taskId).digest("hex");
    return {...await this._capture({snapshotRoot,manifest,ref:`refs/tasks/${key}/baseline`,message:"Task baseline",conflict:"BASELINE_CONFLICT"}),manifestHash:manifestHash(manifest)};
  }
  async captureContribution({baseline,baseManifest,materializedPaths,deliveryId,snapshotRoot,manifest,baseFileIdentities,fileIdentities}) {
    const {repository,git} = await this.ensure();
    if (baseline?.repository !== repository || baseline.manifestHash !== manifestHash(baseManifest)
      || !/^[0-9a-f]{40}$/.test(baseline.commit || "") || !/^refs\/tasks\/[0-9a-f]{64}\/baseline$/.test(baseline.ref || "")
      || await git(["rev-parse","--verify",baseline.ref]) !== baseline.commit) throw fail("BASELINE_CONFLICT");
    if (typeof deliveryId !== "string" || !deliveryId || deliveryId.length > 512) throw fail("DELIVERY_INVALID");
    const changes = taskChangeset({baseManifest,manifest,materializedPaths,baseFileIdentities,fileIdentities});
    const key = createHash("sha256").update(deliveryId).digest("hex");
    const ref = baseline.ref.replace(/baseline$/,`deliveries/${key}`);
    const result = await this._capture({snapshotRoot,manifest:changes.files,parent:baseline.commit,removed:changes.removed,
      ref,message:`Task contribution\n\n${JSON.stringify({version:1,operations:changes.operations})}`,conflict:"CONTRIBUTION_CONFLICT"});
    return {...result,baseCommit:baseline.commit,operations:changes.operations};
  }
  async _capture({snapshotRoot,manifest,parent,removed=[],ref,message,conflict}) {
    const files = [...manifestMap(manifest).values()].sort((a,b)=>a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
    if (files.some(file=>controlPath(file.path))) throw fail("CONTROL_FILE");
    directory(snapshotRoot);
    // A source tree must never contain the collaboration object database.
    if (this.rootPath === snapshotRoot || this.rootPath.startsWith(`${snapshotRoot}${path.sep}`)
      || snapshotRoot.startsWith(`${this.rootPath}${path.sep}`)) throw fail("ROOT_OVERLAP");
    const {repository,git} = await this.ensure();
    const temporary = fs.mkdtempSync(path.join(this.rootPath,"capture-"));
    const indexEnv = {GIT_INDEX_FILE:path.join(temporary,"index"),GIT_WORK_TREE:temporary};
    try {
      await git(parent ? ["read-tree",parent] : ["read-tree","--empty"],indexEnv);
      if (removed.length) await git(["update-index","-z","--force-remove","--stdin"],indexEnv,removed.map(relative=>`${relative}\0`).join(""));
      // Files are captured in bounded batches: one hash-object process writes
      // a batch of frozen copies and one update-index call records them, so a
      // large tree costs two processes per batch instead of two per file.
      let batch = [];
      const flush = async () => {
        if (!batch.length) return;
        const blobs = (await git(["hash-object","-w","--no-filters","--stdin-paths"],undefined,batch.map(item=>`${item.captured}\n`).join(""))).split("\n").filter(Boolean);
        if (blobs.length !== batch.length || blobs.some(blob=>!/^[0-9a-f]{40}$/.test(blob))) throw fail("SNAPSHOT_CHANGED");
        await git(["update-index","-z","--add","--index-info"],indexEnv,batch.map((item,index)=>`100644 ${blobs[index]}\t${item.path}\0`).join(""));
        for (const item of batch) fs.unlinkSync(item.captured);
        batch = [];
      };
      for (const [index,file] of files.entries()) {
        const source = path.join(snapshotRoot,file.path);
        let current = snapshotRoot;
        for (const part of file.path.split("/")) {
          current = path.join(current,part);
          if (fs.lstatSync(current).isSymbolicLink()) throw fail("UNSAFE_PATH");
        }
        if (fs.realpathSync(source) !== source) throw fail("UNSAFE_PATH");
        const before = fs.lstatSync(source);
        if (!before.isFile() || before.nlink !== 1) throw fail("UNSAFE_PATH");
        const fd = fs.openSync(source,fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
        const captured = path.join(temporary,`blob-${index}`);
        const digest = createHash("sha256"); let size = 0;
        try {
          if (identity(fs.fstatSync(fd)) !== identity(before)) throw fail("SNAPSHOT_CHANGED");
          // Small files take the synchronous path: stream pipelines cost more
          // than the copy for the tens of thousands of tiny files a tree holds.
          if (before.size <= 1024*1024) {
            const bytes = fs.readFileSync(fd); size = bytes.length; digest.update(bytes);
            fs.writeFileSync(captured,bytes,{flag:"wx",mode:0o600});
          } else await pipeline(fs.createReadStream(source,{fd,autoClose:false}),new Transform({transform(chunk,_encoding,callback) {
            size += chunk.length; digest.update(chunk); callback(null,chunk);
          }}),fs.createWriteStream(captured,{flags:"wx",mode:0o600}));
          if (size !== file.sizeBytes || digest.digest("hex") !== file.sha256
            || identity(fs.fstatSync(fd)) !== identity(before) || identity(fs.lstatSync(source)) !== identity(before)
            || fs.realpathSync(source) !== source) throw fail("SNAPSHOT_CHANGED");
        } finally {fs.closeSync(fd);}
        batch.push({captured,path:file.path});
        if (batch.length >= 1024) await flush();
      }
      await flush();
      const tree = await git(["write-tree"],indexEnv);
      const messagePath = path.join(temporary,"message");
      fs.writeFileSync(messagePath,message,{flag:"wx",mode:0o600});
      const commit = await git(["commit-tree",tree,...(parent ? ["-p",parent] : []),"-F",messagePath]);
      try {await git(["update-ref",ref,commit,"0".repeat(40)]);}
      catch (error) {
        // Lost acknowledgements/concurrent captures resolve against the actual
        // immutable ref, never by overwriting a previous baseline.
        const existing = await git(["rev-parse","--verify",ref]).catch(()=>{throw error;});
        if (existing !== commit) throw fail(conflict);
      }
      return {repository,ref,commit,tree};
    } finally {fs.rmSync(temporary,{recursive:true,force:true});}
  }
}
module.exports = {TaskGit};
