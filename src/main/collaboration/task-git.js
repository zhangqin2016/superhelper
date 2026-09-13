"use strict";
const fs = require("node:fs");
const path = require("node:path");
const {createHash} = require("node:crypto");
const {execFile} = require("node:child_process");
const {promisify} = require("node:util");
const {pipeline} = require("node:stream/promises");
const {Transform} = require("node:stream");
const {WorkspaceGit} = require("../workspace-git");
const {manifestMap} = require("./task-apply-plan");
const {controlPath} = require("./task-bundle");
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
    return {repository,git};
  }
  async captureBaseline({taskId,snapshotRoot,manifest}) {
    if (typeof taskId !== "string" || !taskId || taskId.length > 512) throw fail("TASK_INVALID");
    const files = [...manifestMap(manifest).values()].sort((a,b)=>a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
    if (files.some(file=>controlPath(file.path))) throw fail("CONTROL_FILE");
    directory(snapshotRoot);
    // A source tree must never contain the collaboration object database.
    if (this.rootPath === snapshotRoot || this.rootPath.startsWith(`${snapshotRoot}${path.sep}`)
      || snapshotRoot.startsWith(`${this.rootPath}${path.sep}`)) throw fail("ROOT_OVERLAP");
    const {repository,git} = await this.ensure();
    const temporary = fs.mkdtempSync(path.join(this.rootPath,"capture-"));
    const indexEnv = {GIT_INDEX_FILE:path.join(temporary,"index")};
    try {
      await git(["read-tree","--empty"],indexEnv);
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
      const commit = await git(["commit-tree",tree,"-m","Task baseline"]);
      const key = createHash("sha256").update(taskId).digest("hex");
      const ref = `refs/tasks/${key}/baseline`;
      try {await git(["update-ref",ref,commit,"0".repeat(40)]);}
      catch (error) {
        // Lost acknowledgements/concurrent captures resolve against the actual
        // immutable ref, never by overwriting a previous baseline.
        const existing = await git(["rev-parse","--verify",ref]).catch(()=>{throw error;});
        if (existing !== commit) throw fail("BASELINE_CONFLICT");
      }
      return {repository,ref,commit,tree};
    } finally {fs.rmSync(temporary,{recursive:true,force:true});}
  }
}
module.exports = {TaskGit};
