#!/usr/bin/env node

import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  buildMetadataIndex,
  isInjectedUserPromptText,
  isInternalOnlyUserPromptText,
  mergeMetadata,
  mergeProjectionConversation,
  mergeUserDisplayText,
  getConversationPageFromSource,
} = require("../src/main/opencode-conversation-source.js");
const {
  buildLayeredEngineText,
  layerBlock,
} = require("../src/main/engine-message-layers.js");

const legacy = {
  id: "legacy_msg",
  role: "assistant",
  content: "old",
  turnId: "turn_1",
  record: {
    turnId: "turn_1",
    engineMessageId: "msg_engine",
    assistantText: "old",
    artifacts: [{ path: "/tmp/out.pdf" }],
    fileChanges: [{ filePath: "/tmp/a.txt" }],
    resultBlocks: [{ type: "file", path: "/tmp/out.pdf" }],
    timeline: [{ type: "tool", title: "write" }],
    notices: [{ code: "x" }],
    processEvents: [{ rawType: "message.part.updated" }],
    meta: { toolsSummary: { count: 1 } },
  },
};
const index = buildMetadataIndex([legacy]);
assert.equal(index.get("msg_engine"), legacy);

const merged = mergeMetadata({
  id: "msg_engine",
  role: "assistant",
  content: "fresh",
  record: {
    assistantText: "fresh",
    engineMessageId: "msg_engine",
    artifacts: [],
    fileChanges: [],
    resultBlocks: [],
    timeline: [],
    notices: [],
    processEvents: [],
    meta: { opencode: { messageId: "msg_engine" } },
  },
}, legacy);
assert.equal(merged.content, "fresh", "OpenCode text remains canonical");
assert.equal(merged.turnId, "turn_1", "Lily turn id merged");
assert.deepEqual(merged.record.artifacts, [{ path: "/tmp/out.pdf" }], "Lily artifacts merged");
assert.equal(merged.record.meta.opencode.messageId, "msg_engine", "OpenCode meta preserved");

const injectedPrompt = `# 智能工作台全局说明

你是智能工作台（Lily Workbench）助手。不要自称 Claude、Claude Code 或 Anthropic 产品。

## 身份问答（必读）
`;
assert.equal(isInjectedUserPromptText(injectedPrompt), true, "detects Lily injected engine prompt");
assert.equal(isInjectedUserPromptText("帮我学习这个系统"), false, "does not flag normal user input");

const layeredEnginePrompt = buildLayeredEngineText({
  platformContext: "Internal resume context that must stay hidden.",
  userText: "继续",
});
assert.equal(isInjectedUserPromptText(layeredEnginePrompt), true, "detects layered Lily engine prompt");
const layeredFallbackDisplay = mergeUserDisplayText([
  {
    id: "official_layered_user",
    role: "user",
    content: layeredEnginePrompt,
    timestamp: "2026-06-23T10:01:00.000Z",
    source: "opencode",
  },
], []);
assert.equal(layeredFallbackDisplay.length, 1, "layered official user prompt remains visible through recovered original request");
assert.equal(layeredFallbackDisplay[0].content, "继续", "layered engine prompt displays only the recovered original request");
assert.equal(layeredFallbackDisplay[0].meta.opencodeEnginePromptHidden, true, "layered engine prompt is marked hidden");
assert.equal(layeredFallbackDisplay[0].content.includes("platform_context"), false, "platform context never leaks into display");

const pureInternalDisplay = mergeUserDisplayText([
  {
    id: "official_internal_only",
    role: "user",
    content: layerBlock("platform_context", "internal only"),
    timestamp: "2026-06-23T10:02:00.000Z",
    source: "opencode",
  },
], []);
assert.equal(pureInternalDisplay.length, 0, "pure internal prompts without original request are hidden");

const internalContinuationPrompt = "Continue if you have next steps, or stop and ask for clarification if you are unsure how to proceed.";
assert.equal(isInternalOnlyUserPromptText(internalContinuationPrompt), true, "detects engine-only continuation prompt");
assert.equal(isInjectedUserPromptText(internalContinuationPrompt), true, "engine-only continuation prompt is treated as injected");
const hiddenContinuationDisplay = mergeUserDisplayText([
  {
    id: "official_internal_continuation",
    role: "user",
    content: internalContinuationPrompt,
    timestamp: "2026-06-23T10:03:00.000Z",
    source: "opencode",
  },
], [
  {
    id: "local_previous_user",
    role: "user",
    content: "之前真正的问题",
    timestamp: "2026-06-23T10:00:00.000Z",
    turnId: "turn_previous",
  },
]);
assert.equal(hiddenContinuationDisplay.length, 0, "engine-only continuation prompt is hidden instead of being paired with an old local user");

const mergedUserDisplay = mergeUserDisplayText([
  {
    id: "official_user_1",
    role: "user",
    content: injectedPrompt,
    timestamp: "2026-06-23T10:00:02.000Z",
    source: "opencode",
  },
], [
  {
    id: "local_user_1",
    role: "user",
    content: "帮我学习这个系统",
    timestamp: "2026-06-23T10:00:00.000Z",
    turnId: "turn_raw_1",
    files: [{ path: "/tmp/a.png" }],
  },
]);
assert.equal(mergedUserDisplay[0].content, "帮我学习这个系统", "local raw user text replaces injected engine prompt");
assert.equal(mergedUserDisplay[0].turnId, "turn_raw_1", "local user turn id is preserved");
assert.deepEqual(mergedUserDisplay[0].files, [{ path: "/tmp/a.png" }], "local user files are preserved");
assert.equal(mergedUserDisplay[0].meta.opencodeEnginePromptHidden, true, "hidden engine prompt is marked");

const normalOfficialUser = mergeUserDisplayText([
  { id: "official_user_2", role: "user", content: "普通问题", timestamp: "2026-06-23T12:00:00.000Z" },
], [
  { id: "local_user_2", role: "user", content: "很久以前的问题", timestamp: "2026-06-23T10:00:00.000Z" },
]);
assert.equal(normalOfficialUser[0].content, "普通问题", "normal official user text is not replaced without a time match");

const projectedMessages = [
  {
    id: "projection:turn_p:user",
    role: "user",
    content: "原始问题",
    turnId: "turn_p",
    timestamp: "2026-06-23T14:00:00.000Z",
  },
  {
    id: "projection:turn_p:assistant",
    role: "assistant",
    content: "投影答案",
    turnId: "turn_p",
    timestamp: "2026-06-23T14:00:10.000Z",
    record: { assistantText: "投影答案", meta: { projected: true } },
  },
];
const projectionMerged = mergeProjectionConversation([], projectedMessages);
assert.equal(projectionMerged.length, 2, "projection can fill an otherwise empty history");
const projectionInternalHidden = mergeProjectionConversation([], [
  {
    id: "projection:turn_internal:user",
    role: "user",
    content: internalContinuationPrompt,
    turnId: "turn_internal",
    timestamp: "2026-06-23T14:05:00.000Z",
  },
  {
    id: "projection:turn_internal:assistant",
    role: "assistant",
    content: "continued answer",
    turnId: "turn_internal",
    timestamp: "2026-06-23T14:05:05.000Z",
  },
]);
assert.equal(projectionInternalHidden.some((m) => m.role === "user"), false, "projection repair also hides engine-only continuation prompts");
assert.equal(projectionInternalHidden.some((m) => m.role === "assistant"), true, "projection repair keeps the assistant result");
const projectionDeduped = mergeProjectionConversation([
  { id: "local_user_p", role: "user", content: "原始问题", turnId: "turn_p", timestamp: "2026-06-23T14:00:00.000Z" },
], projectedMessages);
assert.equal(projectionDeduped.filter((m) => m.role === "user").length, 1, "projection does not duplicate existing turn user");
assert.equal(projectionDeduped.find((m) => m.role === "assistant")?.content, "投影答案", "projection fills missing assistant");

const projectionWithSteer = mergeProjectionConversation([
  { id: "official_user_p", role: "user", content: "original request", turnId: "turn_p_steer", timestamp: "2026-06-23T14:10:00.000Z" },
], [
  {
    id: "projection:turn_p_steer:user",
    role: "user",
    content: "original request",
    turnId: "turn_p_steer",
    timestamp: "2026-06-23T14:10:00.000Z",
  },
  {
    id: "projection:turn_p_steer:user:steer:1",
    role: "user",
    content: "add the new constraint",
    turnId: "turn_p_steer",
    timestamp: "2026-06-23T14:10:03.000Z",
    meta: { steer: true, steerSeq: 1 },
  },
]);
assert.equal(projectionWithSteer.filter((m) => m.role === "user").length, 2, "steer projection survives official same-turn user merge");
assert.equal(projectionWithSteer.some((m) => m.meta?.steer && m.content === "add the new constraint"), true, "steer projection keeps visible metadata");
const projectionWithRepeatedSteerText = mergeProjectionConversation([
  { id: "official_user_repeat", role: "user", content: "same text", turnId: "turn_p_repeat_steer", timestamp: "2026-06-23T14:11:00.000Z" },
], [
  {
    id: "projection:turn_p_repeat_steer:user:steer:1",
    role: "user",
    content: "same text",
    turnId: "turn_p_repeat_steer",
    timestamp: "2026-06-23T14:11:03.000Z",
    meta: { steer: true, steerSeq: 1 },
  },
]);
assert.equal(projectionWithRepeatedSteerText.filter((m) => m.role === "user").length, 2, "steer is never fuzzy-deduped even when its text repeats");

const projectionOfficialNoTurn = mergeProjectionConversation([
  {
    id: "official_user_no_turn",
    role: "user",
    content: "please create a schedule every hour. say hello",
    timestamp: "2026-06-23T14:00:02.000Z",
    source: "opencode",
  },
], [
  {
    id: "projection:turn_schedule:user",
    role: "user",
    content: "please create a schedule every hour. say hello",
    turnId: "turn_schedule",
    timestamp: "2026-06-23T14:00:00.000Z",
  },
  {
    id: "projection:turn_schedule:assistant",
    role: "assistant",
    content: "",
    turnId: "turn_schedule",
    timestamp: "2026-06-23T14:00:04.000Z",
    meta: {
      scheduledDraft: {
        originalText: "please create a schedule every hour. say hello",
        draft: {
          title: "Say hello",
          scheduleText: "Every hour on the hour",
          rrule: "FREQ=HOURLY;INTERVAL=1",
        },
      },
    },
  },
]);
assert.equal(
  projectionOfficialNoTurn.filter((m) => m.role === "user").length,
  1,
  "projection user is deduped against official OpenCode user without turnId",
);

const scheduledDraftDeduped = mergeProjectionConversation([
  {
    id: "official_schedule_card",
    role: "assistant",
    content: "",
    timestamp: "2026-06-23T14:00:04.000Z",
    meta: {
      scheduledDraft: {
        originalText: "please create a schedule every hour. say hello",
        draft: {
          title: "Say hello",
          scheduleText: "Every hour on the hour",
          rrule: "FREQ=HOURLY;INTERVAL=1",
        },
      },
    },
  },
], [
  {
    id: "projection:turn_schedule_2:assistant",
    role: "assistant",
    content: "",
    turnId: "turn_schedule_2",
    timestamp: "2026-06-23T14:00:06.000Z",
    meta: {
      scheduledDraft: {
        originalText: "please create a schedule every hour. say hello",
        prompt: "Say hello",
        scheduleText: "Every hour on the hour",
      },
    },
  },
]);
assert.equal(
  scheduledDraftDeduped.filter((m) => m.meta?.scheduledDraft).length,
  1,
  "scheduled task draft cards are deduped by draft fingerprint",
);

const fallbackPage = { ok: true, source: "lily", conversation: [{ id: "local" }] };
const baseSession = { id: "s1", projectId: "p1" };
const fallbackCtx = {
  sessionManager: {
    findById: () => baseSession,
    getActive: () => baseSession,
    getConversationPage: () => fallbackPage,
    getConversation: () => [],
    getProjectedConversation: () => [],
  },
  runnerPool: { get: () => null },
};
assert.equal((await getConversationPageFromSource(fallbackCtx, "s1", {})).source, "lily", "falls back without runner");

const projectionFallbackCtx = {
  sessionManager: {
    findById: () => baseSession,
    getActive: () => baseSession,
    getConversationPage: () => ({ ok: true, source: "lily", conversation: [] }),
    getConversation: () => [],
    getProjectedConversation: () => projectedMessages,
  },
  runnerPool: { get: () => null },
};
const projectionFallback = await getConversationPageFromSource(projectionFallbackCtx, "s1", {});
assert.equal(projectionFallback.conversation.length, 2, "fallback history is repaired from projection");
assert.equal(projectionFallback.projectionSource, "lily-projection", "projection repair is tagged");

let ensuredSessionId = "";
const resumableSession = { ...baseSession, agentResumeId: "ses_resume" };
const localFirstCtx = {
  ensureConversationRunner: async () => {
    throw new Error("local-first reads must not start OpenCode");
  },
  sessionManager: {
    findById: () => resumableSession,
    getActive: () => resumableSession,
    getConversationPage: () => fallbackPage,
    getConversation: () => [],
    getProjectedConversation: () => [],
  },
  runnerPool: { get: () => null },
};
const localFirstPage = await getConversationPageFromSource(localFirstCtx, "s1", { preferLocal: true });
assert.equal(localFirstPage.source, "lily-local-first", "initial UI load returns local latest page immediately");
assert.equal(localFirstPage.officialRefreshRecommended, true, "resumable local-first pages request a background official refresh");

const passiveCtx = {
  ensureConversationRunner: async (_ctx, sessionId) => {
    ensuredSessionId = sessionId;
    return {
      runner: {
        isAlive: () => true,
        getConversationPage: async () => ({
          ok: true,
          source: "opencode",
          sessionId,
          conversation: [{
            id: "msg_engine",
            role: "assistant",
            content: "fresh after restart",
            record: { assistantText: "fresh after restart", engineMessageId: "msg_engine", meta: { opencode: { messageId: "msg_engine" } } },
          }],
        }),
      },
    };
  },
  sessionManager: {
    findById: () => resumableSession,
    getActive: () => resumableSession,
    getConversationPage: () => fallbackPage,
    getConversation: () => [legacy],
    getProjectedConversation: () => [],
  },
  runnerPool: { get: () => null },
};
const passivePage = await getConversationPageFromSource(passiveCtx, "s1", {});
assert.equal(ensuredSessionId, "s1", "passive history read starts an idle OpenCode view when resume id exists");
assert.equal(passivePage.source, "opencode", "resumable session uses official OpenCode history even without a live runner");
assert.equal(passivePage.conversation[0].content, "fresh after restart");

const ctx = {
  sessionManager: {
    findById: () => baseSession,
    getActive: () => baseSession,
    getConversationPage: () => fallbackPage,
    getConversation: () => [legacy],
    getProjectedConversation: () => [],
  },
  runnerPool: {
    get: () => ({
      isAlive: () => true,
      getConversationPage: async () => ({
        ok: true,
        source: "opencode",
        sessionId: "s1",
        conversation: [{
          id: "msg_engine",
          role: "assistant",
          content: "fresh",
          record: { assistantText: "fresh", engineMessageId: "msg_engine", meta: { opencode: { messageId: "msg_engine" } } },
        }],
      }),
    }),
  },
};
const page = await getConversationPageFromSource(ctx, "s1", {});
assert.equal(page.source, "opencode");
assert.equal(page.projectId, "p1");
assert.deepEqual(page.conversation[0].record.artifacts, [{ path: "/tmp/out.pdf" }]);

const userMergeCtx = {
  sessionManager: {
    findById: () => baseSession,
    getActive: () => baseSession,
    getConversationPage: () => fallbackPage,
    getConversation: () => [{
      id: "local_user_3",
      role: "user",
      content: "用户真正输入的问题",
      timestamp: "2026-06-23T13:00:00.000Z",
      turnId: "turn_user_3",
    }],
    getProjectedConversation: () => [],
  },
  runnerPool: {
    get: () => ({
      isAlive: () => true,
      getConversationPage: async () => ({
        ok: true,
        source: "opencode",
        sessionId: "s1",
        conversation: [{
          id: "official_user_3",
          role: "user",
          content: injectedPrompt,
          timestamp: "2026-06-23T13:00:02.000Z",
          source: "opencode",
        }],
      }),
    }),
  },
};
const userMergePage = await getConversationPageFromSource(userMergeCtx, "s1", {});
assert.equal(userMergePage.conversation[0].content, "用户真正输入的问题", "OpenCode source uses Lily raw user display text");
assert.equal(userMergePage.conversation[0].turnId, "turn_user_3");

const partialProjection = [
  {
    id: "projection:turn_partial:user",
    role: "user",
    content: "write a long answer",
    turnId: "turn_partial",
    timestamp: "2026-06-23T15:00:00.000Z",
  },
  {
    id: "projection:turn_partial:assistant",
    role: "assistant",
    content: "partial answer before crash",
    turnId: "turn_partial",
    timestamp: "2026-06-23T15:00:05.000Z",
    record: {
      turnId: "turn_partial",
      terminal: "turn.stalled",
      assistantText: "partial answer before crash",
      meta: { projected: true },
    },
    meta: { terminal: "turn.stalled", projected: true },
  },
];
const busyRunnerPage = await getConversationPageFromSource({
  sessionManager: {
    findById: () => baseSession,
    getActive: () => baseSession,
    getConversationPage: () => ({ ok: true, source: "lily", conversation: [] }),
    getConversation: () => [],
    getProjectedConversation: () => partialProjection,
  },
  runnerPool: {
    get: () => ({
      isAlive: () => true,
      isBusy: () => true,
      getConversationPage: async () => ({
        ok: true,
        source: "opencode",
        sessionId: "s1",
        conversation: [{
          id: "official_partial_user",
          role: "user",
          content: "write a long answer",
          timestamp: "2026-06-23T15:00:01.000Z",
        }],
      }),
    }),
  },
}, "s1", {});
assert.equal(
  busyRunnerPage.conversation.find((message) => message.role === "assistant")?.content,
  "partial answer before crash",
  "busy official history still merges persisted partial assistant projection",
);
assert.equal(
  busyRunnerPage.conversation.filter((message) => message.role === "user").length,
  1,
  "partial projection user is deduped against official user while preserving assistant",
);

const richLocalRecord = {
  turnId: "turn_rich",
  assistantText: "先看下文件。最终答案。\n\n证据门槛：上面的结论缺少可核验证据支撑。",
  artifacts: [{ path: "/tmp/report.md", relativePath: "output/report.md" }],
  resultBlocks: [{ type: "artifact", artifactType: "markdown", path: "/tmp/report.md" }],
  timeline: [
    { kind: "text", id: "text_1", text: "先看下文件。", status: "done", ts: 1000 },
    { kind: "tool", id: "tool_1", name: "Write", status: "done", ts: 2000 },
    { kind: "text", id: "text_2", text: "最终答案。", status: "done", ts: 3000 },
  ],
  meta: { canonicalSource: "lily" },
};
const restartedOfficialPage = await getConversationPageFromSource({
  sessionManager: {
    findById: () => baseSession,
    getActive: () => baseSession,
    getConversationPage: () => ({
      ok: true,
      source: "lily",
      conversation: [{
        id: "local_rich_assistant",
        role: "assistant",
        content: richLocalRecord.assistantText,
        timestamp: "2026-06-23T16:00:10.000Z",
        turnId: "turn_rich",
        record: richLocalRecord,
      }],
    }),
    getConversation: () => [{
      id: "local_rich_assistant",
      role: "assistant",
      content: richLocalRecord.assistantText,
      timestamp: "2026-06-23T16:00:10.000Z",
      turnId: "turn_rich",
      record: richLocalRecord,
    }],
    getProjectedConversation: () => [],
  },
  runnerPool: {
    get: () => ({
      isAlive: () => true,
      getConversationPage: async () => ({
        ok: true,
        source: "opencode",
        sessionId: "s1",
        conversation: [{
          id: "official_rich_assistant_without_engine_match",
          role: "assistant",
          content: richLocalRecord.assistantText,
          timestamp: "2026-06-23T16:00:11.000Z",
          record: {
            assistantText: richLocalRecord.assistantText,
            artifacts: [],
            resultBlocks: [],
            timeline: [],
            meta: { opencode: { messageId: "official_rich_assistant_without_engine_match" } },
          },
        }],
      }),
    }),
  },
}, "s1", {});
const restartedAssistant = restartedOfficialPage.conversation.find((message) => message.role === "assistant");
assert.equal(
  restartedAssistant?.record?.resultBlocks?.length,
  1,
  "restart official history must keep the richer local renderer record when engine ids do not match",
);
assert.equal(
  restartedAssistant?.record?.timeline?.length,
  3,
  "restart official history must keep local timeline needed for final-text de-duplication",
);

console.log("opencode-conversation-source: ok");
