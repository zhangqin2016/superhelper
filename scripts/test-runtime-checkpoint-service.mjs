#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { openDatabase } = require("../src/main/store/sqlite-db.js");
const { RuntimeCheckpointStore, migrateRuntimeCheckpointSchema } = require("../src/main/store/runtime-checkpoint-store.js");
const { RuntimeCheckpointService } = require("../src/main/runtime-checkpoint-service.js");
const { checkpointHash } = require("../src/main/runtime-checkpoint.js");

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "lily-checkpoint-service-"));
const filePath = path.join(workspace, "report.txt");
fs.writeFileSync(filePath, "checkpoint content");
const db = openDatabase(":memory:");

try {
  migrateRuntimeCheckpointSchema(db);
  let clock = 100;
  const store = new RuntimeCheckpointStore(db, { now: () => ++clock });
  const emitted = [];
  let graphState = { id: "graph-1", revision: 1 };
  let forkInput = null;
  const service = new RuntimeCheckpointService({
    store,
    now: () => ++clock,
    emit: (type, payload) => emitted.push([type, payload]),
    revertEngine: async () => true,
    unrevertEngine: async () => true,
    rewindSession: async () => true,
    createForkSession: async (input) => {
      forkInput = input;
      return { id: "fork-session", title: "Fork" };
    },
    captureComponent: async (component) => ({ ...component, hash: checkpointHash(graphState), payload: graphState }),
    restoreComponent: async (component) => { graphState = component.payload; },
  });
  const checkpoint = await service.create({
    id: "cp-files",
    sessionId: "s1",
    turnId: "t1",
    engineMessageId: "m1",
    workspacePath: workspace,
    filePaths: [filePath],
    extraComponents: [{ type: "agent_task_graph", refId: "graph-1", version: 1, reversible: true, hash: checkpointHash(graphState), payload: graphState }],
  });
  assert.equal(checkpoint.status, "committed");
  assert.equal(store.componentData(checkpoint.id, "s1")[0].payloadAvailable, true);

  fs.writeFileSync(filePath, "later content");
  graphState = { id: "graph-1", revision: 2 };
  const restored = await service.restore({ checkpointId: checkpoint.id, sessionId: "s1", workspacePath: workspace });
  assert.equal(fs.readFileSync(filePath, "utf8"), "checkpoint content");
  assert.equal(graphState.revision, 1);
  assert.ok(restored.safetyCheckpointId);
  assert.ok(emitted.some(([type]) => type === "checkpoint.restore.completed"));

  const forked = await service.fork({ checkpointId: checkpoint.id, sessionId: "s1" });
  assert.equal(forked.session.id, "fork-session");
  assert.equal(forkInput.checkpoint.engineMessageId, "m1", "fork adapter receives the native engine boundary");
  assert.equal(store.componentData(forked.checkpoint.id, "fork-session")[0].payloadAvailable, true, "fork keeps immutable component data");

  fs.writeFileSync(filePath, "before failed restore");
  const failing = new RuntimeCheckpointService({
    store,
    now: () => ++clock,
    revertEngine: async () => true,
    unrevertEngine: async () => true,
    rewindSession: async () => { throw new Error("session rewind failed"); },
    captureComponent: async (component) => ({ ...component, hash: checkpointHash(graphState), payload: graphState }),
    restoreComponent: async (component) => { graphState = component.payload; },
  });
  await assert.rejects(
    () => failing.restore({ checkpointId: checkpoint.id, sessionId: "s1", workspacePath: workspace }),
    /session rewind failed/,
  );
  assert.equal(fs.readFileSync(filePath, "utf8"), "before failed restore", "failed restore rolls files back to safety checkpoint");
  await assert.rejects(
    () => service.create({ sessionId: "s1", turnId: "t2", workspacePath: workspace, filePaths: [path.join(workspace, "..", "outside.txt")] }),
    /RUNTIME_CHECKPOINT_PATH_OUTSIDE_WORKSPACE/,
  );
} finally {
  db.close();
  fs.rmSync(workspace, { recursive: true, force: true });
}

console.log("runtime-checkpoint-service: ok");
