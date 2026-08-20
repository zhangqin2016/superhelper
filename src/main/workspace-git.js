"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { createExcludeFile, HISTORY_LIMIT, isSafeRelativePath, normalizeRelative } = require("./workspace-version-policy");

const execFileAsync = promisify(execFile);

function gitError(error, args) {
  const detail = String(error?.stderr || error?.stdout || error?.message || "Git operation failed").trim();
  const wrapped = new Error(detail || "Git operation failed");
  wrapped.code = error?.code || "GIT_OPERATION_FAILED";
  wrapped.gitArgs = args;
  return wrapped;
}

function executableNames(name) {
  if (process.platform !== "win32") return [name];
  return [`${name}.exe`, `${name}.cmd`, `${name}.bat`, name];
}

function gitPackPathEntries(packDir) {
  const root = String(packDir || "");
  if (!root) return [];
  return [
    root,
    path.join(root, "bin"),
    path.join(root, "cmd"),
    path.join(root, "usr", "bin"),
    path.join(root, "mingw64", "bin"),
  ].filter((dir) => fs.existsSync(dir));
}

function gitPackRuntimeEnv(packDir) {
  const root = String(packDir || "");
  if (!root) return {};
  const execPath = [
    path.join(root, "libexec", "git-core"),
    path.join(root, "usr", "libexec", "git-core"),
    path.join(root, "mingw64", "libexec", "git-core"),
  ].find((dir) => fs.existsSync(dir));
  const templateDir = [
    path.join(root, "share", "git-core", "templates"),
    path.join(root, "usr", "share", "git-core", "templates"),
    path.join(root, "mingw64", "share", "git-core", "templates"),
  ].find((dir) => fs.existsSync(dir));
  return {
    ...(execPath ? { GIT_EXEC_PATH: execPath } : {}),
    ...(templateDir ? { GIT_TEMPLATE_DIR: templateDir } : {}),
  };
}

function gitExecutableInPack(packDir) {
  const dirs = gitPackPathEntries(packDir);
  for (const dir of dirs) {
    for (const name of executableNames("git")) {
      const candidate = path.join(dir, name);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return "";
}

class WorkspaceGit {
  constructor(options = {}) {
    this.gitPath = options.gitPath || process.env.LILY_GIT_PATH || "git";
    this._systemGitPath = options.systemGitPath === undefined ? "git" : options.systemGitPath;
    this.maxBuffer = options.maxBuffer || 32 * 1024 * 1024;
    this._availability = null;
    this._availabilityPromise = null;
    this._autoInstall = options.autoInstall !== false;
    this._installAttempted = false;
    this._runtimePackDirs = options.runtimePackDirs || (() => {
      try {
        const { getEffectiveRuntimePackDir } = require("./runtime-packs");
        const dir = getEffectiveRuntimePackDir("git");
        return dir ? [dir] : [];
      } catch {
        return [];
      }
    });
    this._installRuntimePack = options.installRuntimePack || ((id, installOptions) =>
      require("./runtime-pack-installer").installRuntimePack(id, installOptions));
    this._gitPathEntries = [];
    this._gitRuntimeEnv = {};
    this._ensured = new Set();
  }

  async _probe(candidate, pathEntries = [], runtimeEnv = {}) {
    if (!candidate) return false;
    try {
      await execFileAsync(candidate, ["--version"], {
        timeout: 5000,
        maxBuffer: 1024 * 1024,
        windowsHide: true,
        env: {
          ...process.env,
          ...runtimeEnv,
          ...(pathEntries.length ? { PATH: [...pathEntries, process.env.PATH || ""].join(path.delimiter) } : {}),
        },
      });
      return true;
    } catch {
      return false;
    }
  }

  async _resolveGitPath() {
    const packDirs = await this._runtimePackDirs();
    for (const dir of Array.isArray(packDirs) ? packDirs : []) {
      const candidate = gitExecutableInPack(dir);
      const pathEntries = gitPackPathEntries(dir);
      const runtimeEnv = gitPackRuntimeEnv(dir);
      if (await this._probe(candidate, pathEntries, runtimeEnv)) {
        this._gitPathEntries = pathEntries;
        this._gitRuntimeEnv = runtimeEnv;
        return candidate;
      }
    }

    const initialCandidates = [this.gitPath];
    if (this.gitPath !== this._systemGitPath && this._systemGitPath) initialCandidates.push(this._systemGitPath);
    for (const candidate of initialCandidates) {
      if (await this._probe(candidate)) return candidate;
    }

    if (!this._autoInstall || this._installAttempted) return "";
    this._installAttempted = true;
    let result;
    try {
      result = await this._installRuntimePack("git");
    } catch (error) {
      result = { ok: false, error: error?.message || String(error) };
    }
    if (!result?.ok) return "";

    const installedDirs = [result.path, ...(await this._runtimePackDirs())];
    for (const dir of installedDirs) {
      const candidate = gitExecutableInPack(dir);
      const pathEntries = gitPackPathEntries(dir);
      const runtimeEnv = gitPackRuntimeEnv(dir);
      if (await this._probe(candidate, pathEntries, runtimeEnv)) {
        this._gitPathEntries = pathEntries;
        this._gitRuntimeEnv = runtimeEnv;
        return candidate;
      }
    }
    return "";
  }

  async isAvailable() {
    if (this._availability !== null) return this._availability;
    if (!this._availabilityPromise) {
      this._availabilityPromise = this._resolveGitPath().then((resolved) => {
        if (resolved) this.gitPath = resolved;
        this._availability = Boolean(resolved);
        return this._availability;
      });
    }
    return this._availabilityPromise;
  }

  _paths(workspacePath) {
    const root = path.resolve(workspacePath);
    const internal = path.join(root, ".lily-work");
    return {
      root,
      internal,
      vault: path.join(internal, "version-vault.git"),
      index: path.join(internal, "version-index"),
      exclude: path.join(internal, "version-exclude"),
    };
  }

  _env(paths) {
    return {
      ...process.env,
      ...this._gitRuntimeEnv,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
      GIT_PAGER: "cat",
      GIT_OPTIONAL_LOCKS: "0",
      PATH: [...this._gitPathEntries, process.env.PATH || ""].filter(Boolean).join(path.delimiter),
      GIT_DIR: paths.vault,
      GIT_WORK_TREE: paths.root,
      GIT_INDEX_FILE: paths.index,
    };
  }

  async _run(paths, args, options = {}) {
    try {
      return await execFileAsync(this.gitPath, args, {
        cwd: paths.root,
        env: this._env(paths),
        timeout: options.timeout || 30_000,
        maxBuffer: options.maxBuffer || this.maxBuffer,
        encoding: options.encoding,
      });
    } catch (error) {
      throw gitError(error, args);
    }
  }

  async ensure(workspacePath) {
    if (!(await this.isAvailable())) {
      const error = new Error("GIT_RUNTIME_UNAVAILABLE");
      error.code = "GIT_RUNTIME_UNAVAILABLE";
      throw error;
    }
    const paths = this._paths(workspacePath);
    const cacheKey = paths.vault;
    if (this._ensured.has(cacheKey) && fs.existsSync(path.join(paths.vault, "HEAD"))) return paths;
    await fs.promises.mkdir(paths.root, { recursive: true });
    await fs.promises.mkdir(paths.internal, { recursive: true });
    const head = path.join(paths.vault, "HEAD");
    if (!fs.existsSync(head)) {
      await execFileAsync(this.gitPath, ["init", "--bare", paths.vault], {
        cwd: paths.root,
        env: { ...process.env, ...this._gitRuntimeEnv, GIT_CONFIG_NOSYSTEM: "1" },
        timeout: 30_000,
        maxBuffer: 4 * 1024 * 1024,
      }).catch((error) => { throw gitError(error, ["init", "--bare", paths.vault]); });
    }
    await fs.promises.writeFile(paths.exclude, createExcludeFile(), "utf8");
    for (const [key, value] of [
      ["user.name", "Lily Workbench"],
      ["user.email", "lily@local.invalid"],
      ["commit.gpgsign", "false"],
      ["core.filemode", "false"],
      ["core.bare", "true"],
      ["core.worktree", paths.root],
      ["core.excludesFile", paths.exclude],
      ["lily.versionVault", "1"],
    ]) {
      await this._run(paths, ["config", key, value]);
    }
    this._ensured.add(cacheKey);
    return paths;
  }

  async status(workspacePath) {
    const paths = await this.ensure(workspacePath);
    const result = await this._run(paths, ["status", "--porcelain=v1", "-z", "--untracked-files=all"], { encoding: "buffer" });
    const raw = Buffer.isBuffer(result.stdout) ? result.stdout.toString("utf8") : String(result.stdout || "");
    return raw.split("\0").filter(Boolean).map((entry) => {
      const code = entry.slice(0, 2);
      return {
        code,
        path: normalizeRelative(entry.slice(3)),
        kind: code === "??" ? "untracked" : code.includes("D") ? "deleted" : "modified",
      };
    }).filter((entry) => isSafeRelativePath(entry.path));
  }

  async hasHead(workspacePath) {
    const paths = await this.ensure(workspacePath);
    try {
      const result = await this._run(paths, ["rev-parse", "--verify", "HEAD"]);
      return String(result.stdout || "").trim();
    } catch (error) {
      if (/ambiguous argument|Needed a single revision|ref HEAD is not a symbolic ref|unknown revision/i.test(error.message)) return "";
      throw error;
    }
  }

  async trackedFiles(workspacePath) {
    const paths = await this.ensure(workspacePath);
    const result = await this._run(paths, ["ls-files", "-z"], { encoding: "buffer" });
    return result.stdout.toString("utf8").split("\0").filter(Boolean)
      .map(normalizeRelative).filter(isSafeRelativePath);
  }

  async treeFiles(workspacePath, revision) {
    const paths = await this.ensure(workspacePath);
    const result = await this._run(paths, ["ls-tree", "-r", "-z", "--name-only", revision], { encoding: "buffer" });
    return result.stdout.toString("utf8").split("\0").filter(Boolean)
      .map(normalizeRelative).filter(isSafeRelativePath);
  }

  async readFile(workspacePath, revision, relative) {
    if (!isSafeRelativePath(relative)) throw new Error("UNSAFE_VERSION_PATH");
    const paths = await this.ensure(workspacePath);
    const result = await this._run(paths, ["show", `${revision}:${normalizeRelative(relative)}`], { encoding: "buffer", maxBuffer: 32 * 1024 * 1024 });
    return Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.from(result.stdout || "");
  }

  async stage(workspacePath, relativePaths) {
    const paths = await this.ensure(workspacePath);
    const unique = [...new Set(relativePaths.map(normalizeRelative).filter(isSafeRelativePath))];
    if (unique.length === 0) return 0;
    // Keep argv below Windows' command-line limit while still allowing large
    // workspaces to use the Git backend. The policy has already filtered each
    // path, so batching does not broaden the protected surface.
    let batch = [];
    let bytes = 0;
    const flush = async () => {
      if (!batch.length) return;
      await this._run(paths, ["add", "-A", "--", ...batch], { timeout: 120_000 });
      batch = [];
      bytes = 0;
    };
    for (const relative of unique) {
      const nextBytes = Buffer.byteLength(relative) + 16;
      if (batch.length >= 400 || (batch.length && bytes + nextBytes > 6000)) await flush();
      batch.push(relative);
      bytes += nextBytes;
    }
    await flush();
    return unique.length;
  }

  async commit(workspacePath, message) {
    const paths = await this.ensure(workspacePath);
    try {
      await this._run(paths, ["diff", "--cached", "--quiet"]);
      return null;
    } catch (error) {
      if (!/exit code 1|code 1/i.test(error.message) && error.code !== 1) throw error;
    }
    await this._run(paths, ["commit", "--no-verify", "-m", String(message || "Workspace snapshot")], { timeout: 120_000 });
    const head = await this._run(paths, ["rev-parse", "HEAD"]);
    return String(head.stdout || "").trim();
  }

  async history(workspacePath, limit = HISTORY_LIMIT) {
    const head = await this.hasHead(workspacePath);
    if (!head) return [];
    const paths = await this.ensure(workspacePath);
    const result = await this._run(paths, ["log", `--max-count=${Math.max(1, Math.min(HISTORY_LIMIT, Number(limit) || HISTORY_LIMIT))}`, "--format=%H%x1f%ct%x1f%s%x1e", "HEAD"], { encoding: "buffer" });
    return result.stdout.toString("utf8").split("\x1e").map((entry) => entry.trim()).filter(Boolean).map((entry) => {
      const [id, timestamp, subject] = entry.split("\x1f");
      return { id: String(id || "").trim(), timestamp: Number(timestamp) * 1000, subject: String(subject || "").trim() };
    }).filter((entry) => /^[0-9a-f]{7,64}$/i.test(entry.id));
  }

  async readTree(workspacePath, revision) {
    const paths = await this.ensure(workspacePath);
    await this._run(paths, ["read-tree", "--reset", revision], { timeout: 30_000 });
  }
}

module.exports = { WorkspaceGit, gitExecutableInPack };
