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
const { classifyAssistantError } = require(path.join(ROOT, "src/main/agent-runner.js"));

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

const normalizedModelConnection = classifyAssistantError(
  "Connection to the model service was interrupted. Please check your network and API settings, then retry.",
);
assert(normalizedModelConnection?.code === "MODEL_CONNECTION_FAILED", "normalized model interruption stays classifiable");

const acceptedButNoActivity = classifyAssistantError(
  "The assistant engine accepted the message but did not start the turn. Please retry.",
);
assert(acceptedButNoActivity?.code === "RESPONSE_ERROR", "accepted-but-idle engine failures are recoverable protocol failures");

const normalizedSessionInvalid = classifyAssistantError(
  "Session context has expired (possibly due to restart). Recovery attempted — please send your message again.",
);
assert(normalizedSessionInvalid?.code === "SESSION_INVALID", "normalized session-invalid message stays classifiable");

const normalizedEngineUnreachable = classifyAssistantError(
  "The assistant engine became unreachable. Please retry.",
);
assert(normalizedEngineUnreachable?.code === "ENGINE_UNAVAILABLE", "normalized engine-unreachable message stays classifiable");

const requestEntityTooLarge = classifyAssistantError("Request failed: Request Entity Too Large");
assert(requestEntityTooLarge?.code === "CONTEXT_LIMIT", "request entity too large is not misclassified as model connection");
assert(requestEntityTooLarge?.retryable === false, "oversized requests are not blind-retry failures");

const managedGatewayTokenInvalid = classifyAssistantError("Request failed: 401 MODEL_GATEWAY_TOKEN_INVALID");
assert(managedGatewayTokenInvalid?.code === "MANAGED_MODEL_AUTH_INVALID", "Lily gateway token invalid is a managed-config refresh failure");
assert(managedGatewayTokenInvalid?.retryable === true, "Lily gateway token invalid can be refreshed and retried");

const managedGatewayAccountMissing = classifyAssistantError("Request failed: 402 payment_required ACCOUNT_LOGIN_REQUIRED");
assert(managedGatewayAccountMissing?.code === "MANAGED_MODEL_AUTH_MISSING", "Lily gateway account/license missing is a managed-config auth failure");
assert(managedGatewayAccountMissing?.retryable === true, "Lily gateway account/license missing can refresh config after activation/login");

const entitlementInsufficient = classifyAssistantError("Request failed: 402 payment_required ENTITLEMENT_INSUFFICIENT");
assert(entitlementInsufficient?.code === "QUOTA_EXCEEDED", "gateway balance/entitlement 402 is a quota failure, not a connection drop");
assert(entitlementInsufficient?.retryable === false, "an empty balance is not fixed by blind retry");

const balanceShellOnly = classifyAssistantError("API Error: 402");
assert(balanceShellOnly?.code === "QUOTA_EXCEEDED", "a bare 'API Error: 402' shell must NOT be relabeled as a connection interruption");

const accountLoginStillWins = classifyAssistantError("Request failed: 402 payment_required ACCOUNT_LOGIN_REQUIRED");
assert(accountLoginStillWins?.code === "MANAGED_MODEL_AUTH_MISSING", "login/activation-required 402 still wins over the balance classifier");

const providerNotConfigured = classifyAssistantError("API Error: 404 model provider not configured");
assert(providerNotConfigured?.code === "MODEL_UNAVAILABLE", "a removed managed model (gateway 404 provider not configured) must NOT be relabeled as a connection interruption");
assert(providerNotConfigured?.retryable === true, "a removed model is recoverable — the session layer refreshes config and falls back to the default");

const bareGateway404 = classifyAssistantError("API Error: 404");
assert(bareGateway404?.code === "MODEL_UNAVAILABLE", "a bare gateway 404 shell routes to model-unavailable (refresh+fallback), not connection-interrupted");

const genericUnauthorized = classifyAssistantError("Request failed: 401 Unauthorized");
assert(genericUnauthorized?.code === "AUTH_FAILED", "generic 401 remains a user/API-key auth failure");
assert(genericUnauthorized?.retryable === false, "generic API auth failures are not blindly retried");

const exited = ec.classifyTurnFailure({ code: 1, source: "process.close" }, {}, {});
assert(exited?.code === "ENGINE_PROCESS_EXITED" && exited.retryable === true, "process.close exit branch");

const resultFail = ec.classifyTurnFailure({ code: 2 }, {}, {});
assert(resultFail?.code === "ENGINE_RESULT_FAILED", "non-zero result code branch");

const normalizedFail = ec.classifyTurnFailure({}, { failed: true, text: "engine said no", retryable: false }, {});
assert(normalizedFail?.message === "engine said no" && normalizedFail.retryable === false, "normalized failure branch");

const emptyCompletion = ec.classifyTurnFailure({ code: 0 }, { text: "" }, { assistantText: "" });
assert(emptyCompletion?.code === "EMPTY_ASSISTANT_COMPLETION", "empty assistant completions are not successful answers");
assert(emptyCompletion?.retryable === true, "empty assistant completions are retryable protocol failures");
assert(/当前模型不可用/.test(emptyCompletion?.message || ""), "empty completions are reported as model output failures, not generic engine stoppage");
assert(emptyCompletion?.suppressIncompleteSummary === true, "empty model output should not append a duplicate incomplete-turn summary");
assert(ec.isEmptyAssistantCompletion({ code: 0 }, { text: "" }, { assistantText: "" }), "detects empty completed output");
assert(!ec.isEmptyAssistantCompletion({ code: 0 }, { text: "done" }, { assistantText: "" }), "does not flag real text");

const leakedToolCall = ec.classifyTurnFailure(
  {},
  { text: "> <parameter=timeout> 10000 </parameter> </function> </tool_call>" },
  {},
);
assert(leakedToolCall?.code === "MALFORMED_TOOL_CALL_TEXT", "leaked tool-call fragments are not successful answers");
assert(leakedToolCall?.retryable === true, "leaked tool-call fragments are retryable protocol failures");
const leakedReasoningToolCall = ec.classifyTurnFailure(
  { code: 0 },
  { text: "我来继续为您制作一个漂亮的页面！" },
  {
    assistantText: "我来继续为您制作一个漂亮的页面！",
    thinkingText: "<tool_call><function=write><parameter=content><!DOCTYPE html>",
  },
);
assert(leakedReasoningToolCall?.code === "MALFORMED_TOOL_CALL_TEXT", "leaked tool-call fragments in reasoning are not successful answers");
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
