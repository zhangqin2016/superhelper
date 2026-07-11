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

// NO BARE TOKENS: infra vocabulary that merely CONTAINS billing-ish words must
// never tell the user to top up (the field case: a gateway 5xx page mentioning
// its load balancer read as "Insufficient account balance", non-retryable).
const loadBalancer = classifyAssistantError("upstream connect error: no healthy upstream behind load balancer");
assert(loadBalancer?.code !== "QUOTA_EXCEEDED", "'load balancer' must not classify as an account balance problem");
const lineNumber402 = classifyAssistantError("SyntaxError at line 402 in module bundle.js");
assert(lineNumber402?.code !== "QUOTA_EXCEEDED", "a line number 402 is not an HTTP 402");
const openaiQuota = classifyAssistantError("You exceeded your current quota, please check your plan and billing details.");
assert(openaiQuota?.code === "QUOTA_EXCEEDED", "the classic exceeded-quota billing message still classifies");
const chineseArrears = classifyAssistantError("请求被拒绝：账户余额不足，请充值后重试");
assert(chineseArrears?.code === "QUOTA_EXCEEDED", "Chinese arrears wording classifies as quota");

const accountLoginStillWins = classifyAssistantError("Request failed: 402 payment_required ACCOUNT_LOGIN_REQUIRED");
assert(accountLoginStillWins?.code === "MANAGED_MODEL_AUTH_MISSING", "login/activation-required 402 still wins over the balance classifier");

const providerNotConfigured = classifyAssistantError("API Error: 404 model provider not configured");
assert(providerNotConfigured?.code === "MODEL_UNAVAILABLE", "a removed managed model (gateway 404 provider not configured) must NOT be relabeled as a connection interruption");
assert(providerNotConfigured?.retryable === true, "a removed model is recoverable — the session layer refreshes config and falls back to the default");

const bareGateway404 = classifyAssistantError("API Error: 404");
assert(bareGateway404?.code === "MODEL_UNAVAILABLE", "a bare gateway 404 shell routes to model-unavailable (refresh+fallback), not connection-interrupted");

// A recycled runner racing the engine start is a SESSION failure, not a
// network drop (field: "Request failed: Cannot read properties of null
// (reading 'agentCommand')" was shown as "connection interrupted").
const runnerTerminated = classifyAssistantError(
  "Request failed: RUNNER_TERMINATED: the engine runner was recycled before the turn could start",
);
assert(runnerTerminated?.code === "RUNNER_TERMINATED", "recycled-runner races classify as RUNNER_TERMINATED");
assert(runnerTerminated?.retryable === true, "a recycled runner is retryable — the engine never started");

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

// MICRO_COMPLETION field case: a fragment of our own system guide echoed as
// the whole answer to "你好" (11 tokens, head cut mid-word). Two independent
// signatures must each catch it: the dangling ** and the unprompted lily-
// skill namespace.
const guideEcho = ec.classifyTurnFailure(
  { code: 0 },
  { text: "ily-csv-conversion (CSV 转换)**" },
  { usage: { output_tokens: 11 }, enginePayload: { rawText: "你好" } },
);
assert(guideEcho?.code === "MICRO_COMPLETION", "system-guide echo fragments are failures, not answers");
const danglingBoldOnly = ec.classifyTurnFailure(
  { code: 0 },
  { text: "以下步骤**" },
  { usage: { output_tokens: 6 }, enginePayload: { rawText: "你好" } },
);
assert(danglingBoldOnly?.code === "MICRO_COMPLETION", "an unpaired ** is a mid-document cut");
// 不变笨 guards: paired bold in a legit short answer stays a normal completion;
// naming a lily- skill the USER asked about is not an echo.
const pairedBold = ec.classifyTurnFailure(
  { code: 0 },
  { text: "**方案 A** 更适合你的场景" },
  { usage: { output_tokens: 14 }, enginePayload: { rawText: "你好" } },
);
assert(pairedBold === null, "paired bold markers in a real short answer must not be flagged");
const askedAboutSkill = ec.classifyTurnFailure(
  { code: 0 },
  { text: "lily-csv-conversion 支持 xlsx 和 csv" },
  { usage: { output_tokens: 14 }, enginePayload: { rawText: "lily-csv-conversion 能转 xlsx 吗" } },
);
assert(askedAboutSkill === null, "mentioning a skill the user asked about is not a prompt echo");

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
