#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  COMMITTED_INITIAL_WINDOW,
  COMMITTED_MAX_WINDOW,
  COMMITTED_WINDOW_THRESHOLD,
  buildMinimapItems,
  committedMessagesForRender,
  copyActionText,
  isCurrentRetryTarget,
  formatScheduledDraftDateTime,
  isCommittedRenderCurrent,
  liveInsertAnchorTurnId,
  orderCommittedMessages,
  resetCommittedWindowCount,
  rewindActionTarget,
  scheduledDraftPreviewModel,
  shouldShowRetryAction,
  shouldSkipCommittedAssistantForLiveTurn,
} from "../src/renderer/modules/message-committed-render-model.js";

const messages = [
  { role: "assistant", turnId: "t2", content: "a2", timestamp: "2026-01-01T00:00:03.000Z" },
  { role: "assistant", turnId: "t1", content: "a1", timestamp: "2026-01-01T00:00:01.000Z" },
  { role: "user", turnId: "t1", content: "u1", timestamp: "2026-01-01T00:00:02.000Z" },
  { role: "user", turnId: "t2", content: "u2", timestamp: "2026-01-01T00:00:03.500Z" },
  { role: "tool", content: "legacy" },
];

assert.deepEqual(
  orderCommittedMessages(messages).map((message) => `${message.turnId || "none"}:${message.role}:${message.content}`),
  ["t1:user:u1", "t1:assistant:a1", "t2:user:u2", "t2:assistant:a2", "none:tool:legacy"],
  "messages should sort by turn time while preserving user before assistant within a turn",
);

const longList = Array.from({ length: COMMITTED_WINDOW_THRESHOLD + 5 }, (_, index) => ({
  role: "user",
  turnId: `t${index}`,
  content: `message ${index}`,
  timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
}));
assert.equal(committedMessagesForRender(longList).length, COMMITTED_INITIAL_WINDOW);
assert.equal(committedMessagesForRender(longList)[0].turnId, `t${longList.length - COMMITTED_INITIAL_WINDOW}`);
// preserveScroll is a chunking concern of the caller, not a window size: the
// render list follows the default/remembered window either way.
assert.equal(committedMessagesForRender(longList, { preserveScroll: true }).length, COMMITTED_INITIAL_WINDOW);
assert.deepEqual(committedMessagesForRender("bad"), []);

// Explicit windowCount (loading older history) is honored in full, even past
// the max window — the user asked for this range.
assert.equal(committedMessagesForRender(longList, { windowCount: longList.length }).length, longList.length);
assert.equal(committedMessagesForRender(longList, { windowCount: 10 })[0].turnId, `t${longList.length - 10}`);

// Remembered per-session window: loading older grows what later renders keep,
// so a rebuild restores the loaded range instead of snapping back to the tail.
const hugeList = Array.from({ length: COMMITTED_MAX_WINDOW * 2 }, (_, index) => ({
  role: "user",
  turnId: `h${index}`,
  content: `h ${index}`,
  timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
}));
assert.equal(committedMessagesForRender(hugeList, { sessionId: "win-a" }).length, COMMITTED_INITIAL_WINDOW);
assert.equal(committedMessagesForRender(hugeList, { sessionId: "win-a", windowCount: hugeList.length }).length, hugeList.length);
assert.equal(
  committedMessagesForRender(hugeList, { sessionId: "win-a" }).length,
  COMMITTED_MAX_WINDOW,
  "remembered window is restored but capped",
);
assert.equal(
  committedMessagesForRender(hugeList, { sessionId: "win-b" }).length,
  COMMITTED_INITIAL_WINDOW,
  "windows are per session",
);
resetCommittedWindowCount("win-a");
assert.equal(
  committedMessagesForRender(hugeList, { sessionId: "win-a" }).length,
  COMMITTED_INITIAL_WINDOW,
  "reset returns the session to the default tail window",
);

// The remembered window never SHRINKS a small conversation: a session that fit
// entirely keeps rendering everything as it grows toward the threshold.
const smallList = longList.slice(0, COMMITTED_WINDOW_THRESHOLD - 60);
assert.equal(committedMessagesForRender(smallList, { sessionId: "win-c" }).length, smallList.length);
const grownSmall = [...smallList, ...longList.slice(0, 20)];
assert.equal(committedMessagesForRender(grownSmall, { sessionId: "win-c" }).length, grownSmall.length);

assert.equal(isCommittedRenderCurrent({
  hasSessionView: true,
  hasRenderedContent: true,
  renderedKeyCount: 2,
  renderMessageCount: 2,
  unrenderedCount: 0,
}), true);
assert.equal(isCommittedRenderCurrent({
  hasSessionView: false,
  hasRenderedContent: true,
  renderedKeyCount: 2,
  renderMessageCount: 2,
  unrenderedCount: 0,
}), false);
assert.equal(isCommittedRenderCurrent({
  hasSessionView: true,
  hasRenderedContent: false,
  renderedKeyCount: 2,
  renderMessageCount: 2,
  unrenderedCount: 0,
}), false);
assert.equal(isCommittedRenderCurrent({
  hasSessionView: true,
  hasRenderedContent: true,
  renderedKeyCount: 0,
  renderMessageCount: 0,
  unrenderedCount: 0,
}), false);
assert.equal(isCommittedRenderCurrent({
  hasSessionView: true,
  hasRenderedContent: true,
  renderedKeyCount: 1,
  renderMessageCount: 2,
  unrenderedCount: 0,
}), false);
assert.equal(isCommittedRenderCurrent({
  hasSessionView: true,
  hasRenderedContent: true,
  renderedKeyCount: 2,
  renderMessageCount: 2,
  unrenderedCount: 1,
}), false);

assert.deepEqual(
  buildMinimapItems({ committedMessages: messages }),
  [
    { role: "user", turnId: "t1", label: "u1" },
    { role: "user", turnId: "t2", label: "u2" },
  ],
);
assert.deepEqual(buildMinimapItems(null), []);

assert.equal(
  shouldSkipCommittedAssistantForLiveTurn(
    { liveTurn: { turnId: "turn_1" } },
    { role: "assistant", turnId: "turn_1" },
  ),
  true,
  "active live turns own the screen until the terminal record arrives",
);
assert.equal(
  shouldSkipCommittedAssistantForLiveTurn(
    { liveTurn: { turnId: "turn_1", final: { type: "turn.completed" } } },
    { role: "assistant", turnId: "turn_1" },
  ),
  false,
  "completed live turns must not block the committed final article",
);

assert.equal(copyActionText({ content: "  final answer  " }), "final answer");
assert.equal(copyActionText({ content: "" }), "");
assert.equal(copyActionText({ content: "   " }), "");
assert.equal(copyActionText(null), "");

const nextRunAt = "2026-01-02T03:04:00.000Z";
assert.equal(
  formatScheduledDraftDateTime(nextRunAt),
  new Date(nextRunAt).toLocaleString(undefined, {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }),
);
assert.equal(formatScheduledDraftDateTime(""), "");
assert.equal(formatScheduledDraftDateTime("not-a-date"), "");

assert.deepEqual(
  scheduledDraftPreviewModel({
    id: "message-1",
    meta: {
      scheduledDraft: {
        status: "created",
        draft: {
          title: "Daily report",
          scheduleText: "Every day",
          nextRunAt: "2026-01-02T03:04:00.000Z",
        },
        task: { nextRunAt: "2026-01-03T03:04:00.000Z" },
      },
    },
  }),
  {
    messageId: "message-1",
    created: true,
    title: "Daily report",
    scheduleText: "Every day",
    nextRunAt: "2026-01-02T03:04:00.000Z",
  },
  "scheduled draft preview should prefer draft nextRunAt over persisted task nextRunAt",
);
assert.deepEqual(
  scheduledDraftPreviewModel({
    meta: {
      scheduledDraft: {
        draft: { title: "", scheduleText: "" },
        task: { nextRunAt: "2026-01-03T03:04:00.000Z" },
      },
    },
  }),
  {
    messageId: "",
    created: false,
    title: "",
    scheduleText: "",
    nextRunAt: "2026-01-03T03:04:00.000Z",
  },
);
assert.deepEqual(scheduledDraftPreviewModel(null), {
  messageId: "",
  created: false,
  title: "",
  scheduleText: "",
  nextRunAt: "",
});

assert.equal(
  shouldSkipCommittedAssistantForLiveTurn(
    { liveTurn: { turnId: "live-1" } },
    { role: "assistant", turnId: "live-1" },
  ),
  true,
  "committed assistant text for the active live turn should not duplicate the live article",
);
assert.equal(
  shouldSkipCommittedAssistantForLiveTurn(
    { liveTurn: { turnId: "live-1" } },
    { role: "assistant", turnId: "live-1", meta: { scheduledDraft: true } },
  ),
  false,
  "scheduled-task drafts must still render their committed card",
);
assert.equal(
  shouldSkipCommittedAssistantForLiveTurn(
    { liveTurn: { turnId: "live-1" } },
    { role: "user", turnId: "live-1" },
  ),
  false,
);

assert.equal(
  liveInsertAnchorTurnId({ turnId: "live-1", liveTurn: { turnId: "live-1" } }),
  "live-1",
  "active current live turn may anchor committed history",
);
assert.equal(liveInsertAnchorTurnId({ turnId: "live-1", liveTurn: { turnId: "live-1", final: true } }), "");
assert.equal(liveInsertAnchorTurnId({ turnId: "new-turn", liveTurn: { turnId: "old-turn" } }), "");
assert.equal(liveInsertAnchorTurnId({ liveTurn: { turnId: "live-1" } }), "");

assert.equal(shouldShowRetryAction({ failed: true }), true);
assert.equal(shouldShowRetryAction({ record: { terminal: "turn.stalled" } }), true);
assert.equal(shouldShowRetryAction({ record: { terminal: "turn.completed" } }), false);
assert.equal(shouldShowRetryAction(null), false);

const retryMessage = { role: "assistant", turnId: "retry-1", failed: true };
assert.equal(isCurrentRetryTarget([retryMessage], retryMessage), true);
assert.equal(
  isCurrentRetryTarget(
    [{ role: "assistant", turnId: "retry-1", failed: true }],
    retryMessage,
  ),
  true,
  "retry remains valid after message objects are rehydrated if the latest turn id still matches",
);
assert.equal(
  isCurrentRetryTarget(
    [{ role: "assistant", turnId: "newer-turn" }],
    retryMessage,
  ),
  false,
  "older failed answers must not retry after a newer committed turn arrives",
);
assert.equal(isCurrentRetryTarget([{ role: "assistant" }], retryMessage), false);

assert.deepEqual(
  rewindActionTarget({ turnId: "turn-1", record: { engineMessageId: "msg-1" } }),
  { turnId: "turn-1", engineMessageId: "msg-1" },
  "rewind action should be available only when the engine anchor exists",
);
assert.deepEqual(
  rewindActionTarget({ record: { turnId: "turn-2", engineMessageId: "msg-2" } }),
  { turnId: "turn-2", engineMessageId: "msg-2" },
  "rewind action may read turn id from the sealed record",
);
assert.equal(rewindActionTarget({ turnId: "turn-1", record: {} }), null);
assert.equal(rewindActionTarget({ record: { engineMessageId: "msg-1" } }), null);
assert.equal(rewindActionTarget(null), null);

const messageSource = readFileSync(
  new URL("../src/renderer/modules/message.js", import.meta.url),
  "utf8",
);
assert.match(messageSource, /from "\.\/message-committed-render-model\.js"/);
assert.match(messageSource, /isCommittedRenderCurrent\(/);
assert.match(messageSource, /liveInsertAnchorTurnId\(runtime\)/);
assert.match(messageSource, /shouldShowRetryAction\(message\)/);
assert.match(messageSource, /isCurrentRetryTarget\(committed,\s*message\)/);
assert.match(messageSource, /rewindActionTarget\(message\)/);
assert.match(messageSource, /copyActionText\(message\)/);
assert.match(messageSource, /formatScheduledDraftDateTime\(/);
assert.match(messageSource, /scheduledDraftPreviewModel\(message\)/);
assert.doesNotMatch(messageSource, /function formatScheduleDateTime\s*\(/);
assert.doesNotMatch(messageSource, /const isScheduledDraft = Boolean/);
assert.doesNotMatch(messageSource, /function orderCommittedMessages\s*\(/);
assert.doesNotMatch(messageSource, /function committedMessagesForRender\s*\(/);
assert.doesNotMatch(messageSource, /function buildMinimapItems\s*\(/);

console.log("message-committed-render-model: ok");
