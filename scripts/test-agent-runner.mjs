#!/usr/bin/env node
/**
 * Lightweight checks for stream-json helpers (no Electron / no engine binary).
 */
import { createRequire } from "node:module";
import {
  appendTextSegment,
  sanitizeError,
  classifyAssistantError,
  isUpstreamApiFailure,
  normalizeAssistantOutput,
} from "../src/main/agent-runner.js";
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
import { isResumeFailureMessage } from "../src/main/session-engine-recovery.js";
import {
  classifyEngineEvent,
  noticeForControlSubtype,
} from "../src/main/runtime/adapters/engine-event-notices.js";
import {
  normalizeClaudeEvent,
  normalizeAskUserQuestions,
} from "../src/main/runtime/adapters/claude-event-normalizer.js";

function mockOrchestrator(hooks = {}) {
  const notices = hooks.notices || [];
  const usage = hooks.usage || [];
  const done = hooks.done || (() => {});
  return {
    ingest(_sessionId, drafts) {
      for (const draft of drafts || []) {
        if (draft.type === "engine.notice" || draft.type === "engine.warning") {
          notices.push(draft.payload?.notice || draft.payload);
        }
        if (draft.type === "usage.updated") {
          usage.push(draft.payload || {});
        }
      }
    },
    notifyRunnerDone: done,
    notifyRunnerError: () => {},
  };
}

const merged = appendTextSegment("hello", "world");
if (merged !== "hello\n\nworld") throw new Error(`appendTextSegment failed: ${merged}`);

const friendly = sanitizeError("engine-upstream: command not found");
if (friendly.includes("engine-upstream") || friendly.includes("command not found")) {
  throw new Error(`sanitizeError failed: ${friendly}`);
}

const socketErr = sanitizeError(
  "API Error: The socket connection was closed unexpectedly. For more information, pass `verbose: true` in the second argument to fetch()",
);
if (!socketErr.toLowerCase().includes("interrupted")) {
  throw new Error(`sanitizeError socket failed: ${socketErr}`);
}
if (!isUpstreamApiFailure("API Error: socket connection was closed")) {
  throw new Error("isUpstreamApiFailure failed");
}
const modelFailure = classifyAssistantError("There's an issue with the selected model. Run --model to pick a different model.");
if (modelFailure?.code !== "MODEL_UNAVAILABLE" || modelFailure.retryable !== true) {
  throw new Error(`classifyAssistantError model failed: ${JSON.stringify(modelFailure)}`);
}
const deniedFailure = classifyAssistantError("EACCES: permission denied, open /private/file");
if (deniedFailure?.code !== "PERMISSION_DENIED" || deniedFailure.retryable !== false) {
  throw new Error(`classifyAssistantError permission failed: ${JSON.stringify(deniedFailure)}`);
}
const budgetFailure = classifyAssistantError("Maximum budget exceeded");
if (budgetFailure?.code !== "BUDGET_EXCEEDED" || budgetFailure.retryable !== false) {
  throw new Error(`classifyAssistantError budget failed: ${JSON.stringify(budgetFailure)}`);
}
const quotedErrorAnswer = normalizeAssistantOutput("截图里写着 API Error: timeout。原因可能是网络。");
if (quotedErrorAnswer.failed || !quotedErrorAnswer.text.includes("API Error")) {
  throw new Error(`assistant text containing error words must stay normal output: ${JSON.stringify(quotedErrorAnswer)}`);
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
    suggestions: [{ type: "allow", tool_name: "Bash", rule: "ls" }],
  },
});
if (!parsedNoId?.requestId || !parsedNoId.requestId.startsWith("perm_")) {
  throw new Error(`parseCanUseToolRequest missing request_id failed: ${JSON.stringify(parsedNoId)}`);
}
if (parsedNoId.suggestions?.[0]?.rule !== "ls") {
  throw new Error(`parseCanUseToolRequest suggestions failed: ${JSON.stringify(parsedNoId)}`);
}

if (needsUserApproval("ExitPlanMode", "bypassPermissions")) {
  throw new Error("ExitPlanMode should auto-approve in bypassPermissions");
}
if (!needsUserApproval("ExitPlanMode", "default")) {
  throw new Error("ExitPlanMode should require approval in default mode");
}
if (!needsUserApproval("Read", "default")) {
  throw new Error("host must not auto-allow Read when Claude CLI explicitly asks for a decision");
}
if (!needsUserApproval("Edit", "acceptEdits")) {
  throw new Error("host must not auto-allow Edit when Claude CLI explicitly asks for a decision");
}
if (!needsUserApproval("Bash", "auto")) {
  throw new Error("auto mode decisions belong to Claude CLI; host prompts when asked");
}
if (!needsUserApproval("ExitPlanMode", "plan")) {
  throw new Error("plan mode decisions belong to Claude CLI; host prompts when asked");
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

// Remember-rules follow the CLI PermissionUpdate schema and persist to
// localSettings so approval survives runner restarts.
const remember = buildRememberAllowPermissions("Bash");
if (
  remember[0]?.type !== "addRules" ||
  remember[0]?.rules?.[0]?.toolName !== "Bash" ||
  remember[0]?.behavior !== "allow" ||
  remember[0]?.destination !== "localSettings"
) {
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

const askQuestion = buildControlResponse("req_question", {
  behavior: "allow",
  updatedInput: {
    questions: [{ id: "mode", question: "Pick mode", multiSelect: false }],
    answers: { "Pick mode": "Fast" },
  },
});
if (askQuestion.response.response.updatedInput?.answers?.["Pick mode"] !== "Fast") {
  throw new Error("AskUserQuestion response payload failed");
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
const { AgentSession } = require("../src/main/agent-session.js");

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

const permissionDenied = classifyEngineEvent({ type: "system", subtype: "permission_denied" });
if (!permissionDenied || permissionDenied.code !== "permissionDenied" || permissionDenied.level !== "warning") {
  throw new Error(`permission_denied classify failed: ${JSON.stringify(permissionDenied)}`);
}

	const hook = noticeForControlSubtype("hook_callback");
	if (hook !== null) {
	  throw new Error(`hook_callback notice should be null (per-hook-kind notices now in normalizer), got: ${JSON.stringify(hook)}`);
	}

const taskUpdated = classifyEngineEvent({ type: "system", subtype: "task_updated" });
if (!taskUpdated || taskUpdated.code !== "taskProgress" || taskUpdated.level !== "progress" || taskUpdated.panel !== true) {
  throw new Error(`task_updated should be visible progress, got ${JSON.stringify(taskUpdated)}`);
}

const taskProgress = classifyEngineEvent({
  type: "system",
  subtype: "task_progress",
  message: "Writing chapter 41",
});
if (
  !taskProgress ||
  taskProgress.code !== "taskProgress" ||
  taskProgress.detail !== "Writing chapter 41" ||
  taskProgress.panel !== true
) {
  throw new Error(`task_progress should expose live task detail, got ${JSON.stringify(taskProgress)}`);
}

const systemStatus = classifyEngineEvent({
  type: "system",
  subtype: "status",
  status: "Reading recent chapters",
});
if (
  !systemStatus ||
  systemStatus.code !== "taskProgress" ||
  systemStatus.level !== "progress" ||
  systemStatus.detail !== "Reading recent chapters" ||
  systemStatus.panel !== true
) {
  throw new Error(`system/status should expose live task detail, got ${JSON.stringify(systemStatus)}`);
}

const requestingStatus = classifyEngineEvent({
  type: "system",
  subtype: "status",
  status: "requesting",
});
if (
  !requestingStatus ||
  requestingStatus.code !== "thinkingProgress" ||
  requestingStatus.level !== "progress"
) {
  throw new Error(`system/status requesting should merge into thinking progress, got ${JSON.stringify(requestingStatus)}`);
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

const normalizedQuestion = normalizeClaudeEvent({
  type: "control_request",
  request_id: "req_question_adapter",
  request: {
    subtype: "can_use_tool",
    tool_name: "AskUserQuestion",
    input: { question: "下一步怎么做？" },
  },
});
if (
  normalizedQuestion[0]?.kind !== "ask_user_question" ||
  normalizedQuestion[0]?.questions?.[0]?.question !== "下一步怎么做？"
) {
  throw new Error(`normalizeClaudeEvent AskUserQuestion failed: ${JSON.stringify(normalizedQuestion)}`);
}

const normalizedPermission = normalizeClaudeEvent({
  type: "sdk_control_request",
  request_id: "req_perm_adapter",
  request: {
    subtype: "permission",
    tool_name: "Bash",
    tool_input: { command: "ls" },
  },
});
if (normalizedPermission[0]?.kind !== "permission_check" || normalizedPermission[0]?.toolName !== "Bash") {
  throw new Error(`normalizeClaudeEvent permission failed: ${JSON.stringify(normalizedPermission)}`);
}

const normalizedControlResponse = normalizeClaudeEvent({
  type: "control_response",
  response: { behavior: "allow" },
});
if (
  normalizedControlResponse.length !== 1 ||
  normalizedControlResponse[0]?.kind !== "control_response"
) {
  throw new Error(`normalizeClaudeEvent control_response failed: ${JSON.stringify(normalizedControlResponse)}`);
}

const normalizedText = normalizeClaudeEvent({
  type: "stream_event",
  event: {
    type: "content_block_delta",
    index: 0,
    delta: { type: "text_delta", text: "hello" },
  },
});
if (normalizedText[0]?.kind !== "assistant_text" || normalizedText[0]?.text !== "hello") {
  throw new Error(`normalizeClaudeEvent text delta failed: ${JSON.stringify(normalizedText)}`);
}

const normalizedThinking = normalizeClaudeEvent({
  type: "stream_event",
  event: {
    type: "content_block_delta",
    index: 0,
    delta: { type: "thinking_delta", thinking: "I should inspect the repo." },
  },
});
if (normalizedThinking[0]?.kind !== "assistant_thinking" || normalizedThinking[0]?.text !== "I should inspect the repo.") {
  throw new Error(`normalizeClaudeEvent thinking delta failed: ${JSON.stringify(normalizedThinking)}`);
}

const normalizedStringToolResult = normalizeClaudeEvent({
  type: "user",
  message: {
    content: [{
      type: "tool_result",
      toolUseId: "tool_string_result",
      content: "uploaded 42%",
    }],
  },
});
if (
  normalizedStringToolResult[0]?.kind !== "tool_result" ||
  normalizedStringToolResult[0]?.id !== "tool_string_result" ||
  normalizedStringToolResult[0]?.content !== "uploaded 42%"
) {
  throw new Error(`string tool_result should be preserved: ${JSON.stringify(normalizedStringToolResult)}`);
}

const normalizedObjectToolResult = normalizeClaudeEvent({
  type: "user",
  message: {
    content: [{
      type: "tool_result",
      tool_id: "tool_object_result",
      content: { stdout: "sent 1MB", stderr: "retry 1" },
    }],
  },
});
if (
  normalizedObjectToolResult[0]?.kind !== "tool_result" ||
  normalizedObjectToolResult[0]?.id !== "tool_object_result" ||
  normalizedObjectToolResult[0]?.content !== "sent 1MB\nretry 1"
) {
  throw new Error(`object tool_result should expose stdout/stderr: ${JSON.stringify(normalizedObjectToolResult)}`);
}

const unknownRuntime = normalizeClaudeEvent({ type: "new_runtime_event", subtype: "mystery" });
if (unknownRuntime[0]?.kind !== "unknown_runtime_event" || unknownRuntime[0]?.notice?.level !== "warning") {
  throw new Error(`unknown runtime event should be visible warning: ${JSON.stringify(unknownRuntime)}`);
}

const unknownSystemNormalized = normalizeClaudeEvent({
  type: "system",
  subtype: "new_protocol_shape",
});
if (unknownSystemNormalized[0]?.kind !== "protocol_warning") {
  throw new Error(`unknown system subtype should become protocol_warning: ${JSON.stringify(unknownSystemNormalized)}`);
}

const permissionDeniedNormalized = normalizeClaudeEvent({
  type: "system",
  subtype: "permission_denied",
});
if (
  permissionDeniedNormalized[0]?.kind !== "system_notice" ||
  permissionDeniedNormalized[0]?.notice?.code !== "permissionDenied"
) {
  throw new Error(`permission_denied should become known system_notice: ${JSON.stringify(permissionDeniedNormalized)}`);
}

const commandsChangedNormalized = normalizeClaudeEvent({
  type: "system",
  subtype: "commands_changed",
});
if (
  commandsChangedNormalized[0]?.kind !== "system_notice" ||
  commandsChangedNormalized[0]?.notice != null
) {
  throw new Error(`commands_changed should be silent system_notice: ${JSON.stringify(commandsChangedNormalized)}`);
}
if (commandsChangedNormalized.some((action) => action.kind === "protocol_warning")) {
  throw new Error("commands_changed must not emit protocol_warning");
}

const taskProgressNormalized = normalizeClaudeEvent({
  type: "system",
  subtype: "task_progress",
  message: "Writing chapter 41",
});
if (
  taskProgressNormalized[0]?.kind !== "system_notice" ||
  taskProgressNormalized[0]?.notice?.code !== "taskProgress"
) {
  throw new Error(`task_progress should become visible progress: ${JSON.stringify(taskProgressNormalized)}`);
}

const toolProgressNormalized = normalizeClaudeEvent({
  type: "tool_progress",
  tool_name: "Bash",
  message: "Uploading layer 42%",
});
if (
  toolProgressNormalized[0]?.kind !== "engine_notice" ||
  toolProgressNormalized[0]?.notice?.code !== "toolProgress" ||
  toolProgressNormalized[0]?.notice?.panel !== true ||
  toolProgressNormalized[0]?.notice?.detail !== "Uploading layer 42%"
) {
  throw new Error(`tool_progress should become visible tool progress: ${JSON.stringify(toolProgressNormalized)}`);
}

const statusNormalized = normalizeClaudeEvent({
  type: "system",
  subtype: "status",
  status: "Reading recent chapters",
});
if (
  statusNormalized[0]?.kind !== "system_notice" ||
  statusNormalized[0]?.notice?.code !== "taskProgress"
) {
  throw new Error(`system/status should become visible progress: ${JSON.stringify(statusNormalized)}`);
}

const thinkingTokensNormalized = normalizeClaudeEvent({
  type: "system",
  subtype: "thinking_tokens",
  estimated_tokens: 100,
});
if (
  thinkingTokensNormalized[0]?.kind !== "system_notice" ||
  thinkingTokensNormalized[0]?.notice?.code !== "thinkingProgress" ||
  thinkingTokensNormalized[0]?.notice?.detail !== "100 tokens"
) {
  throw new Error(`thinking_tokens should become visible thinking progress: ${JSON.stringify(thinkingTokensNormalized)}`);
}

const fallbackQuestions = normalizeAskUserQuestions({ prompt: "请补充方向" });
if (fallbackQuestions[0]?.question !== "请补充方向") {
  throw new Error(`normalizeAskUserQuestions fallback failed: ${JSON.stringify(fallbackQuestions)}`);
}

const originalTurnResponseTimeout = AgentSession.TURN_RESPONSE_TIMEOUT_MS;
const originalResumeTurnTimeout = AgentSession.RESUME_TURN_TIMEOUT_MS;
AgentSession.TURN_RESPONSE_TIMEOUT_MS = 5;
AgentSession.RESUME_TURN_TIMEOUT_MS = 5;
try {
  const session = new AgentSession("timer_test");
  let doneCount = 0;
  const notices = [];
  session.bindOrchestrator(mockOrchestrator({
    notices,
    done: () => { doneCount += 1; },
  }));
  session.busy = true;
  session._turnSettled = false;
  session._armTurnResponseTimer();
  await new Promise((resolve) => setTimeout(resolve, 20));
  session._clearTurnResponseTimer();
  if (doneCount !== 0 || !session.busy || session._turnSettled) {
    throw new Error("silence timeout should not complete or stall an active turn");
  }
  if (!notices.some((notice) => notice.code === "longWait" && notice.reason === "silence")) {
    throw new Error(`silence timeout should emit longWait notice: ${JSON.stringify(notices)}`);
  }
} finally {
  AgentSession.TURN_RESPONSE_TIMEOUT_MS = originalTurnResponseTimeout;
  AgentSession.RESUME_TURN_TIMEOUT_MS = originalResumeTurnTimeout;
}

{
  const session = new AgentSession("thinking_tokens_test");
  const notices = [];
  const usage = [];
  session.bindOrchestrator(mockOrchestrator({ notices, usage }));
  session.busy = true;
  session._turnSettled = false;
  session._sawStdoutForTurn = true;
  session._handleLine(JSON.stringify({
    type: "system",
    subtype: "thinking_tokens",
    estimated_tokens: 126,
    estimated_tokens_delta: 2,
  }));
  if (notices.length !== 0) {
    throw new Error(`thinking token updates should not render as process notices: ${JSON.stringify(notices)}`);
  }
  if (usage[0]?.estimatedTokens !== 126 || usage[0]?.estimatedTokensDelta !== 2) {
    throw new Error(`thinking token updates should emit usage payload: ${JSON.stringify(usage)}`);
  }
}

{
  const session = new AgentSession("send_payload_test");
  const written = [];
  session.process = {
    killed: false,
    stdin: {
      destroyed: false,
      write(line, cb) {
        written.push(JSON.parse(line));
        cb?.();
        return true;
      },
      once() {},
    },
  };
  session.cwd = process.cwd();
  session.spawnOptions = { agentCommand: "/tmp/fake", permissionMode: "default" };
  const sent = session.sendUserMessage({ text: "hello", files: [] });
  session._clearTurnResponseTimer();
  session._clearAbsoluteTurnTimer();
  session._clearWaitNoticeTimers();
  if (!sent) throw new Error("sendUserMessage should accept text payload");
  if (written.length !== 1 || written[0].type !== "user") {
    throw new Error(`sendUserMessage should write only the user payload, got ${JSON.stringify(written)}`);
  }
}

{
  const session = new AgentSession("process_event_test");
  const processEvents = [];
  session.bindOrchestrator({
    ingest(_sessionId, drafts) {
      for (const draft of drafts || []) {
        if (draft.type === "process.event") processEvents.push(draft.payload);
      }
    },
    notifyRunnerDone: () => {},
    notifyRunnerError: () => {},
  });
  session.busy = true;
  session._turnSettled = false;
  session._sawStdoutForTurn = true;
  session._handleLine(JSON.stringify({
    type: "stream_event",
    event: {
      type: "content_block_delta",
      index: 0,
      delta: {
        type: "thinking_delta",
        thinking: "I should inspect files.",
      },
    },
    session_id: "sess_process",
  }));
  if (processEvents.length !== 1) {
    throw new Error(`CLI stdout should emit one process-event, got ${processEvents.length}`);
  }
  if (processEvents[0].rawType !== "stream_event" || processEvents[0].rawSubtype !== "content_block_delta") {
    throw new Error(`process-event should preserve raw type/subtype: ${JSON.stringify(processEvents[0])}`);
  }
  if (processEvents[0].actions?.[0]?.kind !== "assistant_thinking") {
    throw new Error(`process-event should include normalized action detail: ${JSON.stringify(processEvents[0])}`);
  }
  session.busy = false;
  session._turnSettled = true;
  session._clearTurnResponseTimer();
  session._clearAbsoluteTurnTimer();
  session._clearWaitNoticeTimers();
  session._clearIdleTimer();
  session._clearMessageStopTimer();
}

console.log("agent-runner: ok");
