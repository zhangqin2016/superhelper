"use strict";
const fs = require("node:fs");
const path = require("node:path");
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
const execute = promisify(execFile);
const fail = code => Object.assign(new Error(`COLLAB_TASK_GIT_${code}`),{code:`COLLAB_TASK_GIT_${code}`});
const identity = stat => `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
function directory(root) {
  if (!path.isAbsolute(root) || path.resolve(root) !== root || fs.realpathSync(root) !== root || !fs.lstatSync(root).isDirectory()) throw fail("UNSAFE_PATH");
}

// The resolver is shared with private workspace versioning; repository, index,
// configuration and refs are deliberately independent of that version vault.
class TaskGit {
  constructor({rootPath,gitOptions} = {}) {
    this.rootPath = rootPath;
    this.git = new WorkspaceGit(gitOptions);
    this.ready = null;
  }
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
    const run = async (args,extra={}) => (await execute(runtime.executable,
      ["-c","core.hooksPath=" ,"-c","commit.gpgsign=false",...args],
      {cwd:this.rootPath,env:{...env,...extra},encoding:"utf8",timeout:120000,maxBuffer:1024*1024,windowsHide:true})).stdout.trim();
    if (!fs.existsSync(repository)) await run(["init","--bare","--template=","--object-format=sha1",repository]);
    directory(repository);
    const git = (args,extra)=>run(["--git-dir",repository,...args],extra);
    if (await git(["rev-parse","--is-bare-repository"]) !== "true" || fs.existsSync(path.join(repository,"objects","info","alternates"))) throw fail("REPOSITORY_INVALID");
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
    return {repository,git,writeBlob};
  }
  async hasRevision(revision) {
    if (!/^[0-9a-f]{40}$/.test(revision?.commit || "") || !/^refs\/tasks\/[0-9a-f]{64}\/(baseline|deliveries\/[0-9a-f]{64})$/.test(revision?.ref || "")) return false;
    const {git} = await this.ensure();
    try {
      if (await git(["rev-parse","--verify",revision.ref]) !== revision.commit) return false;
      await git(["fsck","--strict","--no-reflogs","--no-dangling",revision.commit]);
      return true;
    } catch {return false;}
  }
  async materializeSnapshot({revision,destinationRoot,parentCommit}) {
    if (!(await this.hasRevision(revision))) throw fail("REVISION_UNAVAILABLE");
    const {repository,git,writeBlob} = await this.ensure();
    const lineage = (await git(["rev-list","--parents","-n","1",revision.commit])).split(" ");
    if (lineage.length !== (parentCommit ? 2 : 1) || parentCommit && lineage[1] !== parentCommit) throw fail("ANCESTRY_INVALID");
    const entries = (await git(["ls-tree","-r","-l","-z",revision.commit])).split("\0").filter(Boolean).map(value=>{
      const match = /^100644 blob ([0-9a-f]{40}) +([0-9]+)\t(.+)$/.exec(value);
      if (!match || controlPath(match[3])) throw fail("TREE_INVALID");
      return {blob:match[1],path:match[3],sizeBytes:Number(match[2])};
    });
    manifestMap(entries.map(file=>({path:file.path,sha256:"0".repeat(64),sizeBytes:file.sizeBytes})));
    const limits = require("./workspace-package").DEFAULT_LIMITS;
    if (entries.some(file=>file.sizeBytes>limits.maxFileBytes) || entries.reduce((sum,file)=>sum+file.sizeBytes,0)>limits.maxTotalBytes) throw fail("LIMIT_EXCEEDED");
    if (typeof destinationRoot !== "string" || !path.isAbsolute(destinationRoot) || path.resolve(destinationRoot)!==destinationRoot
      || destinationRoot===this.rootPath || destinationRoot.startsWith(`${this.rootPath}${path.sep}`)
      || this.rootPath.startsWith(`${destinationRoot}${path.sep}`)) throw fail("UNSAFE_PATH");
    directory(path.dirname(destinationRoot));
    fs.mkdirSync(destinationRoot,{mode:0o700});
    const snapshotRoot=path.join(destinationRoot,"snapshot");fs.mkdirSync(snapshotRoot,{mode:0o700});
    const manifest=[];
    for (const file of entries) {
      const destination=path.join(snapshotRoot,file.path);
      fs.mkdirSync(path.dirname(destination),{recursive:true,mode:0o700});
      const content=await writeBlob(file.blob,destination,file);
      fs.chmodSync(destination,0o400);manifest.push({path:file.path,...content});
    }
    return {snapshotRoot,manifest,gitRevision:{repository,ref:revision.ref,commit:revision.commit,
      tree:await git(["rev-parse",`${revision.commit}^{tree}`]),manifestHash:manifestHash(manifest)}};
  }
  async ensureWorktree({baseline,workRoot,manifest}) {
    const files = manifestMap(manifest);
    const {repository,git,writeBlob} = await this.ensure();
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
      return {workRoot,fileIdentities:saved.fileIdentities || []};
    }
    const entries = (await git(["ls-tree","-r","-z",baseline.commit])).split("\0").filter(Boolean).map(value=>{
      const match = /^(100644) blob ([0-9a-f]{40})\t(.+)$/.exec(value);
      if (!match) throw fail("TREE_INVALID");
      const file = files.get(match[3].toLowerCase());
      if (!file || file.path !== match[3] || controlPath(file.path)) throw fail("TREE_INVALID");
      return {blob:match[2],file};
    });
    if (entries.length !== files.size) throw fail("TREE_INVALID");
    await git(["worktree","add","--detach","--no-checkout",workRoot,baseline.commit]);
    const target = metadata();
    await git(["--git-dir",target,"read-tree",baseline.commit]);
    for (const {blob,file} of entries) {
      const destination = path.join(workRoot,file.path);
      fs.mkdirSync(path.dirname(destination),{recursive:true,mode:0o700});
      await writeBlob(blob,destination,file);
    }
    const fileIdentities = entries.map(({file})=>({path:file.path,identity:taskFileIdentity(fs.lstatSync(path.join(workRoot,file.path),{bigint:true}))})).filter(file=>file.identity);
    const stat = fs.statSync(workRoot);
    fs.writeFileSync(path.join(target,"lily-task.json"),JSON.stringify({commit:baseline.commit,ref:baseline.ref,workRoot,dev:stat.dev,ino:stat.ino,fileIdentities}),{flag:"wx",mode:0o600});
    return {workRoot,fileIdentities};
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
      for (const relative of removed) await git(["update-index","--force-remove","--",relative],indexEnv);
      for (const file of files) {
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
        const captured = path.join(temporary,"blob");
        const digest = createHash("sha256"); let size = 0;
        try {
          if (identity(fs.fstatSync(fd)) !== identity(before)) throw fail("SNAPSHOT_CHANGED");
          await pipeline(fs.createReadStream(source,{fd,autoClose:false}),new Transform({transform(chunk,_encoding,callback) {
            size += chunk.length; digest.update(chunk); callback(null,chunk);
          }}),fs.createWriteStream(captured,{flags:"wx",mode:0o600}));
          if (size !== file.sizeBytes || digest.digest("hex") !== file.sha256
            || identity(fs.fstatSync(fd)) !== identity(before) || identity(fs.lstatSync(source)) !== identity(before)
            || fs.realpathSync(source) !== source) throw fail("SNAPSHOT_CHANGED");
        } finally {fs.closeSync(fd);}
        const blob = await git(["hash-object","-w","--no-filters",captured]);
        await git(["update-index","--add","--cacheinfo","100644",blob,file.path],indexEnv);
        fs.unlinkSync(captured);
      }
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
