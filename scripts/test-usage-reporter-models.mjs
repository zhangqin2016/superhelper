import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { createRequire } from "node:module";
import { test } from "node:test";
const file = new URL("../src/main/usage-reporter.js", import.meta.url);
const require = createRequire(file);
function fixture(send = async () => ({ ok: true })) {
  const local = [], reports = [];
  const mocks = {
    "./model-presets": { getActivePresetEnv: () => ({ LILY_MODEL: "global" }), getUserApiEnv: () => ({}) },
    "./agent-env": { normalizeToLilyEnv: x => x, pickModelId: x => x.LILY_MODEL },
    "./license-manager": { getLicenseStatus: () => ({}) },
    "./usage-local-store": { mergeSessionRecord: r => local.push(structuredClone(r)) },
    "./service-client": { reportUsage: r => { reports.push(structuredClone(r)); return send(r); } },
  };
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(file, "utf8"), { module, exports: module.exports, require: id => mocks[id] || require(id) });
  return { usage: module.exports, local, reports };
}

test("switching models keeps messages, tools and token totals in their own buckets", async () => {
  const { usage, reports } = fixture();
  for (const [model, tokens] of [["a", 100], ["b", 200]]) {
    usage.recordUserSend("s", [], { modelID: model, providerID: model });
    usage.recordToolCall("s", { name: "read" });
    usage.recordModelUsage("s", { inputTokens: tokens, outputTokens: 5 });
  }
  await usage.flush("s");
  assert.deepEqual(reports.map(r => [r.model, r.inputTokens, r.messageCount, r.toolCallCount]), [["a", 100, 1, 1], ["b", 200, 1, 1]]);
});

test("retrying a failed upload neither mixes new models nor counts local usage twice", async () => {
  let fail = true;
  const { usage, reports, local } = fixture(async () => ({ ok: !fail, error: fail ? "OFFLINE" : undefined }));
  usage.recordUserSend("s", [], "a");
  usage.recordModelUsage("s", { inputTokens: 100 });
  assert.equal((await usage.flush("s")).ok, false);
  assert.equal(usage.getPendingTodayTotals().inputTokens, 0, "failed uploads already exist in local history");
  usage.recordUserSend("s", [], "b");
  usage.recordModelUsage("s", { inputTokens: 200 });
  fail = false;
  assert.equal((await usage.flush("s")).ok, true);
  assert.equal(local.reduce((sum, r) => sum + r.inputTokens, 0), 300);
  assert.deepEqual(reports.map(r => r.model), ["a", "a", "b"]);
});

test("an overlapping flush waits then drains new usage without overwriting it", async () => {
  let release, started;
  const entered = new Promise(resolve => { started = resolve; });
  const { usage, reports } = fixture(async r => {
    if (r.model === "a") { started(); await new Promise(resolve => { release = resolve; }); }
    return { ok: true };
  });
  usage.recordUserSend("s", [], "a");
  usage.recordModelUsage("s", { inputTokens: 100 });
  const first = usage.flush("s");
  await entered;
  usage.recordUserSend("s", [], "b");
  usage.recordModelUsage("s", { inputTokens: 200 });
  const second = usage.flush("s");
  release();
  await first; await second;
  assert.deepEqual(reports.map(r => [r.model, r.inputTokens]), [["a", 100], ["b", 200]]);
  assert.equal(usage.getPendingTodayTotals().inputTokens, 0);
});

test("model-keyed runtime usage is preserved and malformed payloads are harmless", async () => {
  const { usage, reports } = fixture();
  usage.recordModelUsage("s", { a: { input_tokens: 10 }, b: { output_tokens: 20 } });
  assert.doesNotThrow(() => usage.recordModelUsage("s", null));
  await usage.flush("s");
  assert.deepEqual(reports.map(r => [r.model, r.inputTokens, r.outputTokens]), [["a", 10, 0], ["b", 0, 20]]);
});

test("read-only snapshots preserve model buckets, exclude flushed records and signal upload uncertainty", async () => {
  let release, entered;
  const started = new Promise(resolve => { entered = resolve; });
  let first = true;
  const { usage } = fixture(async () => {
    if (first) { first = false; entered(); await new Promise(resolve => { release = resolve; }); }
    return { ok: true };
  });
  assert.equal(typeof usage.getPendingUsageSnapshot, "function");
  const empty = usage.getPendingUsageSnapshot();
  usage.recordModelUsage("s", { inputTokens: 120 }, { providerID: "one", modelID: "same" });
  usage.recordModelUsage("s", { inputTokens: 80 }, { providerID: "two", modelID: "same" });
  const snapshot = usage.getPendingUsageSnapshot();
  assert.equal(snapshot.records.length, 2);
  assert.ok(snapshot.revision > empty.revision);
  snapshot.records[0].inputTokens = 999;
  assert.equal(usage.getPendingUsageSnapshot().records[0].inputTokens, 120, "snapshots cannot mutate reporter state");
  const flushing = usage.flush("s");
  await started;
  const during = usage.getPendingUsageSnapshot();
  assert.equal(during.records.length, 0, "persisted records must not be added to local twice");
  assert.equal(during.unconfirmedReports, true);
  release();
  await flushing;
  assert.equal(usage.getPendingUsageSnapshot().unconfirmedReports, false);
  assert.ok(usage.getPendingUsageSnapshot().revision > snapshot.revision);
});
