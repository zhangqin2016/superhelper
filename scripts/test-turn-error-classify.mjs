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

// preflightFailureText — distinct copy per cause, with optional detail appended.
assert(/Image recognition service/.test(ec.preflightFailureText("VISION_UNAVAILABLE")), "vision-unavailable text");
assert(/Image parsing failed/.test(ec.preflightFailureText("VISION_FAILED")), "vision-failed text");
assert(/Document parsing failed/.test(ec.preflightFailureText("DOCUMENT_FAILED")), "document-failed text");
assert(/Pre-send processing failed/.test(ec.preflightFailureText("WHATEVER")), "default preflight text");
assert(ec.preflightFailureText("VISION_FAILED", "boom").endsWith("boom"), "detail is appended");

// collectFailureTextFromState — pulls the latest failure-bearing text.
const text = ec.collectFailureTextFromState({
  processEvents: [{ rawSubtype: "error_max_turns", event: { error: "hit the limit" } }],
  notices: [{ payload: { notice: { level: "warning", code: "ENGINE_TIMEOUT", detail: "timed out" } } }],
});
assert(text.includes("hit the limit"), "extracts process-event error");
assert(text.includes("timed out"), "extracts notice detail");

// classifyTurnFailure — branch behavior (use payloads that don't trip the
// upstream classifier, so we exercise the fallback branches deterministically).
assert(ec.classifyTurnFailure({}, {}, {}) === null, "no failure → null");

const interrupted = ec.classifyTurnFailure({ engineInterrupted: true }, {}, {});
assert(interrupted?.code === "ENGINE_INTERRUPTED" && interrupted.retryable === true, "engineInterrupted branch");

const exited = ec.classifyTurnFailure({ code: 1, source: "process.close" }, {}, {});
assert(exited?.code === "ENGINE_PROCESS_EXITED" && exited.retryable === true, "process.close exit branch");

const resultFail = ec.classifyTurnFailure({ code: 2 }, {}, {});
assert(resultFail?.code === "ENGINE_RESULT_FAILED", "non-zero result code branch");

const normalizedFail = ec.classifyTurnFailure({}, { failed: true, text: "engine said no", retryable: false }, {});
assert(normalizedFail?.message === "engine said no" && normalizedFail.retryable === false, "normalized failure branch");

const toolState = {
  tools: new Map([
    ["task_done", {
      id: "task_done",
      name: "task",
      input: { description: "Explore imsdk-im server" },
      status: "done",
    }],
    ["task_failed", {
      id: "task_failed",
      name: "task",
      input: { description: "Explore MXIM client source" },
      status: "failed",
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
