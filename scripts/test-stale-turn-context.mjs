#!/usr/bin/env node
// An earlier turn's instructions do not follow the conversation forward
// (2026-09-28 audit): the task contract rode every user message into history —
// one field session carried 22 copies (~230K chars) — and a later turn still
// read an earlier turn's "This is a separate task … prior conversation is
// background only". History keeps the request, the attachment provenance and
// the extracted content; the current turn keeps everything.
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { buildTaskContract, withTaskContractPrefix } = require("../src/main/task-contract.js");
const { withAttachmentManifest } = require("../src/main/turn-user-context.js");
const { addLayersToEngineText } = require("../src/main/engine-message-layers.js");
const { StaleTurnContextPlugin } = await import("../resources/opencode-plugins/stale-turn-context.js");
const layers = require("../resources/opencode-plugins/lib/stale-turn-layers.cjs");

// Real engine text, as the orchestrator builds it.
function engineText(userText, files = []) {
  let text = withTaskContractPrefix(userText, buildTaskContract({ text: userText, files, project: { path: process.cwd() } }));
  if (files.length) text = addLayersToEngineText(text, { extractedContext: "报价单：设备 A 单价 52800 元/台" });
  text = addLayersToEngineText(text, { platformContext: "[Lily Memory Context]\nLast user intent: 旧任务的输出目录 output/old-task" });
  return withAttachmentManifest(text, files);
}
const user = (text, extra = {}) => ({ info: { role: "user" }, parts: [{ type: "text", text, ...extra }] });
const assistant = (text) => ({ info: { role: "assistant" }, parts: [{ type: "text", text }] });

const first = engineText("修复登录bug并跑测试", [{ name: "quote.pdf", path: "/tmp/quote.pdf" }]);
const second = engineText("再加一个回归测试");
assert.match(first, /<lily_task_contract>/, "fixture: the earlier message carries a contract");
assert.match(second, /<lily_task_contract>/, "fixture: the current message carries a contract");

const hooks = await StaleTurnContextPlugin();
const transform = hooks["experimental.chat.messages.transform"];
const messages = () => [
  user(first),
  assistant("已修复并通过测试。"),
  user(second),
  // A platform prompt inside the current turn carries no layers.
  user("Task continuity check: the native todo list still has unfinished todo items.", { synthetic: true }),
];

{
  const msgs = messages();
  await transform({}, { messages: msgs });
  const stale = msgs[0].parts[0].text;
  assert.doesNotMatch(stale, /<lily_task_contract>|execution_constraints/, "an earlier turn's contract does not reach later calls");
  assert.doesNotMatch(stale, /Lily Memory Context|output\/old-task/, "nor its injected memory context");
  assert.match(stale, /修复登录bug并跑测试/, "the user's request is kept");
  assert.match(stale, /Attachment provenance for THIS user message[\s\S]*quote\.pdf/, "what was attached is kept");
  assert.match(stale, /52800 元\/台/, "the extracted content — evidence a later turn may cite — is kept");
  assert.ok(stale.length < first.length / 3, `history shrinks to what is true about it: ${first.length} -> ${stale.length}`);
  assert.equal(msgs[2].parts[0].text, second, "the current turn's request is untouched");
  assert.equal(msgs[3].parts[0].text.startsWith("Task continuity check"), true, "a platform prompt in the same turn is untouched");
}

// A steer ("插话") and an internal recovery continuation belong to the RUNNING
// turn: the turn's own contract must stay whole while they are the latest
// messages. Steer is on by default, so a plain mid-turn remark used to strip
// the running turn's contract (2026-09-28 re-review). A bare "谢谢" turn opens
// nothing, so the earlier request stays whole — the pre-plugin behaviour.
{
  const { applyInternalRecoveryLayer } = require("../src/main/turn-recovery-context.js");
  const steer = withAttachmentManifest("顺便把日志也看一下", []);
  const recovery = applyInternalRecoveryLayer(withAttachmentManifest("继续", []), { kind: "tool_call_continuation", guidance: "Continue from the last completed step." });
  const thanks = withAttachmentManifest("谢谢", []);
  assert.equal(layers.isLayeredRequest(steer), true, "fixture: a steer is layered text too");
  for (const [label, latest] of [["steer", steer], ["recovery continuation", recovery], ["bare thanks", thanks]]) {
    const msgs = [user(first), assistant("已修复。"), user(second), assistant("正在写测试…"), user(latest)];
    await transform({}, { messages: msgs });
    assert.equal(msgs[2].parts[0].text, second, `after a ${label}, the running turn keeps its whole contract`);
    assert.doesNotMatch(msgs[0].parts[0].text, /<lily_task_contract>/, `and the earlier turn is still reduced (${label})`);
    assert.equal(msgs[4].parts[0].text, latest, `the ${label} itself is untouched`);
  }
  assert.equal(layers.opensTurn(second), true, "a real request opens a turn");
  assert.equal(layers.opensTurn(steer), false, "a steer does not");
  assert.equal(layers.opensTurn(recovery), false, "a recovery continuation does not");
}

// A follow-up that names no task of its own ("按这个方案做", "全部实施") carries
// no contract, so it continues the task in progress: that task's contract
// stays whole. In the field engine DB 347 of 1021 follow-ups came right after a
// specific task (code change, release, UI…) this way (2026-09-29 re-review).
{
  for (const followUp of ["按这个方案做", "全部实施。不要中断", "这个任务还没完成"]) {
    const latest = engineText(followUp);
    assert.equal(layers.opensTurn(latest), false, `"${followUp}" does not open a new task`);
    const msgs = [user(first), assistant("方案：先改校验，再补测试。"), user(latest)];
    await transform({}, { messages: msgs });
    assert.equal(msgs[0].parts[0].text, first, `after "${followUp}", the task in progress keeps its whole contract`);
  }
}

// Deterministic: a message strips identically on every later call, so the
// provider's cached prefix stays stable.
{
  const once = layers.stripStaleTurnLayers(first);
  assert.equal(layers.stripStaleTurnLayers(once), once, "stripping is idempotent");
  assert.equal(layers.stripStaleTurnLayers(first), once, "and deterministic");
  assert.equal(layers.stripStaleTurnLayers("plain text without layers"), "plain text without layers", "unlayered text is unchanged");
}

// A single turn is never touched; the kill switch restores the old history.
{
  const single = [user(second)];
  await transform({}, { messages: single });
  assert.equal(single[0].parts[0].text, second, "the only request is the current one");
  process.env.LILY_STALE_TURN_CONTEXT = "0";
  const msgs = messages();
  await transform({}, { messages: msgs });
  assert.equal(msgs[0].parts[0].text, first, "LILY_STALE_TURN_CONTEXT=0 leaves history exactly as stored");
  delete process.env.LILY_STALE_TURN_CONTEXT;
  await transform({}, null);
  await transform({}, { messages: [null, {}, { info: { role: "user" }, parts: [null] }] });
}

const fs = await import("node:fs");
const pool = fs.readFileSync(new URL("../src/main/session-runner-pool.js", import.meta.url), "utf8");
assert.match(pool, /"stale-turn-context\.js", "context-window-guard\.js"/, "registered, and ahead of the guard so it measures the stripped history");

console.log("stale-turn-context: ok");
