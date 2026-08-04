#!/usr/bin/env node
/**
 * OpenCode runtime reducer contract. Server SSE events (envelope
 * {id,type,properties}) must reduce directly into Lily runtime drafts and
 * host-side effects. This replaces the old Claude-style action adapter.
 */
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const {
  OPENCODE_RUNTIME_CAPABILITIES,
  createOpencodeRuntimeState,
  reduceOpencodeRuntimeEvent,
  resetOpencodeRuntimeState,
} = require("../src/main/runtime/opencode-runtime-reducer.js");

function assert(cond, msg) { if (!cond) throw new Error(msg); }
const ev = (type, properties) => ({ id: "evt_x", type, properties });
function reduce(type, properties, state) {
  return reduceOpencodeRuntimeEvent(ev(type, properties), state);
}
function oneDraft(type, properties, state) {
  const result = reduce(type, properties, state);
  if (result.drafts.length !== 1) {
    throw new Error(`expected 1 draft for ${type}, got ${result.drafts.length}: ${JSON.stringify(result.drafts)}`);
  }
  return result.drafts[0];
}
function oneEffect(type, properties, state) {
  const result = reduce(type, properties, state);
  if (result.effects.length !== 1) {
    throw new Error(`expected 1 effect for ${type}, got ${result.effects.length}: ${JSON.stringify(result.effects)}`);
  }
  return result.effects[0];
}

assert(OPENCODE_RUNTIME_CAPABILITIES.resume === true, "OpenCode runtime supports session resume");
assert(OPENCODE_RUNTIME_CAPABILITIES.nativeCompaction === true, "OpenCode runtime supports native compaction");
assert(OPENCODE_RUNTIME_CAPABILITIES.manualSummarize === true, "OpenCode runtime exposes manual summarize/compact");

// --- streaming text / reasoning deltas -------------------------------------
{
  const state = createOpencodeRuntimeState();
  reduce("message.part.updated", { part: { id: "p", messageID: "m", type: "text", text: "" } }, state);
  const t = oneDraft("message.part.delta", { field: "text", delta: "hi", messageID: "m", partID: "p" }, state);
  assert(t.type === "assistant.delta" && t.payload.text === "hi", "text delta -> assistant.delta");
  const r = oneDraft("message.part.delta", { field: "reasoning", delta: "ponder" });
  assert(r.type === "assistant.thinking.delta" && r.payload.text === "ponder", "reasoning delta -> assistant.thinking.delta");
  assert(reduce("message.part.delta", { field: "text", delta: "" }).drafts.length === 0, "empty delta ignored");
}

// --- field:text deltas wait for part.updated to classify text vs reasoning ---
{
  const state = createOpencodeRuntimeState();
  assert(reduce("message.part.delta", {
    partID: "prt_late",
    messageID: "msg_late",
    field: "text",
    delta: "hidden thought",
  }, state).drafts.length === 0, "unknown text-field delta is buffered until part type is known");
  const r = oneDraft("message.part.updated", {
    part: { id: "prt_late", messageID: "msg_late", type: "reasoning", text: "" },
  }, state);
  assert(r.type === "assistant.thinking.delta" && r.payload.text === "hidden thought",
    "buffered unknown delta is emitted as reasoning after reasoning part.updated");

  const state2 = createOpencodeRuntimeState();
  reduce("message.updated", { info: { id: "msg_late_text", role: "assistant" } }, state2);
  assert(reduce("message.part.delta", {
    partID: "prt_late_text",
    messageID: "msg_late_text",
    field: "text",
    delta: "visible answer",
  }, state2).drafts.length === 0, "unknown assistant text delta is buffered");
  const t = oneDraft("message.part.updated", {
    part: { id: "prt_late_text", messageID: "msg_late_text", type: "text", text: "" },
  }, state2);
  assert(t.type === "assistant.delta" && t.payload.text === "visible answer",
    "buffered unknown delta is emitted as assistant text after text part.updated");
}

// --- reasoning deltas mislabeled field:"text" are routed by part type --------
{
  const state = createOpencodeRuntimeState();
  reduce("message.part.updated", { part: { id: "prt_r", type: "reasoning", text: "" } }, state);
  reduce("message.part.updated", { part: { id: "prt_t", type: "text", text: "" } }, state);
  const r = oneDraft("message.part.delta", { partID: "prt_r", field: "text", delta: "thinking..." }, state);
  assert(r.type === "assistant.thinking.delta", "reasoning part delta -> thinking (not leaked as answer)");
  const t = oneDraft("message.part.delta", { partID: "prt_t", field: "text", delta: "你好" }, state);
  assert(t.type === "assistant.delta" && t.payload.text === "你好", "text part delta -> assistant.delta");
}

// --- text part.updated is used as a full-text sync, without duplicating deltas -
{
  const state = createOpencodeRuntimeState();
  reduce("message.updated", { info: { id: "msg_a", role: "assistant" } }, state);
  const first = oneDraft("message.part.updated", {
    part: { id: "prt_a", messageID: "msg_a", type: "text", text: "full answer" },
  }, state);
  assert(first.type === "assistant.delta" && first.payload.text === "full answer",
    "assistant text part.updated can recover full text when deltas were missed");

  const state2 = createOpencodeRuntimeState();
  reduce("message.updated", { info: { id: "msg_b", role: "assistant" } }, state2);
  reduce("message.part.updated", { part: { id: "prt_b", messageID: "msg_b", type: "text", text: "" } }, state2);
  oneDraft("message.part.delta", { partID: "prt_b", messageID: "msg_b", field: "text", delta: "hello" }, state2);
  const suffix = oneDraft("message.part.updated", {
    part: { id: "prt_b", messageID: "msg_b", type: "text", text: "hello world" },
  }, state2);
  assert(suffix.type === "assistant.delta" && suffix.payload.text === " world",
    "text part.updated emits only the missing suffix after streamed deltas");

  const state3 = createOpencodeRuntimeState();
  reduce("message.updated", { info: { id: "msg_user", role: "user" } }, state3);
  assert(reduce("message.part.updated", {
    part: { id: "prt_user", messageID: "msg_user", type: "text", text: "do not echo" },
  }, state3).drafts.length === 0, "user text part.updated is suppressed");

  const state4 = createOpencodeRuntimeState();
  assert(reduce("message.part.updated", {
    part: { id: "prt_late_role", messageID: "msg_late_role", type: "text", text: "late role answer" },
  }, state4).drafts.length === 0, "text snapshot waits when role has not arrived");
  const lateRole = oneDraft("message.updated", { info: { id: "msg_late_role", role: "assistant" } }, state4);
  assert(lateRole.type === "assistant.delta" && lateRole.payload.text === "late role answer",
    "assistant text snapshot is emitted once late role arrives");
}

// --- native compaction: internal bookkeeping only, nothing user-visible ------
{
  const result = reduce("session.compacted", { sessionID: "ses_1", messageID: "msg_summary", reason: "auto" });
  assert(result.progress === true, "session.compacted is meaningful progress");
  assert(result.drafts.length === 0, "session.compacted emits no visible draft (summary + notice hidden from chat)");
  assert(result.effects[0]?.kind === "context_compacted", "session.compacted carries context_compacted effect");
  assert(result.effects[0]?.sessionID === "ses_1", "context_compacted effect carries sessionID");
  assert(result.effects[0]?.messageID === "msg_summary", "context_compacted effect carries summary messageID");
}

// --- compaction summary message stream is suppressed --------------------------
{
  const state = createOpencodeRuntimeState();
  reduce("message.updated", { info: { id: "msg_sum", role: "assistant", summary: true, agent: "compaction" } }, state);
  const delta = reduce("message.part.delta", { partID: "prt_sum", messageID: "msg_sum", field: "text", delta: "Objective" }, state);
  assert(delta.drafts.length === 0 && delta.effects.length === 0, "summary message deltas are not streamed");
  const updated = reduce("message.part.updated", {
    part: { id: "prt_sum", messageID: "msg_sum", type: "text", text: "Objective\nWork State" },
  }, state);
  assert(updated.drafts.length === 0, "summary message part.updated emits no assistant.delta");
  // A later real assistant message in the same session still streams normally.
  reduce("message.updated", { info: { id: "msg_real", role: "assistant" } }, state);
  const real = reduce("message.part.updated", {
    part: { id: "prt_real", messageID: "msg_real", type: "text", text: "real answer" },
  }, state);
  assert(real.drafts[0]?.type === "assistant.delta" && real.drafts[0]?.payload?.text === "real answer",
    "non-summary assistant messages still stream");
}

// --- tool lifecycle: one tool.started + one tool.done -----------------------
{
  const state = createOpencodeRuntimeState();
  const start = oneDraft("message.part.updated", {
    part: { type: "tool", tool: "bash", callID: "c1", state: { status: "running", input: { command: "ls" } } },
  }, state);
  assert(start.type === "tool.started" && start.payload.id === "c1" && start.payload.name === "bash",
    "tool running -> tool.started");
  assert(start.payload.input.command === "ls", "tool input carried");

  const downloadStartState = createOpencodeRuntimeState();
  const downloadStart = reduce("message.part.updated", {
    part: {
      type: "tool",
      tool: "bash",
      callID: "curl_download",
      state: {
        status: "running",
        input: { command: 'curl -L -o /tmp/blender.dmg "https://example.com/blender.dmg"' },
      },
    },
  }, downloadStartState);
  assert(downloadStart.drafts.length === 2, `curl download start should emit tool + progress: ${JSON.stringify(downloadStart.drafts)}`);
  assert(downloadStart.drafts[0].type === "tool.started", "curl download still starts as a normal tool");
  assert(downloadStart.drafts[1].type === "engine.notice", "curl download start emits visible progress notice");
  assert(downloadStart.drafts[1].payload.notice.code === "workProgress", "curl download progress uses generic workProgress");
  assert(downloadStart.drafts[1].payload.notice.progress.phase === "downloading", "curl download progress carries phase");

  const curlProbeState = createOpencodeRuntimeState();
  const curlProbe = reduce("message.part.updated", {
    part: {
      type: "tool",
      tool: "bash",
      callID: "curl_probe",
      state: {
        status: "running",
        input: { command: "curl.exe -sS --connect-timeout 3 http://127.0.0.1:8188/system_stats 2>&1 | select -First 20" },
      },
    },
  }, curlProbeState);
  assert(curlProbe.drafts.length === 1, `curl health probe should only emit the normal tool row: ${JSON.stringify(curlProbe.drafts)}`);
  assert(curlProbe.drafts[0].type === "tool.started", "curl health probe still starts as a normal tool");
  assert(!curlProbe.drafts.some((draft) => draft.type === "engine.notice" && draft.payload?.notice?.code === "workProgress"),
    "curl health probe must not emit a fake download notice");

  const curlDiscardState = createOpencodeRuntimeState();
  const curlDiscard = reduce("message.part.updated", {
    part: {
      type: "tool",
      tool: "bash",
      callID: "curl_discard",
      state: {
        status: "running",
        input: { command: "curl.exe -sS https://example.com/health >nul 2>&1" },
      },
    },
  }, curlDiscardState);
  assert(curlDiscard.drafts.length === 1 && curlDiscard.drafts[0].type === "tool.started",
    `curl discard sink should only emit the normal tool row: ${JSON.stringify(curlDiscard.drafts)}`);
  assert(!curlDiscard.drafts.some((draft) => draft.payload?.notice?.code === "workProgress"),
    "curl discard sink must not emit a fake download notice");

  const partial = reduce("message.part.updated", {
    part: { type: "tool", tool: "bash", callID: "c1", state: { status: "running", metadata: { output: "partial" }, input: { command: "ls" } } },
  }, state);
  assert(partial.drafts.length === 0 && partial.progress === true, "running output update keeps long tools alive without duplicate cards");
  const duplicatePartial = reduce("message.part.updated", {
    part: { type: "tool", tool: "bash", callID: "c1", state: { status: "running", metadata: { output: "partial" }, input: { command: "ls" } } },
  }, state);
  assert(duplicatePartial.drafts.length === 0 && duplicatePartial.progress === false, "identical running output remains de-duped");

  const scanProgress = reduce("message.part.updated", {
    part: {
      type: "tool",
      tool: "bash",
      callID: "c1",
      state: {
        status: "running",
        metadata: { output: 'partial\n[lily-progress] {"label":"网页扫描","current":55,"total":80,"queued":7,"path":"https://www.matrx.tech/meeting/groups/dashboard"}' },
        input: { command: "python3 scan_web_system.py" },
      },
    },
  }, state);
  assert(scanProgress.progress === true, "scanner progress keeps long web scans alive");
  assert(scanProgress.drafts.length === 1 && scanProgress.drafts[0].type === "engine.notice", "scanner progress emits a visible notice");
  assert(scanProgress.drafts[0].payload.notice.code === "workProgress", "scanner progress uses generic visible workProgress notice code");
  assert(scanProgress.drafts[0].payload.notice.detail.includes("55/80"), "scanner progress detail includes page count");
  assert(scanProgress.drafts[0].payload.notice.detail.includes("/meeting/groups/dashboard"), "scanner progress detail includes compact current path");

  const curlProgress = reduce("message.part.updated", {
    part: {
      type: "tool",
      tool: "bash",
      callID: "curl_download",
      state: {
        status: "running",
        metadata: { output: " 42  200M   42 84M    0     0  2M      0  0:01:40  0:00:42  0:00:58 2M" },
        input: { command: 'curl -L -o /tmp/blender.dmg "https://example.com/blender.dmg"' },
      },
    },
  }, downloadStartState);
  assert(curlProgress.drafts.length === 1 && curlProgress.drafts[0].type === "engine.notice", "curl output progress updates the same visible notice");
  assert(curlProgress.drafts[0].payload.notice.detail.includes("42%"), "curl output progress detail includes percent");
  assert(curlProgress.drafts[0].payload.notice.progress.percent === 42, "curl output progress preserves structured percent");

  const sameScanProgress = reduce("message.part.updated", {
    part: {
      type: "tool",
      tool: "bash",
      callID: "c1",
        state: {
          status: "running",
          metadata: { output: 'partial\nnoise\n[lily-progress] {"label":"网页扫描","current":55,"total":80,"queued":7,"path":"https://www.matrx.tech/meeting/groups/dashboard"}' },
          input: { command: "python3 scan_web_system.py" },
        },
      },
  }, state);
  assert(sameScanProgress.progress === true && sameScanProgress.drafts.length === 0, "same scanner progress resets watchdog without duplicate visible notices");

  const legacySkillMarker = reduce("message.part.updated", {
    part: {
      type: "tool",
      tool: "bash",
      callID: "legacy_skill_marker",
      state: {
        status: "running",
        metadata: { output: '[lily-web-scan] {"event":"page_start","pageIndex":55,"maxPages":80}' },
        input: { command: "python3 old_skill.py" },
      },
    },
  }, state);
  assert(
    legacySkillMarker.drafts.length === 1 && legacySkillMarker.drafts[0].type === "tool.started",
    "core ignores skill-specific legacy progress markers",
  );

  const done = oneDraft("message.part.updated", {
    part: { type: "tool", tool: "bash", callID: "c1", state: { status: "completed", output: "file.txt", input: { command: "ls" } } },
  }, state);
  assert(done.type === "tool.done" && done.payload.id === "c1" && done.payload.isError === false,
    "tool completed -> tool.done");
  assert(done.payload.content === "file.txt", "tool output flattened into content");
}

// --- tool_use waits for args; error still yields a tool.done ----------------
{
  const state = createOpencodeRuntimeState();
  assert(reduce("message.part.updated", {
    part: { type: "tool", tool: "bash", callID: "c2", state: { status: "running", input: {} } },
  }, state).drafts.length === 0, "running with empty input -> no blank tool.started");
  const start = oneDraft("message.part.updated", {
    part: { type: "tool", tool: "bash", callID: "c2", state: { status: "running", input: { command: "x" } } },
  }, state);
  assert(start.type === "tool.started" && start.payload.input.command === "x", "tool.started emitted once args arrive");
  const fail = oneDraft("message.part.updated", {
    part: { type: "tool", tool: "bash", callID: "c2", state: { status: "error", error: "boom", input: { command: "x" } } },
  }, state);
  assert(fail.type === "tool.done" && fail.payload.isError === true && fail.payload.content === "boom",
    "tool error -> tool.done isError");

  const nativeSkillState = createOpencodeRuntimeState();
  const nativeSkillFail = reduce("message.part.updated", {
    part: {
      type: "tool",
      tool: "skill",
      callID: "skill_lily_browser_qa_old",
      state: {
        status: "error",
        error: 'Skill "lily-browser-qa" not found. Available skills: customize-opencode',
        input: { name: "lily-browser-qa" },
      },
    },
  }, nativeSkillState);
  assert(nativeSkillFail.drafts.some((draft) => draft.type === "tool.done"), "native Lily skill failure still records the failed tool");
  assert(nativeSkillFail.drafts.some((draft) => draft.type === "engine.notice" && draft.payload.notice.code === "platformCapabilitySkillFallback"),
    "native Lily skill failure emits a visible fallback notice");
  assert(nativeSkillFail.drafts.some((draft) => draft.type === "runtime.control" && draft.payload.reason === "platformCapabilitySkillFallback"),
    "native Lily skill failure emits an auto-steer recovery control");
  const nativeSkillDone = nativeSkillFail.drafts.find((draft) => draft.type === "tool.done");
  assert(nativeSkillDone.payload.content.includes("resources/skills-catalog/lily-browser-qa/SKILL.md"),
    "native Lily skill failure tells the agent to read the Lily capability guide");
  assert(nativeSkillDone.payload.content.includes("This native skill failure should not stop the task"),
    "native Lily skill failure must fail open instead of stopping the task");

  const catalogSkillState = createOpencodeRuntimeState();
  const catalogSkillFail = reduce("message.part.updated", {
    part: {
      type: "tool",
      tool: "skill",
      callID: "skill_anthropics_xlsx_old",
      state: {
        status: "error",
        error: 'Skill "anthropics-xlsx" not found. Available skills: customize-opencode',
        input: { name: "anthropics-xlsx" },
      },
    },
  }, catalogSkillState);
  assert(catalogSkillFail.drafts.some((draft) => draft.type === "engine.notice" && draft.payload.notice.code === "platformCapabilitySkillFallback"),
    "native catalog skill failure emits a visible fallback notice");
  assert(catalogSkillFail.drafts.some((draft) => draft.type === "runtime.control" && draft.payload.reason === "platformCapabilitySkillFallback"),
    "native catalog skill failure emits an auto-steer recovery control");
  const catalogSkillDone = catalogSkillFail.drafts.find((draft) => draft.type === "tool.done");
  assert(catalogSkillDone.payload.content.includes("resources/skills-catalog/anthropics-xlsx/SKILL.md"),
    "native catalog skill failure tells the agent to read the catalog capability guide");
  assert(catalogSkillDone.payload.content.includes("This native skill failure should not stop the task"),
    "native catalog skill failure must fail open instead of stopping the task");
}

// --- tool that goes straight to completed still works -----------------------
{
  const state = createOpencodeRuntimeState();
  const result = reduce("message.part.updated", {
    part: { type: "tool", tool: "bash", callID: "c4", state: { status: "completed", output: "done", input: { command: "y" } } },
  }, state);
  assert(result.drafts.length === 2 && result.drafts[0].type === "tool.started" && result.drafts[1].type === "tool.done",
    "completed-without-prior-running emits both start + done");
}

// --- OpenCode v2 durable tool lifecycle ------------------------------------
{
  const state = createOpencodeRuntimeState();
  const called = oneDraft("session.next.tool.called", {
    sessionID: "ses_1",
    assistantMessageID: "msg_1",
    callID: "call_task",
    tool: "task",
    input: { description: "Find meeting dead code", subagent_type: "general" },
    metadata: { sessionId: "child_1", toolcalls: 3, model: { modelID: "fast" } },
    title: "Find meeting dead code",
    provider: { executed: true },
  }, state);
  assert(called.type === "tool.started" && called.payload.name === "task", "session.next.tool.called -> tool.started");
  assert(called.payload.input.description === "Find meeting dead code", "v2 tool input carried");
  assert(called.payload.metadata.sessionId === "child_1", "v2 task metadata sessionId carried");
  assert(called.payload.metadata.toolcalls === 3, "v2 task metadata toolcall count carried");
  assert(called.payload.title === "Find meeting dead code", "v2 task title carried");

  const progress = reduce("session.next.tool.progress", {
    sessionID: "ses_1",
    assistantMessageID: "msg_1",
    callID: "call_task",
    structured: {},
    content: [{ type: "text", text: "reading files" }],
  }, state);
  assert(progress.progress === true && progress.drafts.length === 0, "v2 tool progress keeps idle probe alive without duplicate start");

  const done = oneDraft("session.next.tool.success", {
    sessionID: "ses_1",
    assistantMessageID: "msg_1",
    callID: "call_task",
    structured: {},
    content: [{ type: "text", text: "found Huawei meeting code" }],
    metadata: { sessionId: "child_1", toolcalls: 5 },
    result: { output: "ignored because content wins" },
    provider: { executed: true },
  }, state);
  assert(done.type === "tool.done" && done.payload.id === "call_task", "session.next.tool.success -> tool.done");
  assert(done.payload.content === "found Huawei meeting code", "v2 tool content flattened");
  assert(done.payload.metadata.toolcalls === 5, "v2 task done metadata carried");
  assert(reduce("session.next.tool.success", {
    sessionID: "ses_1",
    assistantMessageID: "msg_1",
    callID: "call_task",
    structured: {},
    content: [{ type: "text", text: "duplicate" }],
    provider: { executed: true },
  }, state).drafts.length === 0, "duplicate v2 tool success suppressed");

  const nativeSkillState = createOpencodeRuntimeState();
  const nativeSkillCalled = oneDraft("session.next.tool.called", {
    sessionID: "ses_1",
    assistantMessageID: "msg_1",
    callID: "skill_lily_browser_qa",
    tool: "skill",
    input: { name: "lily-browser-qa" },
    title: "lily-browser-qa",
  }, nativeSkillState);
  assert(nativeSkillCalled.type === "tool.started" && nativeSkillCalled.payload.name === "skill",
    "native skill tool still starts normally");
  const nativeSkillFailed = reduce("session.next.tool.failed", {
    sessionID: "ses_1",
    assistantMessageID: "msg_1",
    callID: "skill_lily_browser_qa",
    tool: "skill",
    input: { name: "lily-browser-qa" },
    content: [{ type: "text", text: 'Skill "lily-browser-qa" not found. Available skills: customize-opencode' }],
    title: "lily-browser-qa",
  }, nativeSkillState);
  assert(nativeSkillFailed.drafts.length === 3, `native Lily skill failure should emit tool.done + fallback notice + recovery control: ${JSON.stringify(nativeSkillFailed.drafts)}`);
  assert(nativeSkillFailed.drafts[0].type === "tool.done" && nativeSkillFailed.drafts[0].payload.isError === true,
    "native Lily skill failure remains visible as a failed tool");
  assert(nativeSkillFailed.drafts[0].payload.content.includes("Do not run `skill lily-browser-qa`"),
    "native Lily skill failure explains the native/Lily boundary");
  assert(nativeSkillFailed.drafts[0].payload.content.includes("resources/skills-catalog/lily-browser-qa/SKILL.md"),
    "native Lily skill failure points to the Lily guide path");
  assert(nativeSkillFailed.drafts[1].type === "engine.notice" && nativeSkillFailed.drafts[1].payload.notice.code === "platformCapabilitySkillFallback",
    "native Lily skill failure emits a fallback notice in v2 events");
  assert(nativeSkillFailed.drafts[2].type === "runtime.control" && nativeSkillFailed.drafts[2].payload.text.includes("Read tool"),
    "native Lily skill failure emits a recovery steer instruction in v2 events");

  const catalogSkillState = createOpencodeRuntimeState();
  reduce("session.next.tool.called", {
    sessionID: "ses_1",
    assistantMessageID: "msg_1",
    callID: "skill_anthropics_pdf",
    tool: "skill",
    input: { name: "anthropics-pdf" },
    title: "anthropics-pdf",
  }, catalogSkillState);
  const catalogSkillFailed = reduce("session.next.tool.failed", {
    sessionID: "ses_1",
    assistantMessageID: "msg_1",
    callID: "skill_anthropics_pdf",
    tool: "skill",
    input: { name: "anthropics-pdf" },
    content: [{ type: "text", text: 'Skill "anthropics-pdf" not found. Available skills: customize-opencode' }],
    title: "anthropics-pdf",
  }, catalogSkillState);
  assert(catalogSkillFailed.drafts.some((draft) => draft.type === "engine.notice" && draft.payload.notice.code === "platformCapabilitySkillFallback"),
    "native catalog skill failure emits a fallback notice in v2 events");
  assert(catalogSkillFailed.drafts[0].payload.content.includes("resources/skills-catalog/anthropics-pdf/SKILL.md"),
    "native catalog skill failure points to the catalog guide path in v2 events");
}

// --- OpenCode dual-write old+new tool events must not duplicate done --------
{
  const state = createOpencodeRuntimeState();
  reduce("message.part.updated", {
    part: { type: "tool", tool: "task", callID: "call_dual", state: { status: "running", input: { description: "dual write" } } },
  }, state);
  const oldDone = oneDraft("message.part.updated", {
    part: { type: "tool", tool: "task", callID: "call_dual", state: { status: "completed", output: "old result", input: { description: "dual write" } } },
  }, state);
  assert(oldDone.type === "tool.done", "old tool completion still emits done");
  const newDone = reduce("session.next.tool.success", {
    sessionID: "ses_1",
    assistantMessageID: "msg_1",
    callID: "call_dual",
    structured: {},
    content: [{ type: "text", text: "new duplicate" }],
    provider: { executed: true },
  }, state);
  assert(newDone.drafts.length === 0, "new duplicate tool completion is suppressed after old done");
}

// --- v2 step settlement carries usage and meaningful progress ---------------
{
  const result = reduce("session.next.step.ended", {
    sessionID: "ses_1",
    assistantMessageID: "msg_1",
    finish: "stop",
    cost: 0.02,
    tokens: { input: 11, output: 3, reasoning: 2, cache: { read: 4, write: 5 } },
  });
  assert(result.progress === true, "v2 step ended is progress so idle probe can settle missed session.idle");
  assert(result.drafts[0].type === "usage.updated", "v2 step ended -> usage.updated");
  assert(result.effects[0].usage.output_tokens === 5, "v2 step output+reasoning summed");
}

// --- step-finish carries token usage ---------------------------------------
{
  const result = reduce("message.part.updated", {
    part: { type: "step-finish", reason: "stop", tokens: { input: 100, output: 20, reasoning: 5, cache: { read: 8, write: 2 } }, cost: 0.01 },
  });
  assert(result.drafts[0].type === "usage.updated", "step-finish -> usage.updated");
  const usage = result.effects[0].usage;
  assert(usage.input_tokens === 100, "input tokens mapped");
  assert(usage.output_tokens === 25, "output+reasoning tokens summed");
  assert(usage.cache_read_input_tokens === 8 && usage.cache_creation_input_tokens === 2, "cache tokens mapped");
}

// --- turn completion: only session.idle is terminal -------------------------
{
  assert(oneEffect("session.idle", { sessionID: "s" }).kind === "complete", "session.idle -> complete");
  assert(reduce("session.status", { status: { type: "idle" } }).effects.length === 0, "session.status idle is a snapshot, not completion");
  assert(reduce("session.status", { status: { type: "busy" } }).effects.length === 0, "session.status busy -> nothing");
  assert(reduce("session.status", { status: { type: "busy" } }).processEvent.payload.handled === true,
    "session.status is explicitly handled");
}

// --- engine error -----------------------------------------------------------
{
  const e = oneEffect("message.error", { error: { message: "model down" } });
  assert(e.kind === "error" && e.message === "model down", "message.error -> error effect");
  const nested = oneEffect("message.error", { error: { name: "MessageAbortedError", data: { message: "Aborted" } } });
  assert(nested.message === "Aborted", "message.error nested data.message is preserved");
}

// --- permission request -----------------------------------------------------
{
  const p = oneEffect("permission.asked", {
    id: "perm_1",
    permission: "bash",
    metadata: { command: "rm", description: "remove" },
    tool: { callID: "c9", messageID: "m1" },
  });
  assert(p.kind === "permission" && p.requestId === "perm_1", "permission.asked -> permission effect");
  assert(p.toolName === "bash", "toolName from permission field");
  assert(p.callId === "c9", "callID from tool.callID");
  assert(p.input.command === "rm" && p.description === "remove", "metadata surfaced");

  const resolved = oneDraft("permission.replied", { id: "perm_1", allow: true });
  assert(resolved.type === "permission.resolved" && resolved.payload.requestId === "perm_1",
    "permission.replied -> permission.resolved draft");
}

// --- question tool ----------------------------------------------------------
{
  const q = oneEffect("question.asked", {
    id: "que_1",
    questions: [{ question: "Which DB?", header: "DB", options: [{ label: "PG" }, { label: "SQLite" }], multiple: false, custom: true }],
    tool: { callID: "c7" },
  });
  assert(q.kind === "question" && q.requestId === "que_1", "question.asked -> question effect");
  assert(q.questions[0].header === "DB", "question carried");
  assert(q.questions[0].multiSelect === false && q.questions[0].allowCustom === true, "multiple/custom mapped");
  assert(q.questions[0].options.length === 2, "options carried");

  const answered = oneDraft("question.replied", { id: "que_1" });
  assert(answered.type === "user_question.resolved" && answered.payload.requestId === "que_1",
    "question.replied -> user_question.resolved");
  const rejected = oneDraft("question.rejected", { requestID: "que_2" });
  assert(rejected.type === "user_question.resolved" && rejected.payload.requestId === "que_2" && rejected.payload.rejected === true,
    "question.rejected -> resolved draft with rejected marker");
}

// --- official app state events that Lily must explicitly understand ---------
{
  const todo = oneDraft("todo.updated", {
    sessionID: "s1",
    todos: [{ content: "Read code", status: "completed" }, { content: "Patch reducer", status: "in_progress" }],
  });
  assert(todo.type === "todo.updated" && todo.payload.id === "todo_s1", "todo.updated -> todo draft");
  assert(todo.payload.todos.length === 2, "todo list carried");

  const state = createOpencodeRuntimeState();
  reduce("message.part.updated", { part: { id: "prt_del", messageID: "msg_del", type: "text", text: "gone" } }, state);
  const removedPart = reduce("message.part.removed", { partID: "prt_del" }, state);
  assert(removedPart.processEvent.payload.handled === true, "message.part.removed is explicitly handled");
  const removedMessage = reduce("message.removed", { messageID: "msg_del" }, state);
  assert(removedMessage.processEvent.payload.handled === true, "message.removed is explicitly handled");

  for (const t of ["session.deleted", "vcs.branch.updated", "lsp.updated", "server.instance.disposed"]) {
    const result = reduce(t, {});
    assert(result.processEvent.payload.handled === true, `${t} explicitly handled`);
  }
}

// --- noise events are silent; unknown events are retained as raw process data -
{
  for (const t of ["server.connected", "plugin.added", "catalog.updated", "message.updated", "session.updated"]) {
    const result = reduce(t, {});
    assert(result.drafts.length === 0 && result.effects.length === 0, `${t} silent`);
  }
  for (const t of ["step-start", "session.next.prompt.admitted"]) {
    const result = reduce(t, {});
    assert(result.drafts.length === 0 && result.progress === true, `${t} resets progress without answer text`);
    assert(result.effects[0]?.kind === "status", `${t} emits status effect`);
  }
  const busy = reduce("busy", {});
  assert(busy.drafts.length === 0 && busy.progress === false,
    "busy heartbeat must not reset the no-progress watchdog");
  assert(busy.effects[0]?.kind === "status", "busy heartbeat still emits a status effect");
  const u = reduce("some.future.event", { future: { nested: true } });
  assert(u.drafts.length === 0 && u.effects[0].kind === "unknown",
    "unknown event does not become a noisy protocol warning");
  assert(u.processEvent.type === "process.event" && u.processEvent.payload.handled === false,
    "unknown event is retained in process.event");
  assert(u.processEvent.payload.rawEvent.properties.future.nested === true,
    "raw OpenCode event payload is preserved for diagnostics/UI adapters");
}

// --- process.event summary + capabilities + reset --------------------------
{
  const result = reduce("message.part.delta", { field: "text", delta: "hi", partID: "unknown_p", messageID: "unknown_m" });
  assert(result.processEvent.type === "process.event", "process.event draft attached");
  assert(result.processEvent.payload.summary === "", "unclassified text-field delta is buffered, not summarized as answer");
  assert(OPENCODE_RUNTIME_CAPABILITIES.streamInput === false && OPENCODE_RUNTIME_CAPABILITIES.permissionAlwaysAsk === true,
    "capabilities declared");

  const state = createOpencodeRuntimeState();
  const toolEv = { part: { type: "tool", tool: "bash", callID: "z", state: { status: "running", input: { command: "x" } } } };
  reduce("message.part.updated", toolEv, state);
  assert(reduce("message.part.updated", toolEv, state).drafts.length === 0, "same tool/state de-duped within a turn");
  resetOpencodeRuntimeState(state);
  assert(reduce("message.part.updated", toolEv, state).drafts.length === 1, "reset clears tool de-dupe");
}

console.log("opencode-runtime-reducer: ok");
