#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { openDatabase } = require("../src/main/store/sqlite-db.js");
const { createRuntimeIdentityRegistry } = require("../src/main/runtime-identity-registry.js");
const { RuntimeCheckpointStore, migrateRuntimeCheckpointSchema } = require("../src/main/store/runtime-checkpoint-store.js");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lily-runtime-recovery-"));
const db = openDatabase(":memory:");
try {
  migrateRuntimeCheckpointSchema(db);
  const first = new RuntimeCheckpointStore(db, { now: () => 10 });
  const prepared = first.prepare({
    id: "crash-boundary",
    sessionId: "s1",
    turnId: "t1",
    kind: "turn",
    components: [{ type: "files", refId: "diff-1", version: 1, hash: "f".repeat(64), reversible: true }],
    createdAt: 10,
  });
  assert.equal(first.get(prepared.id, "s1").status, "preparing", "crash before commit is never restorable");

  const restarted = new RuntimeCheckpointStore(db, { now: () => 20 });
  assert.throws(() => restarted.beginRestore(prepared.id, "s1"), /RUNTIME_CHECKPOINT_NOT_COMMITTED/);
  restarted.commit(prepared.id, "s1", prepared.integrityHash);
  assert.equal(restarted.beginRestore(prepared.id, "s1", { id: "restore-after-restart", createdAt: 21 }).restore.status, "restoring");

  const filePath = path.join(dir, "identity.json");
  const registryA = createRuntimeIdentityRegistry({ filePath, now: () => 10 });
  registryA.grant({ engineSessionId: "engine-1", token: "token-1", sessionId: "s1", nonce: "n1", expiresAt: 100 });
  const registryB = createRuntimeIdentityRegistry({ filePath, now: () => 20 });
  assert.equal(registryB.resolve("engine-1"), "token-1", "restart recovers active grants");
  registryB.revoke("engine-1", "restart cleanup");
  assert.equal(registryA.resolve("engine-1"), "", "revocation is immediately visible to an older process view");
  assert.equal(registryA.isRevoked("n1"), true);
} finally {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log("agent-runtime-recovery: ok");
