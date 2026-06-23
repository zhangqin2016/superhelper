#!/usr/bin/env node

import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  buildMetadataIndex,
  mergeMetadata,
  getConversationPageFromSource,
} = require("../src/main/opencode-conversation-source.js");

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

const fallbackPage = { ok: true, source: "lily", conversation: [{ id: "local" }] };
const baseSession = { id: "s1", projectId: "p1" };
const fallbackCtx = {
  sessionManager: {
    findById: () => baseSession,
    getActive: () => baseSession,
    getConversationPage: () => fallbackPage,
    getConversation: () => [],
  },
  runnerPool: { get: () => null },
};
assert.equal((await getConversationPageFromSource(fallbackCtx, "s1", {})).source, "lily", "falls back without runner");

let ensuredSessionId = "";
const resumableSession = { ...baseSession, agentResumeId: "ses_resume" };
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

console.log("opencode-conversation-source: ok");
