#!/usr/bin/env node
//
// turn-error-classify holds the pure failure-classification logic factored out
// of turn-orchestrator. It decides what the user is told and whether a turn is
// retried — so wrong classification = wrong UX or a stuck/over-eager retry.
// Runs in plain node (no electron).

import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { assert } from "./lib/test-assert.mjs";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ec = require(path.join(ROOT, "src/main/turn-error-classify.js"));

// collectFailureTextFromState — pulls the latest failure-bearing text.
const text = ec.collectFailureTextFromState({
  processEvents: [{ rawSubtype: "error_max_turns", event: { error: "hit the limit" } }],
  notices: [{ payload: { notice: { level: "warning", code: "ENGINE_TIMEOUT", detail: "timed out" } } }],
});
assert(text.includes("hit the limit"), "extracts process-event error");
assert(text.includes("timed out"), "extracts notice detail");

// classifyTurnFailure — branch behavior (use payloads that don't trip the
// upstream classifier, so we exercise the fallback branches deterministically).
assert(ec.classifyTurnFailure({}, { text: "done" }, {}) === null, "answered completion → null");

const interrupted = ec.classifyTurnFailure({ engineInterrupted: true }, {}, {});
assert(interrupted?.code === "ENGINE_INTERRUPTED" && interrupted.retryable === true, "engineInterrupted branch");

const exited = ec.classifyTurnFailure({ code: 1, source: "process.close" }, {}, {});
assert(exited?.code === "ENGINE_PROCESS_EXITED" && exited.retryable === true, "process.close exit branch");

const resultFail = ec.classifyTurnFailure({ code: 2 }, {}, {});
assert(resultFail?.code === "ENGINE_RESULT_FAILED", "non-zero result code branch");

const normalizedFail = ec.classifyTurnFailure({}, { failed: true, text: "engine said no", retryable: false }, {});
assert(normalizedFail?.message === "engine said no" && normalizedFail.retryable === false, "normalized failure branch");

const emptyCompletion = ec.classifyTurnFailure({ code: 0 }, { text: "" }, { assistantText: "" });
assert(emptyCompletion?.code === "EMPTY_ASSISTANT_COMPLETION", "empty assistant completions are not successful answers");
assert(emptyCompletion?.retryable === true, "empty assistant completions are retryable protocol failures");
assert(ec.isEmptyAssistantCompletion({ code: 0 }, { text: "" }, { assistantText: "" }), "detects empty completed output");
assert(!ec.isEmptyAssistantCompletion({ code: 0 }, { text: "done" }, { assistantText: "" }), "does not flag real text");

const leakedToolCall = ec.classifyTurnFailure(
  {},
  { text: "> <parameter=timeout> 10000 </parameter> </function> </tool_call>" },
  {},
);
assert(leakedToolCall?.code === "MALFORMED_TOOL_CALL_TEXT", "leaked tool-call fragments are not successful answers");
assert(leakedToolCall?.retryable === true, "leaked tool-call fragments are retryable protocol failures");
assert(ec.looksLikeLeakedToolCallText("<tool_call><function=bash><parameter=timeout>10000</parameter>"), "detects tool-call XML");
assert(!ec.looksLikeLeakedToolCallText("Please set the timeout parameter to 10000."), "does not flag normal prose");

const toolState = {
  tools: new Map([
    ["task_done", {
      id: "task_done",
      name: "task",
      input: { description: "Explore imsdk-im server" },
      status: "done",
      result: { output: "found message flow\n- server accepts message\n- client receives ack" },
    }],
    ["task_failed", {
      id: "task_failed",
      name: "task",
      input: { description: "Explore MXIM client source" },
      status: "failed",
      result: { output: "timeout after 90s" },
    }],
    ["task_running", {
      id: "task_running",
      name: "task",
      input: { description: "Explore sdk-msg-delivery" },
      status: "running",
    }],
  ]),
};
const snapshot = ec.collectToolCompletionSnapshot(toolState);
assert(snapshot.done.length === 1 && snapshot.failed.length === 1 && snapshot.running.length === 1, "tool completion snapshot");
const incomplete = ec.buildIncompleteTurnSummary(toolState, {});
assert(incomplete.includes("本轮没有形成完整最终回答"), "incomplete summary headline");
assert(incomplete.includes("Explore MXIM client source"), "incomplete summary includes failed tool");
assert(incomplete.includes("Explore sdk-msg-delivery"), "incomplete summary includes running tool");
assert(incomplete.includes("Explore imsdk-im server"), "incomplete summary includes completed tool");
assert(incomplete.includes("found message flow"), "incomplete summary preserves completed tool output");
assert(incomplete.includes("timeout after 90s"), "incomplete summary preserves failed tool output");
const appended = ec.appendIncompleteTurnSummary("你说得对，之前偏向了 cst。", toolState, {});
assert(appended.includes("你说得对") && appended.includes("本轮没有形成完整最终回答"), "partial text receives stalled summary");

const skillParse = ec.classifyTurnFailure(
  { error: "Failed to parse skill /workspace/.claude/skills/bad/SKILL.md" },
  {},
  {},
);
assert(skillParse?.code === "RUNTIME_SKILL_PARSE_FAILED", "skill parse failures are not model connection failures");
assert(skillParse?.category === "runtime_diagnostic", "skill parse failures carry runtime diagnostic category");
assert(skillParse.retryable === false, "skill parse failures are not blindly retried as network errors");

console.log("turn-error-classify: ok");
