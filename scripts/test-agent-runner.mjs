#!/usr/bin/env node
/**
 * Lightweight checks for stream-json helpers (no Electron / no engine binary).
 */
import { createRequire } from "node:module";
import { appendTextSegment, sanitizeError, isUpstreamApiFailure } from "../src/main/agent-runner.js";
import { sameSpawnOptions, sameRespawnOptions } from "../src/main/runner-spawn-options.js";
import {
  parseCanUseToolRequest,
  needsUserApproval,
  buildControlResponse,
  buildRememberAllowPermissions,
  buildControlCancelRequest,
  buildUpdateEnvironmentVariablesRequest,
  buildInterruptRequest,
  buildSetPermissionModeRequest,
} from "../src/main/control-protocol.js";
import {
  buildUserContentBlocks,
  buildUserMessagePayload,
  hasSendableContent,
} from "../src/main/user-message.js";
import { resolvePlanPreview } from "../src/main/plan-preview.js";
import { SessionTurnState } from "../src/main/session-turn-state.js";
import { isResumeFailureMessage } from "../src/main/session-engine-recovery.js";
import {
  classifyEngineEvent,
  noticeForControlSubtype,
} from "../src/main/engine-event-notices.js";

const merged = appendTextSegment("hello", "world");
if (merged !== "hello\n\nworld") throw new Error(`appendTextSegment failed: ${merged}`);

const friendly = sanitizeError("engine-upstream: command not found");
if (!friendly.includes("助手")) throw new Error(`sanitizeError failed: ${friendly}`);

const socketErr = sanitizeError(
  "API Error: The socket connection was closed unexpectedly. For more information, pass `verbose: true` in the second argument to fetch()",
);
if (!socketErr.includes("连接中断")) {
  throw new Error(`sanitizeError socket failed: ${socketErr}`);
}
if (!isUpstreamApiFailure("API Error: socket connection was closed")) {
  throw new Error("isUpstreamApiFailure failed");
}

const baseOpts = {
  agentCommand: "/a/lily-workbench",
  permissionMode: "default",
  disallowedTools: ["WebFetch", "WebSearch"],
};

if (
  !sameSpawnOptions(
    baseOpts,
    { ...baseOpts, disallowedTools: ["WebSearch", "WebFetch"] },
  )
) {
  throw new Error("sameSpawnOptions order sensitivity failed");
}

if (
  sameSpawnOptions(
    { ...baseOpts, disallowedTools: [] },
    { ...baseOpts, permissionMode: "bypassPermissions", disallowedTools: [] },
  )
) {
  throw new Error("sameSpawnOptions permissionMode failed");
}

if (
  !sameRespawnOptions(baseOpts, { ...baseOpts, configDir: "/tmp/other-guide" })
) {
  throw new Error("sameRespawnOptions should ignore configDir");
}

if (
  sameRespawnOptions(baseOpts, { ...baseOpts, permissionMode: "bypassPermissions" })
) {
  throw new Error("sameRespawnOptions permissionMode failed");
}

const parsed = parseCanUseToolRequest({
  type: "control_request",
  request_id: "req_1",
  request: {
    subtype: "can_use_tool",
    tool_name: "ExitPlanMode",
    input: { plan: "test" },
  },
});
if (!parsed || parsed.requestId !== "req_1" || parsed.toolName !== "ExitPlanMode") {
  throw new Error(`parseCanUseToolRequest failed: ${JSON.stringify(parsed)}`);
}

const parsedNoId = parseCanUseToolRequest({
  type: "control_request",
  request: {
    subtype: "can_use_tool",
    tool_name: "Bash",
    input: { command: "ls" },
  },
});
if (!parsedNoId?.requestId || !parsedNoId.requestId.startsWith("perm_")) {
  throw new Error(`parseCanUseToolRequest missing request_id failed: ${JSON.stringify(parsedNoId)}`);
}

if (needsUserApproval("ExitPlanMode", "bypassPermissions")) {
  throw new Error("ExitPlanMode should auto-approve in bypassPermissions");
}
if (!needsUserApproval("ExitPlanMode", "default")) {
  throw new Error("ExitPlanMode should require approval in default mode");
}
if (needsUserApproval("Read", "default")) {
  throw new Error("Read should not require approval in default mode");
}

const allowLine = buildControlResponse("req_1", {
  behavior: "allow",
  updatedInput: { plan: "test" },
});
if (allowLine.response.response.behavior !== "allow") {
  throw new Error("buildControlResponse allow failed");
}

const interruptLine = buildInterruptRequest();
if (interruptLine.request?.subtype !== "interrupt") {
  throw new Error("buildInterruptRequest failed");
}

const permLine = buildSetPermissionModeRequest("acceptEdits");
if (permLine.request?.mode !== "acceptEdits") {
  throw new Error("buildSetPermissionModeRequest failed");
}

const blocks = buildUserContentBlocks("hello", []);
if (blocks.length !== 1 || blocks[0].type !== "text") {
  throw new Error("buildUserContentBlocks text failed");
}

const payload = buildUserMessagePayload({ text: "hi", sessionId: "sess_1" });
if (!payload || payload.session_id !== "sess_1") {
  throw new Error("buildUserMessagePayload session_id failed");
}

if (hasSendableContent("  ", [])) {
  throw new Error("hasSendableContent should be false for empty");
}
if (!hasSendableContent("ok", [])) {
  throw new Error("hasSendableContent should be true for text");
}

const remember = buildRememberAllowPermissions("Bash");
if (!remember[0]?.tool_name || remember[0].tool_name !== "Bash") {
  throw new Error("buildRememberAllowPermissions failed");
}

const cancelLine = buildControlCancelRequest("req_cancel");
if (cancelLine.request_id !== "req_cancel") {
  throw new Error("buildControlCancelRequest failed");
}

const envLine = buildUpdateEnvironmentVariablesRequest({ ANTHROPIC_MODEL: "test" });
if (envLine.variables?.ANTHROPIC_MODEL !== "test") {
  throw new Error("buildUpdateEnvironmentVariablesRequest failed");
}

const allowRemember = buildControlResponse("req_2", {
  behavior: "allow",
  updatedInput: {},
  updatedPermissions: remember,
});
if (!allowRemember.response.response.updatedPermissions) {
  throw new Error("buildControlResponse updatedPermissions failed");
}

const parentPayload = buildUserMessagePayload({
  text: "nested",
  parentToolUseId: "toolu_abc",
});
if (parentPayload.parent_tool_use_id !== "toolu_abc") {
  throw new Error("buildUserMessagePayload parent_tool_use_id failed");
}

const planPreview = resolvePlanPreview({ plan: "# Title\n\nBody" });
if (!planPreview.includes("Title")) {
  throw new Error("resolvePlanPreview inline failed");
}

const registry = new SessionTurnState();
registry.begin("s1");
if (!registry.has("s1")) throw new Error("SessionTurnState begin failed");
registry.setPhase("s1", "permission");
const snap = registry.snapshot("s1", null);
if (!snap.active || snap.phase !== "permission") {
  throw new Error(`SessionTurnState snapshot failed: ${JSON.stringify(snap)}`);
}
registry.end("s1");
if (registry.has("s1")) throw new Error("SessionTurnState end failed");

if (!isResumeFailureMessage("Failed to resume session abc")) {
  throw new Error("isResumeFailureMessage resume failed");
}
if (isResumeFailureMessage("network timeout")) {
  throw new Error("isResumeFailureMessage false positive");
}

const require = createRequire(import.meta.url);
const {
  bundledCatalogRoots,
  resolveBundledCatalogDir,
  isBundledInCatalog,
} = require("../src/main/skill-bundled-catalog.js");

const roots = bundledCatalogRoots();
if (!roots.some((r) => r.includes("skills-catalog"))) {
  throw new Error(`bundledCatalogRoots missing skills-catalog: ${roots.join("|")}`);
}
if (!isBundledInCatalog("anthropics-algorithmic-art")) {
  throw new Error("isBundledInCatalog sample skill failed");
}
if (!resolveBundledCatalogDir("anthropics-algorithmic-art")) {
  throw new Error("resolveBundledCatalogDir sample skill failed");
}

const compact = classifyEngineEvent({ type: "system", subtype: "compact_boundary" });
if (!compact || compact.code !== "compactBoundary") {
  throw new Error(`compact_boundary classify failed: ${JSON.stringify(compact)}`);
}

const retry = classifyEngineEvent({
  type: "system",
  subtype: "api_retry",
  attempt: 2,
  max_retries: 5,
  error: "rate_limit",
});
if (!retry || retry.code !== "apiRetry" || retry.attempt !== 2) {
  throw new Error(`api_retry classify failed: ${JSON.stringify(retry)}`);
}

const hook = noticeForControlSubtype("hook_callback");
if (!hook || hook.code !== "hookCallback") {
  throw new Error(`hook_callback notice failed: ${JSON.stringify(hook)}`);
}

const taskUpdated = classifyEngineEvent({ type: "system", subtype: "task_updated" });
if (taskUpdated !== null) {
  throw new Error(`task_updated should be silent, got ${JSON.stringify(taskUpdated)}`);
}

const taskProgress = classifyEngineEvent({ type: "system", subtype: "task_progress" });
if (taskProgress !== null) {
  throw new Error(`task_progress should be silent, got ${JSON.stringify(taskProgress)}`);
}

const unknownSystem = classifyEngineEvent({ type: "system", subtype: "some_new_internal" });
if (unknownSystem !== null) {
  throw new Error(`unknown system subtype should be silent, got ${JSON.stringify(unknownSystem)}`);
}

const compactDone = classifyEngineEvent({ type: "system", subtype: "compact_complete" });
if (!compactDone || compactDone.code !== "compactComplete") {
  throw new Error(`compact_complete should have code compactComplete, got ${JSON.stringify(compactDone)}`);
}
if (compactDone.replacesCode !== "compactBoundary") {
  throw new Error(`compact_complete should replace compactBoundary, got ${compactDone.replacesCode}`);
}

console.log("agent-runner: ok");
