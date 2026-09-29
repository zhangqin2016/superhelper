import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.dirname(fileURLToPath(import.meta.url));
const projectDir = path.dirname(rootDir);
const { WorkspaceVersionService } = await import("../src/main/workspace-version-service.js");
const { isIgnoredRelativePath, isSafeRelativePath } = await import("../src/main/workspace-version-policy.js");
const { isProjectBusy, isVersionId } = await import("../src/main/ipc-projects.js");

function tempWorkspace() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "lily-version-test-"));
}

function removeWorkspace(workspace) {
  fs.rmSync(workspace, { recursive: true, force: true });
}

async function testPolicy() {
  assert.equal(isIgnoredRelativePath(".lily-work/version-index"), true);
  assert.equal(isIgnoredRelativePath("node_modules/pkg/index.js"), true);
  assert.equal(isIgnoredRelativePath(".env"), true);
  assert.equal(isIgnoredRelativePath("notes.txt"), false);
  assert.equal(isSafeRelativePath("../outside.txt"), false);
  assert.equal(isSafeRelativePath("docs/notes.txt"), true);
  assert.equal(isVersionId("local-1724000000000-a1b2c3d4"), true);
  assert.equal(isVersionId("../../outside"), false);
}

async function testGitIsolationAndRestore() {
  const workspace = tempWorkspace();
  try {
    fs.mkdirSync(path.join(workspace, ".git"));
    fs.writeFileSync(path.join(workspace, ".git", "HEAD"), "ref: refs/heads/main\n");
    const userGitHead = fs.readFileSync(path.join(workspace, ".git", "HEAD"), "utf8");
    fs.writeFileSync(path.join(workspace, "notes.txt"), "one\n");
    fs.writeFileSync(path.join(workspace, ".env"), "SECRET=do-not-track\n");

    const service = new WorkspaceVersionService({writerLockPath:path.join(fs.realpathSync(workspace),".lily-work","writer.sqlite")});
    const firstStatus = await service.status(workspace);
    assert.equal(firstStatus.mode, "git");
    assert.deepEqual(firstStatus.unprotectedFiles.map((entry) => entry.path), ["notes.txt"]);
    assert.equal(firstStatus.protectedFileCount, 0);

    const first = await service.save(workspace);
    assert.equal(first.ok, true);
    fs.writeFileSync(path.join(workspace, "notes.txt"), "two\n");
    fs.writeFileSync(path.join(workspace, "new.txt"), "new\n");
    // A turn's version holds exactly what the turn changed: notes.txt, not the
    // user's own new.txt the turn never touched (2026-09-29: scoped versions).
    const baseline = await service.captureBaseline(workspace);
    assert.equal(baseline.scoped, true, "git mode: no whole-workspace scan before a turn");
    const turn = await service.autoSaveTurn({
      workspacePath: workspace,
      baseline,
      changedPaths: [path.join(workspace, "notes.txt")],
      terminal: "turn.completed",
    });
    assert.equal(turn.saved, true, "the turn's own change is versioned even with unrelated edits around it");
    fs.writeFileSync(path.join(workspace, "agent.txt"), "made by the agent\n");
    await service.autoSaveTurn({ workspacePath: workspace, baseline, changedPaths: [path.join(workspace, "agent.txt")], terminal: "turn.completed" });
    const history = await service.history(workspace);
    assert.equal(history.versions.length, 3);
    fs.writeFileSync(path.join(workspace, "notes.txt"), "unsaved edit\n");
    const restored = await service.restore(workspace, history.versions[2].id);
    assert.equal(restored.ok, true);
    assert.equal(fs.readFileSync(path.join(workspace, "notes.txt"), "utf8"), "one\n");
    assert.equal(fs.existsSync(path.join(workspace, "agent.txt")), false, "a file a later version added is removed");
    assert.equal(fs.readFileSync(path.join(workspace, "new.txt"), "utf8"), "new\n", "a file the vault never versioned is not the vault's to delete");
    assert.equal(fs.readFileSync(path.join(workspace, ".env"), "utf8"), "SECRET=do-not-track\n");
    assert.deepEqual((await service.status(workspace)).unprotectedFiles.map((entry) => entry.path), ["new.txt"]);
    // The restore point kept what the restore overwrote and removed.
    assert.ok(restored.restorePoint, "restore reports its restore point");
    assert.equal((await service.git.readFile(workspace, restored.restorePoint, "agent.txt")).toString(), "made by the agent\n");
    assert.equal((await service.git.readFile(workspace, restored.restorePoint, "notes.txt")).toString(), "unsaved edit\n", "an unsaved edit the restore overwrote is kept in the restore point");
    assert.equal(fs.readFileSync(path.join(workspace, ".git", "HEAD"), "utf8"), userGitHead);
  } finally {
    removeWorkspace(workspace);
  }
}

async function testAutomaticSaveAndLocalFallback() {
  const workspace = tempWorkspace();
  try {
    const service = new WorkspaceVersionService({writerLockPath:path.join(fs.realpathSync(workspace),".lily-work","writer.sqlite")});
    fs.writeFileSync(path.join(workspace, "task.txt"), "before\n");
    await service.save(workspace);
    const baseline = await service.captureBaseline(workspace);
    assert.equal(baseline.clean, true);
    fs.writeFileSync(path.join(workspace, "task.txt"), "after\n");
    const preview = await service.previewRestore(workspace, (await service.history(workspace)).versions.at(-1).id);
    assert.equal(preview.ok, true);
    assert.deepEqual(preview.counts, { added: 0, modified: 1, deleted: 0 });
    const saved = await service.autoSaveTurn({
      workspacePath: workspace,
      baseline,
      changedPaths: [path.join(workspace, "task.txt")],
      terminal: "turn.completed",
    });
    assert.equal(saved.saved, true);
    assert.equal((await service.history(workspace)).versions.length, 2);

    const fallbackWorkspace = tempWorkspace();
    try {
      const fallback = new WorkspaceVersionService({ writerLockPath:path.join(fs.realpathSync(fallbackWorkspace),".lily-work","writer.sqlite"), git: { isAvailable: async () => false } });
      fs.writeFileSync(path.join(fallbackWorkspace, "draft.txt"), "local\n");
      const version = await fallback.save(fallbackWorkspace);
      assert.equal(version.mode, "local");
      fs.writeFileSync(path.join(fallbackWorkspace, "draft.txt"), "changed\n");
      const fallbackBaseline = await fallback.captureBaseline(fallbackWorkspace);
      assert.equal(fallbackBaseline.clean, false);
      const restored = await fallback.restore(fallbackWorkspace, version.version.id);
      assert.equal(restored.ok, true);
      assert.equal(fs.readFileSync(path.join(fallbackWorkspace, "draft.txt"), "utf8"), "local\n");
      const afterRestoreBaseline = await fallback.captureBaseline(fallbackWorkspace);
      assert.equal(afterRestoreBaseline.clean, true);
      fs.writeFileSync(path.join(fallbackWorkspace, "draft.txt"), "auto-saved\n");
      const fallbackAutoSave = await fallback.autoSaveTurn({
        workspacePath: fallbackWorkspace,
        baseline: afterRestoreBaseline,
        changedPaths: [path.join(fallbackWorkspace, "draft.txt")],
        terminal: "turn.completed",
      });
      assert.equal(fallbackAutoSave.saved, true);
      assert.equal((await fallback.history(fallbackWorkspace)).versions.length, 4);
    } finally {
      removeWorkspace(fallbackWorkspace);
    }
  } finally {
    removeWorkspace(workspace);
  }
}

async function testGitBackendSupportsLargeWorkspace() {
  const workspace = tempWorkspace();
  try {
    for (let index = 0; index < 10_001; index += 1) {
      fs.writeFileSync(path.join(workspace, `case-${String(index).padStart(5, "0")}.md`), "case\n");
    }
    const service = new WorkspaceVersionService({writerLockPath:path.join(fs.realpathSync(workspace),".lily-work","writer.sqlite")});
    const saved = await service.save(workspace);
    assert.equal(saved.ok, true);
    assert.equal(saved.mode, "git");
    assert.equal((await service.status(workspace)).protectedFileCount, 10_001);
  } finally {
    removeWorkspace(workspace);
  }
}

// 2026-09-29 (a customer's 6.7 GB workspace): every turn awaited a
// whole-workspace `git status` before its message was sent and ended with a
// tree walk + `git add` of every file; a save in progress refused the next
// message. A turn now costs what it wrote.
async function testTurnSaveIsScoped() {
  const workspace = tempWorkspace();
  try {
    const service = new WorkspaceVersionService({writerLockPath:path.join(fs.realpathSync(workspace),".lily-work","writer.sqlite")});
    for (let index = 0; index < 300; index += 1) fs.writeFileSync(path.join(workspace, `asset-${index}.txt`), "asset\n");
    fs.writeFileSync(path.join(workspace, ".gitignore"), "scratch/\n");
    fs.mkdirSync(path.join(workspace, "scratch"));
    fs.writeFileSync(path.join(workspace, "scratch", "tmp.txt"), "tmp\n");
    fs.writeFileSync(path.join(workspace, "report.md"), "v1\n");
    fs.writeFileSync(path.join(workspace, "huge.bin"), Buffer.alloc(26 * 1024 * 1024));
    const calls = [];
    let blockedDuringSave = null;
    const real = service.git;
    service.git = new Proxy(real, { get(target, property) {
      const value = target[property];
      if (typeof value !== "function") return value;
      return (...args) => {
        calls.push(String(property));
        if (property === "stage") blockedDuringSave = service.isMutating(workspace); // mid-save
        return value.apply(target, args);
      };
    } });
    const baseline = await service.captureBaseline(workspace);
    assert.equal(calls.includes("status"), false, "no git status before a turn");
    calls.length = 0;
    const saving = service.autoSaveTurn({
      workspacePath: workspace,
      baseline,
      changedPaths: ["report.md", "scratch/tmp.txt", "huge.bin", "gone.txt"].map((p) => path.join(workspace, p)),
      terminal: "turn.completed",
    });
    const saved = await saving;
    assert.equal(blockedDuringSave, false, "a turn save never refuses the next message");
    assert.equal(saved.saved, true);
    for (const scan of ["status", "trackedFiles"]) assert.equal(calls.includes(scan), false, `no ${scan} scan in a turn save`);
    const files = await real.treeFiles(workspace, saved.version.id);
    assert.deepEqual(files, ["report.md"], "only the turn's own file — not the 300 others, not the ignored one, not the oversized one");
    assert.deepEqual(saved.skippedFiles, ["huge.bin"], "an oversized file is skipped by name, not a failed save");
    fs.rmSync(path.join(workspace, "report.md"));
    const deleted = await service.autoSaveTurn({ workspacePath: workspace, baseline, changedPaths: [path.join(workspace, "report.md")], terminal: "turn.completed" });
    assert.equal(deleted.saved, true, "a deletion the turn made is versioned");
    assert.deepEqual(await real.treeFiles(workspace, deleted.version.id), []);
  } finally {
    removeWorkspace(workspace);
  }
}

async function testRestoreRollbackOnFailure() {
  const workspace = tempWorkspace();
  try {
    const service = new WorkspaceVersionService({writerLockPath:path.join(fs.realpathSync(workspace),".lily-work","writer.sqlite")});
    fs.writeFileSync(path.join(workspace, "report.txt"), "before\n");
    const first = await service.save(workspace);
    fs.writeFileSync(path.join(workspace, "report.txt"), "current\n");

    const realGit = service.git;
    let failRead = true;
    const failingGit = new Proxy(realGit, {
      get(target, property) {
        if (property === "readFile") {
          return async (...args) => {
            if (failRead) {
              failRead = false;
              throw new Error("INJECTED_READ_FAILURE");
            }
            return target.readFile(...args);
          };
        }
        const value = target[property];
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const guarded = new WorkspaceVersionService({ writerLockPath:path.join(fs.realpathSync(workspace),".lily-work","writer.sqlite"), git: failingGit });
    await assert.rejects(
      guarded.restore(workspace, first.version.id),
      (error) => error.message === "INJECTED_READ_FAILURE",
    );
    assert.equal(fs.readFileSync(path.join(workspace, "report.txt"), "utf8"), "current\n");
    assert.equal((await guarded.status(workspace)).unprotectedCount, 0);
  } finally {
    removeWorkspace(workspace);
  }

  const fallbackWorkspace = tempWorkspace();
  try {
    const fallback = new WorkspaceVersionService({ writerLockPath:path.join(fs.realpathSync(fallbackWorkspace),".lily-work","writer.sqlite"), git: { isAvailable: async () => false } });
    fs.writeFileSync(path.join(fallbackWorkspace, "broken.txt"), "safe\n");
    const version = await fallback.save(fallbackWorkspace);
    fs.writeFileSync(path.join(fallbackWorkspace, ".lily-work", "version-snapshots", version.version.id, "files", "broken.txt"), "tampered\n");
    await assert.rejects(
      fallback.restore(fallbackWorkspace, version.version.id),
      (error) => error.message === "VERSION_SNAPSHOT_CORRUPT",
    );
    assert.equal(fs.readFileSync(path.join(fallbackWorkspace, "broken.txt"), "utf8"), "safe\n");
  } finally {
    removeWorkspace(fallbackWorkspace);
  }
}

async function testProjectBusyGuard() {
  const idle = isProjectBusy({
    sessionManager: { listForProject: () => [{ id: "s1" }] },
    turnOrchestrator: { snapshot: () => ({ phase: "idle", queueLength: 0 }) },
  }, "p1");
  assert.equal(idle, false);
  const running = isProjectBusy({
    sessionManager: { listForProject: () => [{ id: "s1" }] },
    turnOrchestrator: { snapshot: () => ({ phase: "running", queueLength: 0 }) },
  }, "p1");
  assert.equal(running, true);
  const queued = isProjectBusy({
    sessionManager: { listForProject: () => [{ id: "s1" }] },
    turnOrchestrator: { snapshot: () => ({ phase: "idle", queueLength: 1 }) },
  }, "p1");
  assert.equal(queued, true);
  const versionMutation = isProjectBusy({
    projectManager: { find: () => ({ path: "/workspace" }) },
    workspaceVersionService: { isMutating: () => true },
    sessionManager: { listForProject: () => [] },
    turnOrchestrator: { snapshot: () => ({ phase: "idle", queueLength: 0 }) },
  }, "p1");
  assert.equal(versionMutation, true);
}

await testPolicy();
await testGitIsolationAndRestore();
await testAutomaticSaveAndLocalFallback();
await testGitBackendSupportsLargeWorkspace();
await testTurnSaveIsScoped();
await testRestoreRollbackOnFailure();
await testProjectBusyGuard();
console.log(`workspace-version-control: ok (${crypto.randomUUID().slice(0, 8)})`);
