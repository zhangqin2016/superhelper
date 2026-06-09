#!/usr/bin/env node
/**
 * Agent tool lease checks: shell tools keep the turn busy until tool_result,
 * while explicitly detached shell commands do not block turn auto-completion.
 */
import { AgentSession } from "../src/main/agent-session.js";
import module from "node:module";

const require = module.createRequire(import.meta.url);

function createTestSession(sessionId) {
  const runner = new AgentSession(sessionId);
  runner.bindOrchestrator({
    ingest(_sid, drafts) {
      for (const draft of drafts || []) {
        switch (draft.type) {
          case "engine.notice":
          case "engine.warning":
            runner.emit("engine-notice", draft.payload?.notice || draft.payload);
            break;
          case "tool.done":
            runner.emit("tool-done", draft.payload);
            break;
          case "permission.requested":
            runner.emit("permission-request", draft.payload);
            break;
          case "user_question.requested":
            runner.emit("ask-user-question", {
              requestId: draft.payload.requestId,
              questions: draft.payload.questions,
              input: draft.payload.input,
            });
            break;
          case "hook.requested":
            runner.emit("hook-request", draft.payload);
            break;
          default:
            break;
        }
      }
    },
    notifyRunnerDone(_sid, payload) {
      runner.emit("done", payload);
    },
    notifyRunnerError(_sid, message) {
      runner.emit("error", message);
    },
  });
  return runner;
}

function startSyntheticTurn(runner) {
  runner.busy = true;
  runner._turnSettled = false;
  runner.collectedOutput = "partial answer";
  runner._pendingToolIds.clear();
  runner._toolLeases.clear();
  runner._pendingPermissions.clear();
}

function line(runner, event) {
  runner._handleLine(JSON.stringify(event));
}

const runner = createTestSession("sess_tool_lease");
AgentSession.TOOL_LONG_TASK_NOTICE_MS = 5;
AgentSession.FIRST_RESPONSE_NOTICE_MS = 5;
AgentSession.LONG_WAIT_NOTICE_MS = 10;
AgentSession.MESSAGE_STOP_GRACE_MS = 5;
AgentSession.QUIESCE_MS = 5;
AgentSession.TOOL_LONG_TASK_HEARTBEAT_MS = 10;
AgentSession.TURN_ABSOLUTE_MAX_MS = 10;
AgentSession.DEFERRED_TURN_RESULT_GRACE_MS = 5;

const waitRunner = createTestSession("sess_wait_notices");
const waitNotices = [];
waitRunner.on("engine-notice", (notice) => waitNotices.push(notice));
startSyntheticTurn(waitRunner);
waitRunner.collectedOutput = "";
waitRunner._armWaitNoticeTimers();
await new Promise((resolve) => setTimeout(resolve, 35));
if (!waitNotices.some((notice) => notice.code === "waitingForFirstResponse")) {
  throw new Error("first-response wait notice should be emitted");
}
if (!waitNotices.some((notice) => notice.code === "longWait")) {
  throw new Error("long-wait notice should be emitted");
}
waitRunner._completeTurn({ code: 0, output: "" });

const resumeRunner = createTestSession("sess_resume_failure");
resumeRunner.agentResumeId = "old_resume_id";
let resumeInvalid = false;
let resumeError = "";
resumeRunner.on("resume-invalid", () => {
  resumeInvalid = true;
});
resumeRunner.on("error", (message) => {
  resumeError = message;
});
startSyntheticTurn(resumeRunner);
line(resumeRunner, {
  type: "error",
  message: "Session ID 0dde83a7-4050-4b94-a3a2-014d96766c0d is already in use.",
});
if (!resumeInvalid) {
  throw new Error("resume failure should emit resume-invalid");
}
if (
  resumeError.includes("Session ID") ||
  !resumeError.toLowerCase().includes("connection has been refreshed")
) {
  throw new Error(`resume failure should be user-friendly, got: ${resumeError}`);
}

const remoteConfigPath = require.resolve("../src/main/remote-config.js");
let refreshReason = "";
require.cache[remoteConfigPath] = {
  id: remoteConfigPath,
  filename: remoteConfigPath,
  loaded: true,
  exports: {
    refreshRemoteConfig: async (payload = {}) => {
      refreshReason = payload.reason || "";
      return { ok: true };
    },
  },
};
const stderrFailureRunner = createTestSession("sess_stderr_model_failure");
let stderrFailureError = "";
let stderrFailureTerminated = false;
stderrFailureRunner.process = {
  kill: () => {
    stderrFailureTerminated = true;
  },
};
stderrFailureRunner.on("error", (message) => {
  stderrFailureError = message;
});
startSyntheticTurn(stderrFailureRunner);
stderrFailureRunner._handleStderr(
  "There's an issue with the selected model (qwen3-coder-plus). It may not exist or you may not have access to it. Run --model to pick a different model.",
);
await new Promise((resolve) => setTimeout(resolve, 0));
if (
  stderrFailureError.includes("qwen3-coder-plus") ||
  !stderrFailureError.toLowerCase().includes("selected model")
) {
  throw new Error(`model stderr failure should settle turn with sanitized error: ${stderrFailureError}`);
}
if (stderrFailureRunner.busy || !stderrFailureRunner._turnSettled || !stderrFailureTerminated) {
  throw new Error("model stderr failure should end turn and restart the runner");
}
if (refreshReason !== "upstream_api_failure") {
  throw new Error(`model stderr failure should refresh remote config, got: ${refreshReason}`);
}

startSyntheticTurn(runner);
line(runner, {
  type: "stream_event",
  event: {
    type: "content_block_start",
    index: 0,
    content_block: { type: "tool_use", id: "tool_bash_1", name: "Bash" },
  },
});

if (runner._canAutoCompleteTurn()) {
  throw new Error("running Bash lease should block auto completion before tool_result");
}

const notice = await new Promise((resolve) => {
  runner.once("engine-notice", resolve);
  setTimeout(() => resolve(null), 100);
});
if (notice?.code !== "shellLongRunning") {
  throw new Error("running Bash lease should emit long-running notice");
}

line(runner, {
  type: "user",
  message: {
    content: [
      {
        type: "tool_result",
        tool_use_id: "tool_bash_1",
        content: [{ type: "text", text: "done" }],
      },
    ],
  },
});
if (runner._pendingToolIds.size !== 0 || runner._toolLeases.size !== 0) {
  throw new Error("tool_result should release Bash lease");
}
if (runner._canAutoCompleteTurn()) {
  throw new Error("foreground tool turns should wait for CLI result event");
}

const resultBeforeToolRunner = createTestSession("sess_result_before_tool_done");
const resultBeforeToolEvents = [];
resultBeforeToolRunner.on("tool-done", () => {
  resultBeforeToolEvents.push("tool-done");
});
resultBeforeToolRunner.on("done", () => {
  resultBeforeToolEvents.push("done");
});
startSyntheticTurn(resultBeforeToolRunner);
line(resultBeforeToolRunner, {
  type: "stream_event",
  event: {
    type: "content_block_start",
    index: 0,
    content_block: { type: "tool_use", id: "tool_write_pending", name: "Write" },
  },
});
line(resultBeforeToolRunner, {
  type: "result",
  subtype: "success",
  result: "write finished",
});
if (resultBeforeToolEvents.includes("done") || !resultBeforeToolRunner.busy) {
  throw new Error("result must not complete while a tool lease is still pending");
}
if (!resultBeforeToolRunner._deferredTurnResult) {
  throw new Error("early result should be deferred until tool_result releases the lease");
}
line(resultBeforeToolRunner, {
  type: "user",
  message: {
    content: [
      {
        type: "tool_result",
        tool_use_id: "tool_write_pending",
        content: [{ type: "text", text: "file written" }],
      },
    ],
  },
});
if (
  !resultBeforeToolEvents.includes("tool-done")
  || !resultBeforeToolEvents.includes("done")
  || resultBeforeToolEvents.length !== 2
) {
  throw new Error(`deferred result should complete after tool-done, got ${resultBeforeToolEvents.join(",")}`);
}

const missingToolResultRunner = createTestSession("sess_missing_tool_result_grace");
let missingToolResultDone = false;
missingToolResultRunner.on("done", () => {
  missingToolResultDone = true;
});
startSyntheticTurn(missingToolResultRunner);
line(missingToolResultRunner, {
  type: "stream_event",
  event: {
    type: "content_block_start",
    index: 0,
    content_block: { type: "tool_use", id: "tool_missing_result", name: "Bash" },
  },
});
line(missingToolResultRunner, {
  type: "result",
  subtype: "success",
  result: "final answer already visible",
});
if (missingToolResultDone) {
  throw new Error("missing tool_result turn should not complete before grace");
}
await new Promise((resolve) => setTimeout(resolve, 30));
if (!missingToolResultDone || missingToolResultRunner.busy || !missingToolResultRunner._turnSettled) {
  throw new Error("missing tool_result turn should complete after short final-result grace");
}

const backgroundStatusRunner = createTestSession("sess_background_status_result");
let backgroundStatusDone = false;
backgroundStatusRunner.on("done", () => {
  backgroundStatusDone = true;
});
startSyntheticTurn(backgroundStatusRunner);
line(backgroundStatusRunner, {
  type: "system",
  subtype: "status",
  status: "thinking",
});
if (backgroundStatusRunner._backgroundActivityUntil <= Date.now()) {
  throw new Error("system/status should mark background activity");
}
line(backgroundStatusRunner, {
  type: "result",
  subtype: "success",
  result: "summary is visible",
});
if (!backgroundStatusDone || backgroundStatusRunner.busy || !backgroundStatusRunner._turnSettled) {
  throw new Error("final result should not wait for background activity window");
}

const toolTurnRunner = createTestSession("sess_tool_message_stop");
let completedAfterMessageStop = false;
toolTurnRunner.on("done", () => {
  completedAfterMessageStop = true;
});
startSyntheticTurn(toolTurnRunner);
line(toolTurnRunner, {
  type: "stream_event",
  event: {
    type: "content_block_start",
    index: 2,
    content_block: { type: "tool_use", id: "tool_write_1", name: "Write" },
  },
});
line(toolTurnRunner, {
  type: "user",
  message: {
    content: [
      {
        type: "tool_result",
        tool_use_id: "tool_write_1",
        content: [{ type: "text", text: "file written" }],
      },
    ],
  },
});
line(toolTurnRunner, {
  type: "stream_event",
  event: { type: "message_stop" },
});
await new Promise((resolve) => setTimeout(resolve, 30));
if (completedAfterMessageStop) {
  throw new Error("tool turns must not complete from message_stop grace without final result");
}
toolTurnRunner._completeTurn({ code: 0, output: "" });

const textFallbackRunner = createTestSession("sess_text_message_stop");
let textFallbackDone = false;
textFallbackRunner.on("done", () => {
  textFallbackDone = true;
});
startSyntheticTurn(textFallbackRunner);
line(textFallbackRunner, {
  type: "assistant",
  message: { content: [{ type: "text", text: "plain text answer" }] },
});
line(textFallbackRunner, {
  type: "stream_event",
  event: { type: "message_stop" },
});
await new Promise((resolve) => setTimeout(resolve, 30));
if (!textFallbackDone) {
  throw new Error("pure text turns may still use message_stop fallback when result is missing");
}

const hugeToolRunner = createTestSession("sess_huge_tool_output");
let hugeToolDone = null;
hugeToolRunner.on("tool-done", (payload) => {
  hugeToolDone = payload;
});
startSyntheticTurn(hugeToolRunner);
line(hugeToolRunner, {
  type: "stream_event",
  event: {
    type: "content_block_start",
    index: 9,
    content_block: { type: "tool_use", id: "tool_huge_1", name: "Bash" },
  },
});
line(hugeToolRunner, {
  type: "user",
  message: {
    content: [
      {
        type: "tool_result",
        tool_use_id: "tool_huge_1",
        content: [{ type: "text", text: "x".repeat(20_000) }],
      },
    ],
  },
});
if (!hugeToolDone?.result?.truncated) {
  throw new Error("huge tool output should be marked truncated for UI");
}
if (hugeToolDone.result.content.length > 12_500) {
  throw new Error("huge tool output should be capped before renderer");
}
hugeToolRunner._completeTurn({ code: 0, output: "" });

startSyntheticTurn(runner);
line(runner, {
  type: "stream_event",
  event: {
    type: "content_block_start",
    index: 1,
    content_block: { type: "tool_use", id: "tool_bash_2", name: "Bash" },
  },
});
line(runner, {
  type: "stream_event",
  event: {
    type: "content_block_delta",
    index: 1,
    delta: {
      type: "input_json_delta",
      partial_json: JSON.stringify({
        command: "nohup npm run dev > /tmp/app.log 2>&1 &",
      }),
    },
  },
});
line(runner, {
  type: "stream_event",
  event: { type: "content_block_stop", index: 1 },
});

if (!runner._canAutoCompleteTurn()) {
  throw new Error("detached Bash command should not block auto completion");
}

runner._completeTurn({ code: 0, output: "" });

const semanticDetachedRunner = createTestSession("sess_semantic_detached");
let semanticDetachedNotice = null;
let semanticDetachedTool = null;
semanticDetachedRunner.on("engine-notice", (payload) => {
  if (payload.code === "shellDetached") semanticDetachedNotice = payload;
});
semanticDetachedRunner.on("tool-done", (payload) => {
  semanticDetachedTool = payload;
});
startSyntheticTurn(semanticDetachedRunner);
line(semanticDetachedRunner, {
  type: "stream_event",
  event: {
    type: "content_block_start",
    index: 2,
    content_block: { type: "tool_use", id: "tool_bash_dev", name: "Bash" },
  },
});
line(semanticDetachedRunner, {
  type: "stream_event",
  event: {
    type: "content_block_delta",
    index: 2,
    delta: {
      type: "input_json_delta",
      partial_json: JSON.stringify({ command: "npm run dev -- --host 0.0.0.0" }),
    },
  },
});
line(semanticDetachedRunner, {
  type: "stream_event",
  event: { type: "content_block_stop", index: 2 },
});
if (!semanticDetachedRunner._canAutoCompleteTurn()) {
  throw new Error("semantic long-running dev command should not block auto completion");
}
if (semanticDetachedNotice?.code !== "shellDetached") {
  throw new Error("semantic detached command should emit a detached notice");
}
if (!semanticDetachedTool?.result?.detached) {
  throw new Error("semantic detached command should mark the tool card done");
}
semanticDetachedRunner._completeTurn({ code: 0, output: "" });

const foregroundCommandRunner = createTestSession("sess_foreground_command");
startSyntheticTurn(foregroundCommandRunner);
line(foregroundCommandRunner, {
  type: "stream_event",
  event: {
    type: "content_block_start",
    index: 3,
    content_block: { type: "tool_use", id: "tool_bash_test", name: "Bash" },
  },
});
line(foregroundCommandRunner, {
  type: "stream_event",
  event: {
    type: "content_block_delta",
    index: 3,
    delta: {
      type: "input_json_delta",
      partial_json: JSON.stringify({ command: "npm test" }),
    },
  },
});
line(foregroundCommandRunner, {
  type: "stream_event",
  event: { type: "content_block_stop", index: 3 },
});
if (foregroundCommandRunner._canAutoCompleteTurn()) {
  throw new Error("foreground command should still block until tool_result");
}
line(foregroundCommandRunner, {
  type: "user",
  message: {
    content: [
      {
        type: "tool_result",
        tool_use_id: "tool_bash_test",
        content: [{ type: "text", text: "tests passed" }],
      },
    ],
  },
});
if (foregroundCommandRunner._pendingToolIds.size !== 0 || foregroundCommandRunner._toolLeases.size !== 0) {
  throw new Error("foreground command should release lease after tool_result");
}
if (foregroundCommandRunner._canAutoCompleteTurn()) {
  throw new Error("foreground command turn should wait for final result after tool_result");
}
foregroundCommandRunner._completeTurn({ code: 0, output: "" });

const longPushRunner = createTestSession("sess_long_push");
const longPushNotices = [];
let longPushDone = false;
longPushRunner.on("engine-notice", (notice) => {
  if (notice.code === "shellLongRunning") longPushNotices.push(notice);
});
longPushRunner.on("done", () => {
  longPushDone = true;
});
startSyntheticTurn(longPushRunner);
line(longPushRunner, {
  type: "stream_event",
  event: {
    type: "content_block_start",
    index: 4,
    content_block: { type: "tool_use", id: "tool_docker_push", name: "Bash" },
  },
});
line(longPushRunner, {
  type: "stream_event",
  event: {
    type: "content_block_delta",
    index: 4,
    delta: {
      type: "input_json_delta",
      partial_json: JSON.stringify({ command: "docker push registry.example.com/app:latest" }),
    },
  },
});
line(longPushRunner, {
  type: "stream_event",
  event: { type: "content_block_stop", index: 4 },
});
longPushRunner._armAbsoluteTurnTimer();
await new Promise((resolve) => setTimeout(resolve, 35));
if (longPushDone || !longPushRunner.busy || longPushRunner._turnSettled) {
  throw new Error("long foreground shell task must not be completed by absolute timeout");
}
if (longPushNotices.length < 2) {
  throw new Error(`long foreground shell task should emit repeated heartbeat notices, got ${longPushNotices.length}`);
}
if (!longPushNotices.some((entry) => String(entry.detail || "").includes("docker push"))) {
  throw new Error(`long foreground shell task notice should include command detail: ${JSON.stringify(longPushNotices)}`);
}
longPushRunner._completeTurn({ code: 0, output: "" });

AgentSession.INTERRUPT_FALLBACK_MS = 5;
const interrupted = createTestSession("sess_interrupt_fallback");
let killed = false;
interrupted.process = {
  killed: false,
  stdin: { destroyed: false, write: () => true },
  kill: () => {
    killed = true;
  },
};
interrupted.busy = true;
interrupted._turnSettled = false;
const done = new Promise((resolve) => interrupted.once("done", resolve));
interrupted.interrupt();
const donePayload = await done;
await new Promise((resolve) => setTimeout(resolve, 0));
if (!donePayload?.interrupted) {
  throw new Error("interrupt fallback should complete as interrupted");
}
if (!killed || interrupted.process !== null) {
  throw new Error("interrupt fallback should terminate dirty runner");
}

const questionRunner = createTestSession("sess_question");
let writtenControl = "";
questionRunner.process = {
  stdin: {
    destroyed: false,
    write: (line) => {
      writtenControl = line;
      return true;
    },
  },
};
questionRunner.spawnOptions = { permissionMode: "default" };
startSyntheticTurn(questionRunner);
const questionEvent = new Promise((resolve) => {
  questionRunner.once("ask-user-question", resolve);
});
line(questionRunner, {
  type: "control_request",
  request_id: "req_question",
  request: {
    subtype: "can_use_tool",
    tool_name: "AskUserQuestion",
    input: {
      questions: [
        {
          id: "mode",
          question: "Pick a mode",
          multiSelect: true,
          options: [{ label: "Fast" }, { label: "Careful" }],
        },
      ],
    },
  },
});
const questionPayload = await questionEvent;
if (questionPayload.requestId !== "req_question" || questionPayload.questions.length !== 1) {
  throw new Error(`AskUserQuestion event failed: ${JSON.stringify(questionPayload)}`);
}
if (!questionRunner.respondUserQuestion("req_question", { answers: { "Pick a mode": ["Fast"] } })) {
  throw new Error("respondUserQuestion should handle pending question");
}
const parsedControl = JSON.parse(writtenControl);
if (parsedControl.response?.response?.updatedInput?.answers?.["Pick a mode"]?.[0] !== "Fast") {
  throw new Error(`respondUserQuestion control payload failed: ${writtenControl}`);
}

const fallbackQuestionRunner = createTestSession("sess_question_fallback");
let fallbackQuestionPayload = null;
let fallbackQuestionWrite = "";
fallbackQuestionRunner.process = {
  stdin: {
    destroyed: false,
    write: (line) => {
      fallbackQuestionWrite = line;
      return true;
    },
  },
};
fallbackQuestionRunner.spawnOptions = { permissionMode: "default" };
startSyntheticTurn(fallbackQuestionRunner);
fallbackQuestionRunner.once("ask-user-question", (payload) => {
  fallbackQuestionPayload = payload;
});
line(fallbackQuestionRunner, {
  type: "control_request",
  request_id: "req_question_fallback",
  request: {
    subtype: "can_use_tool",
    tool_name: "AskUserQuestion",
    input: {
      question: "你想按什么方向继续？",
    },
  },
});
if (fallbackQuestionPayload?.questions?.[0]?.question !== "你想按什么方向继续？") {
  throw new Error(`AskUserQuestion fallback normalization failed: ${JSON.stringify(fallbackQuestionPayload)}`);
}
if (!fallbackQuestionRunner.respondUserQuestion("req_question_fallback", {
  response: "轻松搞笑风格",
  answers: { "你想按什么方向继续？": "轻松搞笑风格" },
})) {
  throw new Error("fallback AskUserQuestion response should be accepted");
}
const fallbackControl = JSON.parse(fallbackQuestionWrite);
if (
  fallbackControl.response?.response?.updatedInput?.response !== "轻松搞笑风格" ||
  fallbackControl.response?.response?.updatedInput?.questions?.[0]?.question !== "你想按什么方向继续？"
) {
  throw new Error(`fallback AskUserQuestion control payload failed: ${fallbackQuestionWrite}`);
}

const autoDeniedRunner = createTestSession("sess_auto_denied");
let autoDeniedNotice = null;
let autoDeniedWrite = "";
autoDeniedRunner.process = {
  stdin: {
    destroyed: false,
    write: (line) => {
      autoDeniedWrite = line;
      return true;
    },
  },
};
autoDeniedRunner.spawnOptions = { permissionMode: "dontAsk" };
autoDeniedRunner.on("engine-notice", (notice) => {
  if (notice.code === "permissionAutoDenied") autoDeniedNotice = notice;
});
startSyntheticTurn(autoDeniedRunner);
line(autoDeniedRunner, {
  type: "control_request",
  request_id: "req_auto_denied",
  request: {
    subtype: "can_use_tool",
    tool_name: "Bash",
    input: { command: "rm -rf tmp" },
  },
});
if (autoDeniedNotice?.code !== "permissionAutoDenied") {
  throw new Error(`dontAsk denial should explain auto skip: ${JSON.stringify(autoDeniedNotice)}`);
}
if (JSON.parse(autoDeniedWrite).response?.response?.behavior !== "deny") {
  throw new Error(`dontAsk denial should deny control request: ${autoDeniedWrite}`);
}

const userDeniedRunner = createTestSession("sess_user_denied");
let userDeniedNotice = null;
let userDeniedWrite = "";
userDeniedRunner.process = {
  stdin: {
    destroyed: false,
    write: (line) => {
      userDeniedWrite = `${userDeniedWrite}${line}`;
      return true;
    },
  },
};
userDeniedRunner.spawnOptions = { permissionMode: "default" };
userDeniedRunner.on("engine-notice", (notice) => {
  if (notice.code === "permissionUserDenied") userDeniedNotice = notice;
});
startSyntheticTurn(userDeniedRunner);
line(userDeniedRunner, {
  type: "control_request",
  request_id: "req_user_denied",
  request: {
    subtype: "can_use_tool",
    tool_name: "Bash",
    input: { command: "rm -rf tmp" },
  },
});
if (!userDeniedRunner.respondPermission("req_user_denied", { allow: false })) {
  throw new Error("user denial should respond to pending permission");
}
if (userDeniedNotice?.code !== "permissionUserDenied") {
  throw new Error(`user denial should explain manual denial: ${JSON.stringify(userDeniedNotice)}`);
}
if (!userDeniedWrite.includes('"behavior":"deny"')) {
  throw new Error(`user denial should deny control request: ${userDeniedWrite}`);
}

const explicitReadPermissionRunner = createTestSession("sess_explicit_read_permission");
let explicitReadPrompt = null;
explicitReadPermissionRunner.process = {
  stdin: {
    destroyed: false,
    write: () => true,
  },
};
explicitReadPermissionRunner.spawnOptions = { permissionMode: "default" };
explicitReadPermissionRunner.on("permission-request", (payload) => {
  explicitReadPrompt = payload;
});
startSyntheticTurn(explicitReadPermissionRunner);
line(explicitReadPermissionRunner, {
  type: "control_request",
  request_id: "req_read_permission",
  request: {
    subtype: "can_use_tool",
    tool_name: "Read",
    input: { file_path: "/tmp/example.txt" },
  },
});
if (explicitReadPrompt?.requestId !== "req_read_permission") {
  throw new Error(`explicit Claude permission requests must reach UI, got ${JSON.stringify(explicitReadPrompt)}`);
}
explicitReadPermissionRunner.cancelPermissionRequest("req_read_permission");

const hookAskRunner = createTestSession("sess_hook_ask");
let hookAskPrompt = null;
let hookAskWrite = "";
hookAskRunner.process = {
  stdin: {
    destroyed: false,
    write: (line) => {
      hookAskWrite = `${hookAskWrite}${line}`;
      return true;
    },
  },
};
hookAskRunner.spawnOptions = { permissionMode: "default" };
hookAskRunner.on("hook-request", (payload) => {
  hookAskPrompt = payload;
});
startSyntheticTurn(hookAskRunner);
line(hookAskRunner, {
  type: "control_request",
  request_id: "req_hook_ask",
  request: {
    subtype: "hook_callback",
    hook_event: {
      hook: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "rm -rf tmp" },
      permissionDecision: "ask",
      permissionDecisionReason: "Potentially dangerous command",
    },
  },
});
if (hookAskPrompt?.requestId !== "req_hook_ask" || hookAskPrompt?.toolName !== "Bash") {
  throw new Error(`interactive hook permission requests must reach UI, got ${JSON.stringify(hookAskPrompt)}`);
}
if (!hookAskRunner.respondHook("req_hook_ask", { allow: true })) {
  throw new Error("interactive hook permission should accept user approval");
}
if (!hookAskWrite.includes('"permissionDecision":"allow"')) {
  throw new Error(`interactive hook approval should write allow response: ${hookAskWrite}`);
}

const resultErrorRunner = createTestSession("sess_result_error");
let resultErrorDone = null;
startSyntheticTurn(resultErrorRunner);
resultErrorRunner.on("done", (payload) => {
  resultErrorDone = payload;
});
line(resultErrorRunner, {
  type: "result",
  subtype: "error_max_budget_usd",
  error: "Maximum budget exceeded",
});
if (resultErrorDone?.code !== 1) {
  throw new Error(`result error subtype should complete as failed: ${JSON.stringify(resultErrorDone)}`);
}
if (!String(resultErrorDone?.error || "").includes("Maximum budget exceeded")) {
  throw new Error(`result error should preserve raw CLI failure reason: ${JSON.stringify(resultErrorDone)}`);
}
if (resultErrorDone?.resultSubtype !== "error_max_budget_usd") {
  throw new Error(`result error should preserve subtype: ${JSON.stringify(resultErrorDone)}`);
}

const reloadRunner = createTestSession("sess_reload");
let reloadWrites = [];
let leakedChunk = "";
reloadRunner.process = {
  killed: false,
  stdin: {
    destroyed: false,
    write: (payload) => {
      reloadWrites.push(JSON.parse(payload));
      return true;
    },
  },
};
reloadRunner.spawnOptions = { permissionMode: "auto" };
reloadRunner.on("chunk", (text) => {
  leakedChunk += text;
});
if (!reloadRunner.reloadSkills()) {
  throw new Error("reloadSkills should write an internal command");
}
line(reloadRunner, {
  type: "assistant",
  message: {
    content: [{ type: "text", text: "Reloaded skills: 13 skills available" }],
  },
});
line(reloadRunner, { type: "result", subtype: "success", result: "Reloaded skills" });
if (leakedChunk) {
  throw new Error(`reloadSkills should not leak into chat, got ${leakedChunk}`);
}
if (reloadWrites[0]?.message?.content?.[0]?.text !== "/reload-skills") {
  throw new Error(`reloadSkills payload failed: ${JSON.stringify(reloadWrites[0])}`);
}

const backgroundRunner = createTestSession("sess_background");
startSyntheticTurn(backgroundRunner);
line(backgroundRunner, { type: "system", subtype: "task_progress" });
if (backgroundRunner._canAutoCompleteTurn()) {
  throw new Error("background task activity should delay auto completion");
}
backgroundRunner._backgroundActivityUntil = Date.now() - 1;
if (!backgroundRunner._canAutoCompleteTurn()) {
  throw new Error("background task delay should expire");
}
backgroundRunner._clearIdleTimer();

const backgroundResultRunner = createTestSession("sess_background_result_deferred");
let backgroundResultDone = false;
backgroundResultRunner.on("done", () => {
  backgroundResultDone = true;
});
startSyntheticTurn(backgroundResultRunner);
line(backgroundResultRunner, { type: "system", subtype: "task_progress" });
line(backgroundResultRunner, { type: "result", subtype: "success", result: "still working" });
if (!backgroundResultDone || backgroundResultRunner.busy || !backgroundResultRunner._turnSettled) {
  throw new Error("final result should complete immediately despite background activity");
}

const adapterFailureRunner = createTestSession("sess_adapter_failure");
let adapterFailureNotice = null;
adapterFailureRunner.on("engine-notice", (notice) => {
  adapterFailureNotice = notice;
});
adapterFailureRunner._runtimeAdapter = {
  normalizeEvent() {
    throw new Error("synthetic adapter failure");
  },
};
startSyntheticTurn(adapterFailureRunner);
line(adapterFailureRunner, { type: "future_runtime_event", subtype: "bad_shape" });
if (adapterFailureNotice?.code !== "unknownEvent") {
  throw new Error(`adapter failure should degrade to visible warning: ${JSON.stringify(adapterFailureNotice)}`);
}
if (!adapterFailureRunner.busy || adapterFailureRunner._turnSettled) {
  throw new Error("adapter failure must not settle or kill the active turn");
}
adapterFailureRunner._completeTurn({ code: 0, output: "" });

const serviceClientPath = require.resolve("../src/main/service-client.js");
const reportedUsage = [];
require.cache[serviceClientPath] = {
  id: serviceClientPath,
  filename: serviceClientPath,
  loaded: true,
  exports: {
    reportUsage: async (payload) => {
      reportedUsage.push(payload);
      return { ok: true };
    },
  },
};
const usageRunner = createTestSession("sess_usage");
startSyntheticTurn(usageRunner);
line(usageRunner, {
  type: "result",
  subtype: "success",
  modelUsage: {
    "deepseek-v4-pro": {
      inputTokens: 123,
      outputTokens: 45,
      cacheReadInputTokens: 9,
      cacheCreationInputTokens: 8,
      costUSD: 0.01,
    },
    "deepseek-v4-flash": {
      inputTokens: 7,
      outputTokens: 3,
      costUSD: 0.001,
    },
  },
});
await require("../src/main/usage-reporter.js").flush("sess_usage");
if (reportedUsage[0]?.inputTokens !== 130 || reportedUsage[0]?.outputTokens !== 48) {
  throw new Error(`result modelUsage should be reported as tokens: ${JSON.stringify(reportedUsage[0])}`);
}

const streamUsageRunner = createTestSession("sess_stream_usage");
startSyntheticTurn(streamUsageRunner);
line(streamUsageRunner, {
  type: "stream_event",
  event: {
    type: "message_delta",
    delta: { stop_reason: "end_turn" },
    usage: {
      input_tokens: 222,
      output_tokens: 33,
      cache_read_input_tokens: 11,
      cache_creation_input_tokens: 4,
    },
  },
});
line(streamUsageRunner, {
  type: "result",
  subtype: "success",
  result: "done",
});
await require("../src/main/usage-reporter.js").flush("sess_stream_usage");
const streamReport = reportedUsage.find((item) => item.date && item.inputTokens === 222);
if (!streamReport || streamReport.outputTokens !== 33) {
  throw new Error(`stream message_delta usage should be reported once: ${JSON.stringify(reportedUsage)}`);
}

console.log("agent-tool-lease: ok");
