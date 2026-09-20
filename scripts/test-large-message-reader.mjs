import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { setTimeout as delay } from "node:timers/promises";
const require = createRequire(import.meta.url);
const { MessageStore } = require("../src/main/store/message-store");
const { projectConversationForDisplay } = require("../src/main/conversation-display-projection");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lily-large-read-"));
const store = new MessageStore(path.join(dir, "messages.db"), path.join(dir, "blobs"));
const mb = Number(process.env.LILY_STRESS_MB || 128);
const records = Number(process.env.LILY_STRESS_RECORDS || 1);
assert.ok(Number.isInteger(records) && records > 0 && records <= 50);
assert.ok(Number.isInteger(mb) && mb >= records);
try {
  for (let i = 0; i < 1500; i++) store.append("stress", { id: `small-${i}`, role: "user", content: `request ${i}` });
  for (let r = 0; r < records; r++) store.append("stress", { id: `large-${r}`, role: "assistant", content: "Complete answer must survive", record: {
    assistantText: "Complete answer must survive", tools: [{ id: "t1", name: "read", result: "Tool evidence must survive" }],
    processEvents: Array.from({ length: Math.floor(mb / records) }, (_, i) => ({ summary: `step-${i}`, rawType: "process", event: { chunk: "x".repeat(1024 * 1024) } })),
  } });
  async function measure(name, read) {
    let last = performance.now(), lag = 0, ticks = 0;
    const timer = setInterval(() => { const now = performance.now(); lag = Math.max(lag, now - last); last = now; ticks++; }, 10);
    await delay(30);
    const start = performance.now();
    const result = await read();
    const elapsed = performance.now() - start;
    await delay(30); clearInterval(timer);
    console.log(JSON.stringify({ name, rawMiB: mb, records, elapsedMs: Math.round(elapsed), maxHeartbeatGapMs: Math.round(lag), ticks, resultBytes: Buffer.byteLength(JSON.stringify(result)) }));
    return { result, lag };
  }
  const baseline = await measure("sync-production-page", () => projectConversationForDisplay(store.getPage("stress", { limit: 50 }).conversation));
  assert.equal(baseline.result.at(-1).content, "Complete answer must survive");
  if (process.argv.includes("--baseline")) {
    console.log("baseline reproduced; no customer data touched");
  } else {
    const { MessageReadWorker } = require("../src/main/store/message-read-worker-client");
    const reader = new MessageReadWorker(store.db.filePath);
    try {
      const fixed = await measure("worker-production-page", async () => (await reader.page("stress", { limit: 50 })).conversation);
      assert.deepEqual(fixed.result, baseline.result, "same display semantics, not shortened answers/tools");
      assert.ok(fixed.lag < Math.max(200, baseline.lag * 0.5), `worker heartbeat ${fixed.lag} vs sync ${baseline.lag}`);
      assert.equal(store.getPage("stress", { limit: 1 }).conversation[0].record.processEvents[0].event.chunk.length, 1024 * 1024, "archive untouched");
      const pages = await Promise.all([reader.page("stress", { before: 1501, limit: 3 }), reader.page("empty")]);
      assert.deepEqual(pages[0], store.getPage("stress", { before: 1501, limit: 3 }));
      assert.deepEqual(pages[1], store.getPage("empty"));
      store.append("new", { id: "fresh", role: "user", content: "committed after worker opened" });
      assert.equal((await reader.page("new")).conversation[0].id, "fresh", "fresh WAL commits visible");
      const projected = await reader.page("stress", { limit: 1, workspacePath: dir });
      assert.ok(Array.isArray(projected.conversation[0].record.artifacts), "artifact derivation runs in worker");
      const waiting = reader.page("stress", { limit: 1 });
      const rejected = assert.rejects(waiting, /MESSAGE_READER_CLOSED/);
      await reader.close();
      await rejected;
      await assert.rejects(reader.page("stress"), /MESSAGE_READER_CLOSED/);
    } finally { await reader.close(); }
    const broken = new MessageReadWorker(path.join(dir, "absent.db"));
    try { await assert.rejects(broken.page("stress")); } finally { await broken.close(); }
    const cloneFailure = new MessageReadWorker(store.db.filePath);
    try {
      await assert.rejects(cloneFailure.page(() => {}), /clone/i);
      assert.equal((await cloneFailure.page("new")).conversation[0].id, "fresh", "dispatch failure does not wedge subsequent reads");
    } finally { await cloneFailure.close(); }
    store.append("recovery", { id: "poison-history", role: "assistant", content: "unrelated", turnId: "other" });
    store.db.run("UPDATE messages SET envelope_blob=? WHERE id=?", Buffer.from("invalid envelope"), "poison-history");
    store.append("recovery", { id: "target", role: "assistant", content: "Keep original", turnId: "wanted" });
    store.append("recovery", { id: "already-replaced", role: "assistant", turnId: "wanted", meta: { superseded: true } });
    assert.deepEqual(await store.getAssistantForTurnAsync("recovery", "wanted"), { id: "target" });
    assert.equal(await store.getAssistantForTurnAsync("another-session", "wanted"), null);
    store.append("recovery", { id: "original-user", role: "user", content: "Make a file", turnId: "wanted" });
    store.append("recovery", { id: "accepted-steer", role: "user", content: "Wait, do not write", turnId: "wanted", files: [{ path: "revision.txt" }], meta: { steer: true, steerSeq: 1 } });
    store.append("recovery", { id: "foreign-steer", role: "user", content: "WRONG TURN", turnId: "foreign", meta: { steer: true, steerSeq: 1 } });
    assert.deepEqual(await store.getTurnUserRevisionsAsync("recovery", "wanted"), [{ turnId: "wanted", steerSeq: 1, text: "Wait, do not write", files: [{ path: "revision.txt" }] }]);
    assert.deepEqual(await store.getTurnUserRevisionsAsync("another-session", "wanted"), []);
    const { TranscriptStore } = require("../src/main/transcript-store");
    const transcript = new TranscriptStore({
      getConversation() { throw new Error("Full history scan forbidden during recovery"); },
      getAssistantForTurnAsync: (...args) => store.getAssistantForTurnAsync(...args),
      updateMessageMeta: (_session, id, update) => store.updateById(id, message => ({ ...message, meta: update(message.meta || {}) })),
    });
    assert.equal((await transcript.supersedeAssistantTurn("recovery", "wanted", "replacement")).meta.supersededByTurnId, "replacement");
    assert.equal(await transcript.supersedeAssistantTurn("recovery", "wanted", "replacement"), null);
    assert.equal((await store.getPageAsync("new")).conversation[0].id, "fresh");
    await store.close();
    await assert.rejects(store.getPageAsync("new"), /MESSAGE_READER_CLOSED/);
  }
} finally {
  await store.close();
  fs.rmSync(dir, { recursive: true, force: true });
}
