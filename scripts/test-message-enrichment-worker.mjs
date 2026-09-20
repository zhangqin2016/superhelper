import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { DatabaseSync } from "node:sqlite";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { MessageStore } = require("../src/main/store/message-store");
const { enrichRow, run } = require("../src/main/store/message-enrichment-worker");
const { applyEnrichmentCommit } = require("../src/main/store/message-enrichment-commit");
const { ARTIFACT_SCHEMA_VERSION: artifact, RESULT_BLOCK_SCHEMA_VERSION: resultBlock } = require("../src/main/session-artifact-backfill");
const { flagKey, cursorKey } = require("../src/main/session-enrichment");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "lily-enrichment-worker-"));
const filePath = path.join(root, "messages.db");
const store = new MessageStore(filePath, path.join(root, "blobs"));
const db = new DatabaseSync(filePath);
const versions = { artifact, resultBlock };
const row = id => db.prepare("SELECT * FROM messages WHERE id=?").get(id);
const message = id => ({ id, role: "assistant", content: "Retain complete answer", record: { tools: [{ name: "read", result: "Retain full evidence" }] } });
try {
  store.append("race", message("race"));
  assert.throws(() => enrichRow(db, row("race"), root, () => {
    store.updateById("race", current => ({ ...current, content: "Concurrent live edit" }));
  }), /CONCURRENT_CHANGE/);
  assert.equal(store.getById("race").content, "Concurrent live edit");
  store.append("deleted", message("deleted"));
  assert.throws(() => enrichRow(db, row("deleted"), root, () => store.removeLast("deleted")), /CONCURRENT_CHANGE/);
  assert.equal(store.getById("deleted"), null, "cannot resurrect deleted history");
  const large = message("large");
  large.record.processEvents = Array.from({ length: 128 }, () => ({ event: { chunk: "x".repeat(1024 * 1024) } }));
  store.append("large", large);
  const before = row("large");
  let last = performance.now(), maxGap = 0;
  const timer = setInterval(() => { const now = performance.now(); maxGap = Math.max(maxGap, now - last); last = now; }, 10);
  let worker;
  try {
    const summary = await new Promise((resolve, reject) => {
      let terminal;
      worker = new Worker(path.resolve("src/main/store/message-enrichment-worker.js"), { workerData: {
        filePath, versions, sessions: [{ id: "large", workspacePath: root }],
      } });
      worker.on("message", event => {
        if (event.type === "commit") {
          try { worker.postMessage({ commitId: event.commitId, result: applyEnrichmentCommit(store.db.raw, event.change) }); }
          catch (error) { worker.postMessage({ commitId: event.commitId, error: { message: error.message, code: error.code } }); }
          return;
        }
        if (event.type === "error" || event.type === "warning") reject(new Error(event.error));
        if (event.type === "done") terminal = event;
      });
      worker.on("error", reject);
      worker.on("exit", code => code || !terminal ? reject(new Error(`worker exit ${code}`)) : resolve(terminal));
    });
    assert.equal(summary.enriched, 1);
  } finally { clearInterval(timer); await worker?.terminate(); }
  console.log(JSON.stringify({ name: "enrichment-worker", rawMiB: 128, maxHeartbeatGapMs: Math.round(maxGap) }));
  assert.ok(maxGap < 200, `main-thread gap ${maxGap}`);
  const after = row("large");
  assert.deepEqual({ ...after, envelope_blob: null }, { ...before, envelope_blob: null }, "hot columns unchanged");
  const result = store.getById("large");
  assert.equal(result.record.artifactSchemaVersion, artifact);
  assert.deepEqual(result.record.processEvents, large.record.processEvents, "raw diagnostic history unchanged");
  assert.deepEqual(result.record.tools, large.record.tools, "tool evidence unchanged");
  assert.equal(result.content, large.content);
  assert.ok(store.meta(flagKey("large", versions)));
  assert.equal(store.meta(cursorKey("large", versions)), null);
  assert.equal(store.search("Retain").some(hit => hit.id === "large"), true, "FTS still works");
  assert.equal((await run({ filePath, versions, sessions: [{ id: "large", workspacePath: root }] }, () => {})).scanned, 0, "completed history is not rewritten on restart");
  store.append("resume", message("before-cursor"));
  store.append("resume", message("corrupt"));
  store.append("resume", message("after-corrupt"));
  store.setMeta(cursorKey("resume", versions), "1");
  store.db.run("UPDATE messages SET envelope_blob=? WHERE id=?", Buffer.from("not gzip"), "corrupt");
  const resumed = await run({ filePath, versions, sessions: [{ id: "resume", workspacePath: root }] }, () => {});
  assert.equal(resumed.scanned, 2);
  assert.equal(resumed.skipped, 1);
  assert.equal(resumed.enriched, 1, "one corrupt row does not prevent remaining records being enriched");
  assert.equal(store.getById("before-cursor").record.artifactSchemaVersion, undefined, "resume does not restart at zero");
  for (let i = 0; i < 30; i++) store.append("concurrent", message(`concurrent-${i}`));
  const { startEnrichmentWorker } = require("../src/main/session-enrichment-worker-host");
  let foregroundWrites = 0, foregroundError, controller, timeout;
  const tick = setInterval(() => {
    try {
      store.db.transaction(() => {
        const value = Number(store.meta("foreground-admission") || 0);
        // Deliberately keep a read transaction open before upgrading to write.
        // An independent background writer causes SQLITE_BUSY_SNAPSHOT here.
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
        store.setMeta("foreground-admission", String(value + 1));
      })();
      foregroundWrites++;
    } catch (error) { foregroundError = error; }
  }, 2);
  try {
    await new Promise((resolve, reject) => {
      timeout = setTimeout(() => reject(new Error("enrichment host did not complete")), 30000);
      controller = startEnrichmentWorker({ store, sessions: [{ id: "concurrent" }], versions,
        workspacePathFor: () => root, onProgress: event => { if (event.phase === "done") resolve(); },
      });
    });
    assert.equal(foregroundError, undefined, "background derivation must not race foreground read/write transactions");
    assert.ok(foregroundWrites > 5);
    assert.equal(store.getById("concurrent-29").record.artifactSchemaVersion, artifact);
  } finally { clearInterval(tick); clearTimeout(timeout); await controller?.stop(); }
  console.log("message-enrichment-worker: ok");
} finally {
  db.close();
  await store.close();
  fs.rmSync(root, { recursive: true, force: true });
}
