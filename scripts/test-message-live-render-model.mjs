#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  hasCommittedScheduledDraftTurn,
  liveTurnRenderMode,
  runtimeVisualSig,
  shouldFollowLiveRender,
  shouldUpdateConversationMinimap,
  shouldThrottleLiveRender,
} from "../src/renderer/modules/message-live-render-model.js";

const runtime = {
  phase: "streaming",
  queue: [{ role: "user" }],
  liveTurn: {
    turnId: "turn_1",
    phase: "streaming",
    assistantText: "hello",
    thinkingText: "think",
    activityLabel: "Read file",
    timeline: [{ kind: "thinking" }],
    tools: new Map([
      ["read_1", { id: "read_1", status: "running" }],
    ]),
    subagents: new Map([
      ["sub_1", {
        sessionId: "sub_1",
        status: "running",
        phase: "working",
        phaseDetail: "reading",
        currentToolId: "bash_1",
        textPreview: "preview",
        stats: { runningTools: 1, doneTools: 2, nestedTasks: 0 },
        tools: [{ id: "bash_1", status: "running", name: "Bash" }],
      }],
    ]),
    permissions: new Map([["p1", {}]]),
    questions: new Map([["q1", {}]]),
    hooks: new Map([["h1", {}]]),
    durationMs: 1000,
  },
};

const first = runtimeVisualSig(runtime);
runtime.liveTurn.durationMs = 2000;
assert.equal(
  runtimeVisualSig(runtime),
  first,
  "visual signature must not include elapsed time that would force per-second rerenders",
);
const heartbeatSource = readFileSync(
  new URL("../src/renderer/modules/message.js", import.meta.url),
  "utf8",
);
// The heartbeat must update BOTH the top status line and running tool clocks —
// as surgical patches, never a full-article re-render (that would defeat the
// signature rule asserted above by paying the morphdom cost every second).
assert.match(
  heartbeatSource,
  /function refreshLiveStatusOnly[\s\S]*refreshLiveTurnStatusDisplay\(article,\s*live\)/,
  "heartbeat refresh must update the top status line",
);
assert.match(
  heartbeatSource,
  /function refreshLiveStatusOnly[\s\S]*patchLiveToolClocks\(article,\s*live\)/,
  "heartbeat refresh must tick running tool row clocks surgically",
);
assert.doesNotMatch(
  heartbeatSource.slice(heartbeatSource.indexOf("function refreshLiveStatusOnly")).split("\n").slice(0, 15).join("\n"),
  /renderLiveTurnArticle/,
  "the heartbeat must never full-render the article per second",
);
runtime.liveTurn.assistantText = "hello world";
assert.notEqual(runtimeVisualSig(runtime), first, "visible assistant text changes should invalidate the signature");

assert.equal(shouldThrottleLiveRender({ phase: "starting", liveTurn: { final: null } }), true);
assert.equal(shouldThrottleLiveRender({ phase: "streaming", liveTurn: { final: null } }), true);
assert.equal(shouldThrottleLiveRender({ phase: "tool_running", liveTurn: { final: null } }), true);
assert.equal(shouldThrottleLiveRender({ phase: "idle", liveTurn: { final: null } }), false);
assert.equal(shouldThrottleLiveRender({ phase: "streaming", liveTurn: { final: { type: "turn.completed" } } }), false);
assert.equal(shouldThrottleLiveRender({ phase: "streaming", liveTurn: null }), false);

assert.equal(shouldFollowLiveRender({
  preserveScroll: false,
  activeSession: true,
  userScrollDetached: false,
  nearBottom: true,
}), true);
assert.equal(shouldFollowLiveRender({
  preserveScroll: true,
  activeSession: true,
  userScrollDetached: false,
  nearBottom: true,
}), false);
assert.equal(shouldFollowLiveRender({
  preserveScroll: false,
  activeSession: false,
  userScrollDetached: false,
  nearBottom: true,
}), false);
assert.equal(shouldFollowLiveRender({
  preserveScroll: false,
  activeSession: true,
  userScrollDetached: true,
  nearBottom: true,
}), false);
assert.equal(shouldFollowLiveRender({
  preserveScroll: false,
  activeSession: true,
  userScrollDetached: false,
  nearBottom: false,
}), false);

assert.equal(hasCommittedScheduledDraftTurn({
  committedMessages: [
    { role: "assistant", turnId: "turn_1", meta: { scheduledDraft: { title: "Run later" } } },
  ],
}, "turn_1"), true);
assert.equal(hasCommittedScheduledDraftTurn({
  committedMessages: [
    { role: "assistant", turnId: "turn_1", meta: {} },
  ],
}, "turn_1"), false);
assert.equal(hasCommittedScheduledDraftTurn({ committedMessages: [] }, ""), false);

assert.equal(
  liveTurnRenderMode({
    liveTurn: { turnId: "turn_1", final: { type: "turn.completed" } },
    committedMessages: [
      { role: "assistant", turnId: "turn_1", meta: { scheduledDraft: { title: "Run later" } } },
    ],
  }),
  "remove-duplicate",
  "scheduled draft committed cards should remove the duplicate live article",
);
assert.equal(
  liveTurnRenderMode({
    liveTurn: { turnId: "turn_1", final: { type: "turn.completed" } },
    committedMessages: [{ role: "assistant", turnId: "turn_1", meta: {} }],
  }),
  "remove-duplicate",
  "completed live turns should be removed once the committed assistant for the same turn exists",
);
assert.equal(
  liveTurnRenderMode({
    liveTurn: { turnId: "turn_1" },
    committedMessages: [{ role: "assistant", turnId: "turn_1", meta: {} }],
  }),
  "render",
  "active live turns keep rendering; committed duplicates are skipped elsewhere until the turn is final",
);
assert.equal(liveTurnRenderMode({ liveTurn: null, committedMessages: [] }), "none");
assert.equal(liveTurnRenderMode({ committedMessages: [] }), "none");

assert.equal(shouldUpdateConversationMinimap({
  activeSession: true,
  panelConnected: true,
  panelActive: true,
  samePanel: true,
}), true);
assert.equal(shouldUpdateConversationMinimap({
  activeSession: false,
  panelConnected: true,
  panelActive: true,
  samePanel: true,
}), false);
assert.equal(shouldUpdateConversationMinimap({
  activeSession: true,
  panelConnected: false,
  panelActive: true,
  samePanel: true,
}), false);
assert.equal(shouldUpdateConversationMinimap({
  activeSession: true,
  panelConnected: true,
  panelActive: false,
  samePanel: true,
}), false);
assert.equal(shouldUpdateConversationMinimap({
  activeSession: true,
  panelConnected: true,
  panelActive: true,
  samePanel: false,
}), false);

const messageSource = readFileSync(
  new URL("../src/renderer/modules/message.js", import.meta.url),
  "utf8",
);
assert.match(messageSource, /from "\.\/message-live-render-model\.js"/);
assert.match(messageSource, /liveTurnRenderMode\(runtime\)/);
assert.match(messageSource, /shouldUpdateConversationMinimap\(/);
assert.doesNotMatch(messageSource, /function runtimeVisualSig\s*\(/);
assert.doesNotMatch(messageSource, /function shouldThrottleLiveRender\s*\(/);
assert.doesNotMatch(messageSource, /function committedScheduledDraftTurn\s*\(/);

console.log("message-live-render-model: ok");
