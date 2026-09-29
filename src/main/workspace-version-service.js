"use strict";

const fs = require("node:fs");
const path = require("node:path");
const {
  HISTORY_LIMIT,
  MAX_FILE_BYTES,
  MAX_TOTAL_BYTES,
  MAX_GIT_FILES,
  MAX_GIT_TOTAL_BYTES,
  collectSafeFiles,
  relativePath,
  isSafeRelativePath,
  describeStatusCode,
  assertSafeExistingPath,
} = require("./workspace-version-policy");
const { WorkspaceGit } = require("./workspace-git");
const { WorkspaceSnapshotStore } = require("./workspace-snapshot-store");

const MESSAGES = Object.freeze({
  manual: "Workspace snapshot",
  task: "Task completed snapshot",
  recovery: "Recovery snapshot",
  restore: "Restore point",
  restored: "Restore workspace version",
});

function normalizeWorkspace(workspacePath) {
  return path.resolve(String(workspacePath || ""));
}

function errorCode(error) {
  return String(error?.code || error?.message || "VERSION_CONTROL_FAILED").slice(0, 120);
}

class WorkspaceVersionService {
  constructor(options = {}) {
    this.git = options.git || new WorkspaceGit();
    this.snapshots = options.snapshots || new WorkspaceSnapshotStore();
    this._locks = new Map();
    this._mutations = new Set();
    this._backend = new Map();
    this._writer = require("./collaboration/local-writer").createLocalWriter({filePath:options.writerLockPath});
  }

  isMutating(workspacePath) {
    return this._mutations.has(normalizeWorkspace(workspacePath));
  }

  async _withMutation(workspacePath, fn, writesWorkspace = false) {
    const key = normalizeWorkspace(workspacePath);
    if (this._mutations.has(key)) {
      const error = new Error("WORKSPACE_VERSION_BUSY");
      error.code = "WORKSPACE_VERSION_BUSY";
      throw error;
    }
    this._mutations.add(key);
    try {
      return await (writesWorkspace ? this._writer.runAsync(() => this._withLock(key, fn)) : this._withLock(key, fn));
    } catch(error) {
      if(error.code==="COLLAB_TASK_APPLICATION_BUSY"){
        const busy=new Error("WORKSPACE_VERSION_BUSY");busy.code="WORKSPACE_VERSION_BUSY";throw busy;
      }
      throw error;
    } finally {
      this._mutations.delete(key);
    }
  }

  async _withLock(workspacePath, fn) {
    const key = normalizeWorkspace(workspacePath);
    const previous = this._locks.get(key) || Promise.resolve();
    let release;
    const current = new Promise((resolve) => { release = resolve; });
    this._locks.set(key, current);
    await previous;
    try {
      return await fn(key);
    } finally {
      release();
      if (this._locks.get(key) === current) this._locks.delete(key);
    }
  }

  async _backendFor(workspacePath) {
    const key = normalizeWorkspace(workspacePath);
    const cached = this._backend.get(key);
    if (cached) return cached;
    if (await this.git.isAvailable()) {
      try {
        await this.git.ensure(key);
        const backend = { mode: "git" };
        this._backend.set(key, backend);
        return backend;
      } catch (error) {
        console.warn("[workspace-version] git vault unavailable, using local snapshots:", errorCode(error));
      }
    }
    const backend = { mode: "local" };
    this._backend.set(key, backend);
    return backend;
  }

  /**
   * What a turn needs before it starts. In git mode: nothing but a vault — the
   * turn's version is built from the files the turn itself changed (below), so
   * no whole-workspace `git status` is awaited before the message is sent (a
   * multi-GB workspace spent 10+ s there on every turn, 2026-09-29). The local
   * fallback (no git) keeps its bounded baseline.
   */
  async captureBaseline(workspacePath) {
    const scopedKey = normalizeWorkspace(workspacePath);
    const scopedBackend = await this._backendFor(scopedKey);
    if (scopedBackend.mode === "git") return { mode: "git", scoped: true, clean: true, paths: [], capturedAt: Date.now() };
    return this._withLock(workspacePath, async (key) => {
      const backend = await this._backendFor(key);
      if (backend.mode !== "git") {
        const latest = (await this.snapshots.list(key, 1))[0] || null;
        const files = await collectSafeFiles(key);
        const diff = latest ? await this.snapshots.diff(key, latest) : { entries: files.files.map((file) => ({ path: file.relative })) };
        return {
          mode: backend.mode,
          clean: latest ? diff.entries.length === 0 && !diff.truncated : files.files.length === 0,
          paths: diff.entries.map((entry) => entry.path),
          revisionId: latest?.id || null,
          reason: "local_backend",
        };
      }
      const entries = await this.git.status(key);
      return {
        mode: backend.mode,
        clean: entries.length === 0,
        paths: entries.map((entry) => entry.path),
        capturedAt: Date.now(),
      };
    });
  }

  async status(workspacePath) {
    return this._withLock(workspacePath, async (key) => {
      const backend = await this._backendFor(key);
      if (backend.mode === "git") {
        const entries = await this.git.status(key);
        const versions = await this.git.history(key, 1);
        const tracked = await this.git.trackedFiles(key);
        return {
          ok: true,
          mode: "git",
          active: true,
          hasVersion: versions.length > 0,
          latest: versions[0] || null,
          protectedFileCount: tracked.length,
          unprotectedFiles: entries.map((entry) => ({ path: entry.path, kind: entry.kind, code: entry.code })),
          unprotectedCount: entries.length,
        };
      }
      const versions = await this.snapshots.list(key, 1);
      const files = await collectSafeFiles(key);
      const diff = versions[0]
        ? await this.snapshots.diff(key, versions[0])
        : { entries: files.files.map((file) => ({ path: file.relative })), truncated: files.truncated };
      return {
        ok: true,
        mode: "local",
        active: true,
        hasVersion: versions.length > 0,
        latest: versions[0] || null,
        protectedFileCount: versions[0]?.fileCount || 0,
        unprotectedFiles: diff.entries.map((entry) => ({ path: entry.path, kind: entry.kind, code: entry.kind })),
        unprotectedCount: diff.entries.length,
        currentFileCount: files.files.length,
      };
    });
  }

  async history(workspacePath, limit = HISTORY_LIMIT) {
    return this._withLock(workspacePath, async (key) => {
      const backend = await this._backendFor(key);
      const versions = backend.mode === "git"
        ? await this.git.history(key, limit)
        : await this.snapshots.list(key, limit);
      return { ok: true, mode: backend.mode, versions };
    });
  }

  async _saveLocked(key, backend, reason = "manual", paths = null) {
    if (backend.mode === "local") {
      return this.snapshots.save(key, reason);
    }
    const tracked = await this.git.trackedFiles(key);
    const currentFiles = await collectSafeFiles(key, {
      maxFiles: MAX_GIT_FILES,
      maxTotalBytes: MAX_GIT_TOTAL_BYTES,
    });
    if (currentFiles.truncated) {
      const error = new Error("VERSION_SNAPSHOT_LIMIT_REACHED");
      error.code = "VERSION_SNAPSHOT_LIMIT_REACHED";
      throw error;
    }
    const candidates = [...new Set([
      ...tracked,
      ...currentFiles.files.map((file) => file.relative),
      ...(Array.isArray(paths) ? paths : []),
    ])].filter(isSafeRelativePath);
    await this.git.stage(key, candidates);
    const id = await this.git.commit(key, MESSAGES[reason] || MESSAGES.manual);
    if (!id) {
      const history = await this.git.history(key, 1);
      return history[0] || null;
    }
    const history = await this.git.history(key, 1);
    return history[0] || { id, timestamp: Date.now(), subject: MESSAGES[reason] || MESSAGES.manual };
  }

  async save(workspacePath, reason = "manual") {
    return this._withMutation(workspacePath, async (key) => {
      const backend = await this._backendFor(key);
      const version = await this._saveLocked(key, backend, reason);
      return { ok: true, mode: backend.mode, version };
    });
  }

  async autoSaveTurn({ workspacePath, baseline, changedPaths = [], terminal = "" } = {}) {
    if (terminal !== "turn.completed") return { ok: true, saved: false, skipped: "turn_not_completed" };
    if ((await this._backendFor(normalizeWorkspace(workspacePath))).mode === "git") {
      return this._withLock(workspacePath, (key) => this._saveTurnChanges(key, changedPaths));
    }
    return this._withMutation(workspacePath, async (key) => {
      if (!baseline?.clean) return { ok: true, saved: false, skipped: "workspace_was_not_clean" };
      const backend = await this._backendFor(key);
      const changed = [...new Set(changedPaths.map((filePath) => relativePath(key, filePath) || String(filePath || "")).filter(isSafeRelativePath))];
      if (backend.mode !== "git") {
        if (baseline.revisionId) {
          const baselineVersion = await this.snapshots.get(key, baseline.revisionId);
          const diff = baselineVersion ? await this.snapshots.diff(key, baselineVersion) : null;
          const changedSet = new Set(changed);
          if (!baselineVersion || diff.truncated || diff.entries.some((entry) => !changedSet.has(entry.path))) {
            return { ok: true, saved: false, skipped: "unrelated_workspace_changes" };
          }
        } else if (changed.length === 0) {
          return { ok: true, saved: false, skipped: "no_safe_changes" };
        }
        const version = await this._saveLocked(key, backend, "task");
        return { ok: true, saved: true, mode: backend.mode, version };
      }
      if (changed.length === 0) return { ok: true, saved: false, skipped: "no_safe_changes" };
      const current = await this.git.status(key);
      const currentPaths = new Set(current.map((entry) => entry.path));
      if ([...currentPaths].some((entry) => !changed.includes(entry))) {
        return { ok: true, saved: false, skipped: "unrelated_workspace_changes" };
      }
      const version = await this._saveLocked(key, backend, "task", changed);
      return { ok: true, saved: true, mode: backend.mode, version };
    });
  }

  /**
   * A turn's version = the previous version + exactly the files this turn
   * changed, the way Claude Code checkpoints the files its own tools edit and
   * the engine's snapshot stages only changed paths. Cost follows what the turn
   * wrote, never the size of the workspace; nothing else is scanned or hashed.
   * A file over the per-file limit, or past the per-turn total, is skipped by
   * name instead of failing the save. Runs under the lock only: saving reads
   * the workspace, so it never makes a new message wait or be refused.
   */
  async _saveTurnChanges(key, changedPaths = []) {
    const started = Date.now();
    const changed = [...new Set(changedPaths.map((filePath) => relativePath(key, filePath) || String(filePath || "")).filter(isSafeRelativePath))];
    if (changed.length === 0) return { ok: true, saved: false, skipped: "no_safe_changes" };
    const tracked = await this.git.trackedAmong(key, changed);
    const skipped = [];
    const present = [];
    const stageable = [];
    let total = 0;
    for (const relative of changed) {
      const absolute = assertSafeExistingPath(key, relative);
      const stat = absolute ? await fs.promises.lstat(absolute).catch(() => null) : null;
      if (!stat) {
        if (tracked.has(relative)) stageable.push(relative); // a deletion the vault can record
        continue;
      }
      if (!stat.isFile()) continue;
      if (stat.size > MAX_FILE_BYTES || total + stat.size > MAX_TOTAL_BYTES) { skipped.push(relative); continue; }
      total += stat.size;
      present.push(relative);
    }
    const ignored = await this.git.ignoredAmong(key, present.filter((relative) => !tracked.has(relative)));
    stageable.push(...present.filter((relative) => !ignored.has(relative)));
    if (stageable.length === 0) return { ok: true, saved: false, skipped: "no_safe_changes", skippedFiles: skipped };
    await this.git.stage(key, stageable);
    const id = await this.git.commit(key, MESSAGES.task);
    const version = id ? ((await this.git.history(key, 1))[0] || { id, timestamp: Date.now(), subject: MESSAGES.task }) : null;
    console.info(`[workspace-version] turn save ${Date.now() - started}ms files=${stageable.length} skipped=${skipped.length} bytes=${total}`);
    return { ok: true, saved: Boolean(id), mode: "git", version, skippedFiles: skipped };
  }

  async previewRestore(workspacePath, revision) {
    return this._withLock(workspacePath, async (key) => {
      const backend = await this._backendFor(key);
      if (backend.mode === "local") {
        const target = await this.snapshots.get(key, revision);
        if (!target) return { ok: false, error: "VERSION_NOT_FOUND" };
        const diff = await this.snapshots.diff(key, target);
        return this._previewResult(backend.mode, revision, diff.entries, diff.truncated);
      }
      const versions = await this.git.history(key, HISTORY_LIMIT);
      const target = versions.find((version) => version.id === revision || version.id.startsWith(String(revision || "")));
      if (!target) return { ok: false, error: "VERSION_NOT_FOUND" };
      const targetFiles = await this.git.treeFiles(key, target.id);
      const entries = [];
      for (const relative of targetFiles) {
        const absolute = assertSafeExistingPath(key, relative);
        if (!absolute) return { ok: false, error: "UNSAFE_VERSION_PATH" };
        if (!fs.existsSync(absolute)) {
          entries.push({ path: relative, kind: "added" });
          continue;
        }
        const [currentBuffer, targetBuffer] = await Promise.all([
          fs.promises.readFile(absolute),
          this.git.readFile(key, target.id, relative),
        ]);
        if (!currentBuffer.equals(targetBuffer)) entries.push({ path: relative, kind: "modified" });
      }
      for (const relative of await this._removableFor(key, targetFiles)) {
        if (fs.existsSync(assertSafeExistingPath(key, relative) || "")) entries.push({ path: relative, kind: "deleted" });
      }
      return this._previewResult(backend.mode, target.id, entries, false);
    });
  }

  _previewResult(mode, revision, entries, truncated = false) {
    const counts = { added: 0, modified: 0, deleted: 0 };
    for (const entry of entries) {
      if (Object.hasOwn(counts, entry.kind)) counts[entry.kind] += 1;
    }
    return {
      ok: true,
      mode,
      revision,
      counts,
      total: entries.length,
      truncated: Boolean(truncated),
      files: entries.slice(0, 100),
    };
  }

  /**
   * Files a restore to `targetFiles` removes: ones the vault KNOWS (tracked)
   * that the target does not hold — what later versions added. A file the vault
   * never versioned is not the vault's to delete: restore used to remove every
   * file absent from the target, which with per-turn versions would include the
   * user's own files that simply were never saved (Claude Code's rewind likewise
   * only reverts what it tracked).
   */
  async _removableFor(key, targetFiles) {
    const targetSet = new Set(targetFiles);
    return (await this.git.trackedFiles(key)).filter((relative) => !targetSet.has(relative) && isSafeRelativePath(relative));
  }

  async _applyGitRevision(key, revision, removable = null) {
    const targetFiles = await this.git.treeFiles(key, revision);
    const prepared = [];
    for (const relative of targetFiles) {
      const absolute = assertSafeExistingPath(key, relative);
      if (!absolute) throw new Error("UNSAFE_VERSION_PATH");
      prepared.push({ relative, absolute, buffer: await this.git.readFile(key, revision, relative) });
    }
    const currentFiles = removable || await this._removableFor(key, targetFiles);
    let changed = 0;
    for (const relative of currentFiles) {
      const absolute = assertSafeExistingPath(key, relative);
      if (!absolute) throw new Error("UNSAFE_VERSION_PATH");
      try {
        await fs.promises.unlink(absolute);
        changed += 1;
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
    }
    for (const file of prepared) {
      await fs.promises.mkdir(path.dirname(file.absolute), { recursive: true });
      const temp = `${file.absolute}.${Date.now()}.restore.tmp`;
      try {
        await fs.promises.writeFile(temp, file.buffer);
        await fs.promises.rename(temp, file.absolute);
      } finally {
        await fs.promises.rm(temp, { force: true }).catch(() => {});
      }
      changed += 1;
    }
    await this.git.readTree(key, revision);
    return changed;
  }

  async restore(workspacePath, revision) {
    return this._withMutation(workspacePath, async (key) => {
      const backend = await this._backendFor(key);
      if (backend.mode === "local") {
        const target = await this.snapshots.get(key, revision);
        if (!target) return { ok: false, error: "VERSION_NOT_FOUND" };
        const restorePoint = await this.snapshots.save(key, "restore");
        let result;
        let restoredVersion;
        try {
          result = await this.snapshots.restore(key, target);
          restoredVersion = await this.snapshots.save(key, "restored");
        } catch (error) {
          try { await this.snapshots.restore(key, restorePoint); } catch (rollbackError) {
            error.code = "VERSION_RESTORE_ROLLBACK_FAILED";
            error.rollbackCode = errorCode(rollbackError);
          }
          throw error;
        }
        return {
          ok: true,
          mode: backend.mode,
          restoredRevision: restoredVersion?.id || revision,
          restorePoint: restorePoint?.id || null,
          fileCount: result.changed,
        };
      }
      const versions = await this.git.history(key, HISTORY_LIMIT);
      const target = versions.find((version) => version.id === revision || version.id.startsWith(String(revision || "")));
      if (!target) return { ok: false, error: "VERSION_NOT_FOUND" };
      // The restore point holds exactly what the restore will overwrite or
      // remove — the target's files and the ones the vault knows — so it needs
      // no whole-workspace scan, and a large unrelated file cannot block it.
      const targetFiles = await this.git.treeFiles(key, target.id);
      const removable = await this._removableFor(key, targetFiles);
      const touched = [...new Set([...targetFiles, ...removable])];
      const known = await this.git.trackedAmong(key, touched);
      const existing = touched.filter((relative) => known.has(relative) || fs.existsSync(assertSafeExistingPath(key, relative) || ""));
      const ignored = await this.git.ignoredAmong(key, existing.filter((relative) => !known.has(relative)));
      await this.git.stage(key, existing.filter((relative) => !ignored.has(relative)));
      await this.git.commit(key, MESSAGES.restore);
      const restorePoint = (await this.git.history(key, 1))[0] || null;
      let changed;
      let restoredVersion;
      try {
        changed = await this._applyGitRevision(key, target.id, removable);
        restoredVersion = await this.git.commit(key, MESSAGES.restored);
      } catch (error) {
        try {
          const pointFiles = new Set(await this.git.treeFiles(key, restorePoint.id));
          await this._applyGitRevision(key, restorePoint.id, targetFiles.filter((relative) => !pointFiles.has(relative)));
        } catch (rollbackError) {
          error.code = "VERSION_RESTORE_ROLLBACK_FAILED";
          error.rollbackCode = errorCode(rollbackError);
        }
        throw error;
      }
      return {
        ok: true,
        mode: backend.mode,
        restoredRevision: target.id,
        restorePoint: restorePoint?.id || null,
        version: restoredVersion,
        fileCount: changed,
      };
    }, true);
  }
}

module.exports = { WorkspaceVersionService, MESSAGES };
