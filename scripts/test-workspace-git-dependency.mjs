#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { WorkspaceGit } = await import(path.join(root, "src/main/workspace-git.js"));

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "lily-git-dependency-"));
try {
  const packDir = path.join(temp, "git-pack");
  const binDir = path.join(packDir, "bin");
  fs.mkdirSync(binDir, { recursive: true });
  const fakeGit = path.join(binDir, process.platform === "win32" ? "git.cmd" : "git");
  fs.writeFileSync(
    fakeGit,
    process.platform === "win32" ? "@echo git version 2.50.0\r\n" : "#!/bin/sh\necho git version 2.50.0\n",
    { mode: 0o755 },
  );

  let installCalls = 0;
  const workspaceGit = new WorkspaceGit({
    gitPath: path.join(temp, "missing-git"),
    systemGitPath: null,
    runtimePackDirs: async () => [],
    installRuntimePack: async (id) => {
      installCalls += 1;
      assert.equal(id, "git");
      return { ok: true, id, path: packDir };
    },
  });

  assert.equal(await workspaceGit.isAvailable(), true);
  assert.equal(workspaceGit.gitPath, fakeGit);
  assert.equal(installCalls, 1);
  assert.equal(await workspaceGit.isAvailable(), true);
  assert.equal(installCalls, 1, "availability should be cached after a successful install");
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}

console.log("workspace-git-dependency: ok");
