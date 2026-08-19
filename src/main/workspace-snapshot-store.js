"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const {
  HISTORY_LIMIT,
  collectSafeFiles,
  safeAbsolutePath,
  assertSafeExistingPath,
  isSafeRelativePath,
} = require("./workspace-version-policy");

function snapshotRoot(workspacePath) {
  return path.join(path.resolve(workspacePath), ".lily-work", "version-snapshots");
}

async function sha256File(filePath) {
  const hash = crypto.createHash("sha256");
  hash.update(await fs.promises.readFile(filePath));
  return hash.digest("hex");
}

async function writeJsonAtomic(filePath, value) {
  const temp = `${filePath}.${crypto.randomUUID()}.tmp`;
  await fs.promises.writeFile(temp, JSON.stringify(value, null, 2), "utf8");
  await fs.promises.rename(temp, filePath);
}

async function copyFileAtomic(source, destination) {
  await fs.promises.mkdir(path.dirname(destination), { recursive: true });
  const temp = `${destination}.${crypto.randomUUID()}.tmp`;
  try {
    await fs.promises.copyFile(source, temp);
    await fs.promises.rename(temp, destination);
  } finally {
    await fs.promises.rm(temp, { force: true }).catch(() => {});
  }
}

class WorkspaceSnapshotStore {
  async save(workspacePath, reason = "manual") {
    const root = snapshotRoot(workspacePath);
    const { files, totalBytes, truncated } = await collectSafeFiles(workspacePath);
    if (truncated) {
      const error = new Error("VERSION_SNAPSHOT_LIMIT_REACHED");
      error.code = "VERSION_SNAPSHOT_LIMIT_REACHED";
      throw error;
    }
    const id = `local-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
    const directory = path.join(root, id);
    await fs.promises.mkdir(path.join(directory, "files"), { recursive: true });
    const manifest = {
      id,
      timestamp: Date.now(),
      reason: String(reason || "manual"),
      fileCount: files.length,
      totalBytes,
      files: [],
    };
    try {
      for (const file of files) {
        const destination = path.join(directory, "files", file.relative);
        await copyFileAtomic(file.absolute, destination);
        manifest.files.push({ relative: file.relative, size: file.size, sha256: await sha256File(file.absolute) });
      }
      await writeJsonAtomic(path.join(directory, "manifest.json"), manifest);
    } catch (error) {
      await fs.promises.rm(directory, { recursive: true, force: true }).catch(() => {});
      throw error;
    }
    await this.prune(workspacePath);
    return manifest;
  }

  async list(workspacePath, limit = HISTORY_LIMIT) {
    const root = snapshotRoot(workspacePath);
    let entries;
    try {
      entries = await fs.promises.readdir(root, { withFileTypes: true });
    } catch (error) {
      if (error?.code === "ENOENT") return [];
      throw error;
    }
    const manifests = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      try {
        const manifest = JSON.parse(await fs.promises.readFile(path.join(root, entry.name, "manifest.json"), "utf8"));
        if (manifest?.id) manifests.push(manifest);
      } catch {
        // A partial snapshot is ignored; the next successful save will prune it.
      }
    }
    return manifests.sort((a, b) => b.timestamp - a.timestamp).slice(0, Math.max(1, Number(limit) || HISTORY_LIMIT));
  }

  async restore(workspacePath, manifest) {
    if (!manifest || !/^local-\d+-[a-f0-9]+$/i.test(String(manifest.id || "")) || !Array.isArray(manifest.files)) {
      throw new Error("VERSION_SNAPSHOT_CORRUPT");
    }
    const directory = path.join(snapshotRoot(workspacePath), manifest.id, "files");
    const files = manifest.files;
    if (files.some((file) => !file || !isSafeRelativePath(file.relative) || !Number.isSafeInteger(file.size) || !/^[a-f0-9]{64}$/i.test(String(file.sha256 || "")))) {
      throw new Error("VERSION_SNAPSHOT_CORRUPT");
    }
    const targetFiles = new Set(files.map((file) => file.relative));
    const current = await collectSafeFiles(workspacePath);
    // Preflight every source before deleting anything. The service adds a
    // restore-point rollback around this method for failures during mutation.
    for (const file of files) {
      const source = safeAbsolutePath(directory, file.relative);
      if (!source || !fs.existsSync(source) || !fs.lstatSync(source).isFile()) throw new Error("VERSION_SNAPSHOT_CORRUPT");
      const stat = fs.lstatSync(source);
      if (stat.size !== file.size || await sha256File(source) !== file.sha256) throw new Error("VERSION_SNAPSHOT_CORRUPT");
      if (!assertSafeExistingPath(workspacePath, file.relative)) throw new Error("UNSAFE_VERSION_PATH");
    }
    let changed = 0;
    for (const file of current.files) {
      if (targetFiles.has(file.relative)) continue;
      const absolute = assertSafeExistingPath(workspacePath, file.relative);
      if (!absolute) throw new Error("UNSAFE_VERSION_PATH");
      await fs.promises.unlink(absolute);
      changed += 1;
    }
    for (const file of files) {
      const destination = assertSafeExistingPath(workspacePath, file.relative);
      if (!destination) throw new Error("UNSAFE_VERSION_PATH");
      const source = safeAbsolutePath(directory, file.relative);
      if (!source) throw new Error("UNSAFE_VERSION_PATH");
      await copyFileAtomic(source, destination);
      changed += 1;
    }
    return { changed, id: manifest.id };
  }

  async get(workspacePath, id) {
    if (!/^local-\d+-[a-f0-9]+$/i.test(String(id || ""))) return null;
    const root = snapshotRoot(workspacePath);
    try {
      return JSON.parse(await fs.promises.readFile(path.join(root, id, "manifest.json"), "utf8"));
    } catch {
      return null;
    }
  }

  async diff(workspacePath, manifest) {
    const current = await collectSafeFiles(workspacePath);
    const currentByPath = new Map();
    for (const file of current.files) currentByPath.set(file.relative, file);
    const targetByPath = new Map();
    for (const file of manifest?.files || []) {
      if (!file || !isSafeRelativePath(file.relative)) continue;
      targetByPath.set(file.relative, file);
    }
    const entries = [];
    const paths = new Set([...currentByPath.keys(), ...targetByPath.keys()]);
    for (const relative of paths) {
      const currentFile = currentByPath.get(relative);
      const targetFile = targetByPath.get(relative);
      if (!currentFile && targetFile) {
        entries.push({ path: relative, kind: "added" });
        continue;
      }
      if (currentFile && !targetFile) {
        entries.push({ path: relative, kind: "deleted" });
        continue;
      }
      if (currentFile.size !== targetFile.size || await sha256File(currentFile.absolute) !== targetFile.sha256) {
        entries.push({ path: relative, kind: "modified" });
      }
    }
    return { entries, truncated: current.truncated };
  }

  async matches(workspacePath, manifest) {
    const result = await this.diff(workspacePath, manifest);
    return !result.truncated && result.entries.length === 0;
  }

  async prune(workspacePath) {
    const root = snapshotRoot(workspacePath);
    const manifests = await this.list(workspacePath, Number.MAX_SAFE_INTEGER);
    for (const manifest of manifests.slice(HISTORY_LIMIT)) {
      await fs.promises.rm(path.join(root, manifest.id), { recursive: true, force: true }).catch(() => {});
    }
  }
}

module.exports = { WorkspaceSnapshotStore };
