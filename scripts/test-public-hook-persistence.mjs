#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { openDatabase } = require("../src/main/store/sqlite-db.js");
const { createPublicHookRuntime } = require("../src/main/public-hooks.js");
const { PublicHookConfigStore, createPublicHookExecutors } = require("../src/main/public-hook-config.js");
const { PublicHookAuditStore, migratePublicHookSchema } = require("../src/main/store/public-hook-store.js");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lily-public-hooks-"));
const db = openDatabase(":memory:");
try {
  migratePublicHookSchema(db);
  const auditStore = new PublicHookAuditStore(db);
  const audits = [];
  const runtime = createPublicHookRuntime({
    executors: createPublicHookExecutors(),
    emitAudit: (event) => { audits.push(event); auditStore.record(event); },
  });
  const declaration = {
    id: "command-check",
    event: "turn.before_dispatch",
    type: "command",
    mode: "security",
    canMutate: true,
    timeoutMs: 5_000,
    config: {
      command: [process.execPath, "-e", "process.stdin.resume();process.stdin.on('end',()=>console.log(JSON.stringify({allow:true,contextAppend:'checked'})))"],
    },
  };
  const hook = runtime.register(declaration);
  const result = await runtime.run("turn.before_dispatch", { sessionId: "s1", turnId: "t1", apiKey: "secret" });
  assert.equal(result.allow, true);
  assert.equal(result.contextAppend, "checked");
  assert.ok(audits.every((event) => JSON.stringify(event).includes("secret") === false), "audit never contains secret values");
  assert.equal(auditStore.list("s1").length, 1, "start and completion update one durable execution row");
  assert.equal(auditStore.list("s1")[0].type, "hook.completed");

  const configStore = new PublicHookConfigStore(path.join(dir, "public-hooks.json"));
  configStore.upsert(hook);
  assert.equal(configStore.load()[0].id, hook.id);
  assert.equal(configStore.remove(hook.id), true);
  assert.deepEqual(configStore.load(), []);

  const failingRuntime = createPublicHookRuntime({ executors: createPublicHookExecutors() });
  failingRuntime.register({
    id: "missing-command",
    event: "turn.before_dispatch",
    type: "command",
    mode: "security",
    canMutate: true,
    timeoutMs: 1_000,
    config: { command: [path.join(dir, "does-not-exist")] },
  });
  const failed = await failingRuntime.run("turn.before_dispatch", { sessionId: "s1", turnId: "t2" });
  assert.equal(failed.allow, false, "spawn failure settles once as a fail-closed security decision");
} finally {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log("public-hook-persistence: ok");
