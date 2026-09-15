#!/usr/bin/env node
// Compaction continuity: after an in-turn auto-compaction the engine's new user
// message carries no `system`, so every later step lost Lily's per-turn guidance
// and the turn's own request/acceptance sat in the summarized head. The plugin
// re-attaches guidance (memory, then the on-disk handoff) plus a bounded task
// anchor to the compaction message once its summary exists, restores pruned
// question/todo outputs on copies, and feeds the anchor to the summarizer.
// Closed loop with the real exporter. [gate: task-completion-integrity]
// Run: node scripts/test-compaction-continuity-plugin.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { CompactionContinuityPlugin, buildAnchorText } from "../resources/opencode-plugins/compaction-continuity.js";

const require = createRequire(import.meta.url);
const { writeCompactionMemoryFile } = require("../src/main/compaction-memory-export.js");
const { buildCompactionAnchor } = require("../src/main/compaction-anchor.js");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lily-compaction-continuity-"));
process.env.LILY_COMPACTION_MEMORY_DIR = dir;

let checks = 0;
async function check(name, fn) { await fn(); checks += 1; console.log(`ok - ${name}`); }

const SES = "ses_long1";
const GUIDE = "GUIDE-SENTINEL: use lily_tool_broker; never claim done without a receipt.";
function user(id, created, extra = {}, parts = [{ type: "text", text: "hi" }]) {
  return { info: { id, role: "user", sessionID: SES, time: { created }, ...extra }, parts };
}
function assistant(id, created, parentID, extra = {}, parts = [{ type: "text", text: "ok" }]) {
  return { info: { id, role: "assistant", sessionID: SES, parentID, time: { created }, ...extra }, parts };
}
const compactionUser = (id, created) => user(id, created, {}, [{ type: "compaction", auto: true }]);

// Real exporter writes the v2 handoff with the turn anchor and guidance.
const anchor = buildCompactionAnchor({
  taskCore: { contract: { objective: "把 harbor 三个镜像导出为离线 tar 并校验", acceptanceCriteria: ["tar 结构可 docker load", "RepoTags 正确"], requestedDeliverables: ["dist/images.tar"] } },
}, "把 harbor 三个镜像导出为离线 tar 并校验，输出到 dist/");
assert.equal(anchor.request.startsWith("把 harbor"), true);
assert.deepEqual(anchor.successCriteria, ["tar 结构可 docker load", "RepoTags 正确"]);
writeCompactionMemoryFile(dir, SES, { pendingTask: "导出镜像" }, { anchor, guidance: "DISK-GUIDE fallback" });
const written = JSON.parse(fs.readFileSync(path.join(dir, `${SES}.json`), "utf8"));
assert.equal(written.schemaVersion, 2);
assert.equal(written.anchor.request, anchor.request);
assert.equal(written.guidance, "DISK-GUIDE fallback");

try {
  const hooks = await CompactionContinuityPlugin();
  const transform = hooks["experimental.chat.messages.transform"];
  const after = hooks["tool.execute.after"];
  const compacting = hooks["experimental.session.compacting"];

  await check("the summarizer's own call (head only, no compaction message) is left lean but remembers the guidance", async () => {
    const messages = [user("u1", 10, { system: GUIDE }), assistant("a1", 11, "u1")];
    await transform({}, { messages });
    assert.equal(messages[0].info.system, GUIDE);
    assert.equal(messages.length, 2);
  });

  await check("a compaction message whose summary is still pending is not touched", async () => {
    const compaction = compactionUser("u2", 20);
    const messages = [user("u1", 10, { system: GUIDE }), assistant("a1", 11, "u1"), compaction];
    await transform({}, { messages });
    assert.equal(compaction.info.system, undefined);
  });

  await check("after the summary exists the compaction message gets guidance + task anchor + live todos, set on the SAME info object", async () => {
    await after({ tool: "todowrite", sessionID: SES, callID: "c-todo", args: { todos: [
      { content: "导出 safar-agent", status: "completed" }, { content: "导出 safar-rag", status: "in_progress" }, { content: "校验 tar", status: "pending" },
    ] } }, { output: "todos updated" });
    const compaction = compactionUser("u2", 20);
    const info = compaction.info;
    const messages = [compaction, assistant("sum", 21, "u2", { summary: true }, [{ type: "text", text: "## Objective …" }])];
    await transform({}, { messages });
    assert.equal(messages[0].info, info, "the engine's lastUser reference must see the change");
    assert.match(info.system, /GUIDE-SENTINEL/);
    assert.match(info.system, /Lily task anchor/);
    assert.match(info.system, /原始请求：把 harbor/);
    assert.match(info.system, /验收标准：\n- tar 结构可 docker load/);
    assert.match(info.system, /\[x\] 导出 safar-agent/);
    assert.match(info.system, /\[~\] 导出 safar-rag/);
    assert.match(info.system, /\[ \] 校验 tar/);
    assert.doesNotMatch(info.system, /DISK-GUIDE/, "memory wins over the disk fallback");
  });

  await check("a session this serve never saw guidance for (e.g. after a serve restart) falls back to the on-disk guidance", async () => {
    const FRESH = "ses_fresh";
    writeCompactionMemoryFile(dir, FRESH, null, { anchor, guidance: "DISK-GUIDE fallback" });
    const compaction = { info: { id: "u3", role: "user", sessionID: FRESH, time: { created: 30 } }, parts: [{ type: "compaction" }] };
    const summary = { info: { id: "sum3", role: "assistant", sessionID: FRESH, parentID: "u3", summary: true, time: { created: 31 } }, parts: [] };
    await transform({}, { messages: [compaction, summary] });
    assert.match(compaction.info.system, /DISK-GUIDE fallback/);
    assert.match(compaction.info.system, /原始请求/);
  });

  await check("an existing system on the compaction message is never overwritten", async () => {
    const compaction = compactionUser("u4", 40);
    compaction.info.system = "KEEP";
    await transform({}, { messages: [compaction, assistant("sum4", 41, "u4", { summary: true })] });
    assert.equal(compaction.info.system, "KEEP");
  });

  await check("pruned question/todowrite outputs are restored from the cache on COPIES; other tools untouched", async () => {
    await after({ tool: "question", sessionID: SES, callID: "c-q1", args: {} }, { output: "用户回答：用 arm64，不要 x64" });
    const prunedQ = { type: "tool", tool: "question", callID: "c-q1", state: { status: "completed", output: "", time: { start: 1, end: 2, compacted: 3 } } };
    const prunedBash = { type: "tool", tool: "bash", callID: "c-b1", state: { status: "completed", output: "", time: { start: 1, end: 2, compacted: 3 } } };
    const original = assistant("a9", 50, "u1", {}, [prunedQ, prunedBash]);
    const messages = [user("u1", 10, { system: GUIDE }), original];
    await transform({}, { messages });
    assert.notEqual(messages[1], original, "message wrapper is copied");
    assert.equal(original.parts[0].state.output, "", "live part object untouched");
    assert.equal(original.parts[0].state.time.compacted, 3);
    assert.equal(messages[1].parts[0].state.output, "用户回答：用 arm64，不要 x64");
    assert.equal(messages[1].parts[0].state.time.compacted, undefined);
    assert.equal(messages[1].parts[1], prunedBash, "unprotected tools keep the engine's pruning");
  });

  await check("the compaction prompt receives the anchor + todos appended after other context", async () => {
    const output = { context: ["memory-block"], prompt: undefined };
    await compacting({ sessionID: SES }, output);
    assert.equal(output.context[0], "memory-block");
    assert.match(output.context[1], /Objective 必须原样保留原始请求/);
    assert.match(output.context[1], /原始请求：把 harbor/);
    assert.match(output.context[1], /\[~\] 导出 safar-rag/);
    assert.equal(output.prompt, undefined, "never replaces the engine prompt");
    const none = { context: [] };
    await compacting({ sessionID: "ses_unknown" }, none);
    assert.deepEqual(none.context, []);
  });

  await check("anchor text is bounded and the kill switch makes every hook a no-op", async () => {
    const huge = buildAnchorText({ request: "x".repeat(5000), successCriteria: Array.from({ length: 20 }, (_, i) => `c${i}`.repeat(50)) }, null);
    assert.ok(huge.length <= 1400);
    process.env.LILY_COMPACTION_CONTINUITY = "0";
    const compaction = compactionUser("u5", 60);
    await transform({}, { messages: [compaction, assistant("sum5", 61, "u5", { summary: true })] });
    assert.equal(compaction.info.system, undefined);
    const output = { context: [] };
    await compacting({ sessionID: SES }, output);
    assert.deepEqual(output.context, []);
    delete process.env.LILY_COMPACTION_CONTINUITY;
  });

  await check("malformed input never throws", async () => {
    await transform({}, null);
    await transform({}, { messages: [null, { info: null }, { info: { role: "user" } }] });
    await after(null, null);
    await compacting(null, null);
    fs.writeFileSync(path.join(dir, "ses_bad.json"), "{not json");
    const compaction = { info: { id: "u6", role: "user", sessionID: "ses_bad", time: { created: 1 } }, parts: [{ type: "compaction" }] };
    await transform({}, { messages: [compaction, assistant("s6", 2, "u6", { summary: true })] });
  });

  await check("Lily wires it: plugin registered after compaction-memory, the anchor rides the engine payload, nudges carry guidance", async () => {
    const pool = fs.readFileSync(new URL("../src/main/session-runner-pool.js", import.meta.url), "utf8");
    assert.match(pool, /"compaction-memory\.js", "compaction-continuity\.js"/);
    const orchestrator = fs.readFileSync(new URL("../src/main/turn-orchestrator.js", import.meta.url), "utf8");
    assert.match(orchestrator, /compactionAnchor: require\("\.\/compaction-anchor"\)\.buildCompactionAnchor\(state, rawUserText\)/);
    const session = fs.readFileSync(new URL("../src/main/opencode-agent-session.js", import.meta.url), "utf8");
    assert.match(session, /_refreshCompactionMemory\(server, payload\)/);
    assert.equal((session.match(/sendPrompt\(\{ text: note, files: \[\], guidance: this\.spawnOptions\?\.guidance \|\| "" \}\)/g) || []).length, 2, "both bare nudges now carry guidance");
    assert.doesNotMatch(session, /sendPrompt\(\{ text: note, files: \[\] \}\)/);
    const gate = fs.readFileSync(new URL("../src/main/required-tool-completion-gate.js", import.meta.url), "utf8");
    assert.match(gate, /guidance: session\.spawnOptions\?\.guidance/);
  });

  console.log(`\n${checks} checks passed (compaction continuity plugin)`);
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
