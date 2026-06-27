#!/usr/bin/env node

import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  adaptOpencodeMessagesPage,
  adaptOpencodeMessageItem,
  coalesceAssistantMessageRuns,
} = require("../src/main/runtime/opencode-conversation-adapter.js");

const page = adaptOpencodeMessagesPage({
  items: [
    {
      info: {
        id: "msg_user",
        sessionID: "ses_1",
        role: "user",
        time: { created: 1710000000000 },
      },
      parts: [
        { id: "prt_user_text", messageID: "msg_user", type: "text", text: "hello" },
        {
          id: "prt_file",
          messageID: "msg_user",
          type: "file",
          filename: "shot.png",
          mime: "image/png",
          url: "file:///tmp/shot.png",
          source: { type: "file", path: "/tmp/shot.png" },
        },
      ],
    },
    {
      info: {
        id: "msg_assistant",
        sessionID: "ses_1",
        role: "assistant",
        time: { created: 1710000001000, completed: 1710000002000 },
        cost: 0.01,
        tokens: { input: 10, output: 5, reasoning: 2, cache: { read: 1, write: 0 } },
        finish: "stop",
      },
      parts: [
        { id: "prt_reason", messageID: "msg_assistant", type: "reasoning", text: "thinking" },
        { id: "prt_text_a", messageID: "msg_assistant", type: "text", text: "hi " },
        { id: "prt_text_b", messageID: "msg_assistant", type: "text", text: "there" },
      ],
    },
  ],
  sessionId: "app_session",
  projectId: "proj",
  cursor: "cur_older",
  complete: false,
});

assert.equal(page.ok, true);
assert.equal(page.source, "opencode");
assert.equal(page.sessionId, "app_session");
assert.equal(page.conversation.length, 2);
assert.equal(page.conversation[0].id, "msg_user");
assert.equal(page.conversation[0].role, "user");
assert.equal(page.conversation[0].content, "hello");
assert.deepEqual(page.conversation[0].files, [{
  name: "shot.png",
  path: "/tmp/shot.png",
  uri: "file:///tmp/shot.png",
  mime: "image/png",
}]);
assert.equal(page.conversation[1].role, "assistant");
assert.equal(page.conversation[1].content, "hi there");
assert.equal(page.conversation[1].record.assistantText, "hi there");
assert.equal(page.conversation[1].record.thinkingText, "thinking");
assert.equal(page.conversation[1].record.engineMessageId, "msg_assistant");
assert.equal(page.conversation[1].record.usage.input_tokens, 10);
assert.equal(page.nextBefore, "cur_older");
assert.equal(page.hasMore, true);

const ignored = adaptOpencodeMessageItem({
  info: { id: "msg_empty", role: "assistant", time: { created: 0 } },
  parts: [{ id: "prt_ignored", messageID: "msg_empty", type: "text", text: "nope", ignored: true }],
});
assert.equal(ignored.content, "");

const mergedPage = adaptOpencodeMessagesPage({
  items: [
    {
      info: { id: "msg_u2", role: "user", time: { created: 1710000003000 } },
      parts: [{ type: "text", text: "learn login" }],
    },
    {
      info: {
        id: "msg_a2_1",
        role: "assistant",
        time: { created: 1710000004000, completed: 1710000005000 },
        tokens: { input: 3, output: 4, reasoning: 1 },
        cost: 0.01,
      },
      parts: [
        { type: "reasoning", text: "check runtime" },
        { type: "text", text: "Playwright is available." },
      ],
    },
    {
      info: {
        id: "msg_a2_2",
        role: "assistant",
        time: { created: 1710000006000, completed: 1710000008000 },
        tokens: { input: 5, output: 6, reasoning: 2 },
        cost: 0.02,
      },
      parts: [
        { type: "reasoning", text: "capture auth" },
        { type: "text", text: "Login captured." },
      ],
    },
    {
      info: { id: "msg_u3", role: "user", time: { created: 1710000009000 } },
      parts: [{ type: "text", text: "next" }],
    },
  ],
});

assert.equal(mergedPage.conversation.length, 3, "consecutive assistant history rows render as one turn");
assert.equal(mergedPage.conversation[1].id, "msg_a2_2", "latest assistant message remains the rewind anchor");
assert.equal(
  mergedPage.conversation[1].content,
  "Playwright is available.\n\nLogin captured.",
  "assistant text is merged without separate bubbles",
);
assert.equal(
  mergedPage.conversation[1].record.thinkingText,
  "check runtime\n\ncapture auth",
  "reasoning text is merged into one process section",
);
assert.equal(mergedPage.conversation[1].record.usage.input_tokens, 8, "usage is summed across assistant fragments");
assert.equal(mergedPage.conversation[1].record.usage.output_tokens, 13, "output usage includes reasoning from all fragments");
assert.equal(mergedPage.conversation[1].record.durationMs, 4000, "duration spans the assistant run");
assert.equal(mergedPage.conversation[1].record.totalCostUsd, 0.03, "cost is summed across assistant fragments");
assert.deepEqual(
  mergedPage.conversation[1].record.meta.opencode.mergedAssistantMessageIds,
  ["msg_a2_1", "msg_a2_2"],
  "merged official message ids are retained for diagnostics",
);
assert.equal(mergedPage.conversation[2].role, "user", "a user message starts the next turn");

const manualMerged = coalesceAssistantMessageRuns([
  { id: "a1", role: "assistant", content: "same", record: { assistantText: "same" } },
  { id: "a2", role: "assistant", content: "same", record: { assistantText: "same" } },
]);
assert.equal(manualMerged.length, 1, "adjacent duplicate assistant text is not repeated");
assert.equal(manualMerged[0].content, "same");

// Regression: tool parts MUST survive into record.tools. Previously the adapter
// hardcoded tools:[], so on history reload every tool — and any generated media
// carried in its output — vanished (the user saw "no preview" for a video that
// was really generated). WHY it matters: the renderer's generated-media hoist reads
// record.tools[].result; with empty tools there is nothing to hoist, degrading
// below the baseline file-chip affordance.
const withTool = adaptOpencodeMessageItem({
  info: {
    id: "msg_tool",
    role: "assistant",
    time: { created: 1710000010000, completed: 1710000012000 },
  },
  parts: [
    { type: "text", text: "第三版生成完毕" },
    {
      type: "tool",
      tool: "bash",
      callID: "call_vid_1",
      state: {
        status: "completed",
        input: { command: "node generate-video.cjs" },
        output: "[4/4] Done! saved to:\n  /ws/generated-assets/video-a92cdf.mp4\n",
        metadata: { truncated: false },
      },
    },
  ],
}, { turnId: "turn_tool", sessionId: "ses_tool" });
assert.equal(withTool.record.tools.length, 1, "tool parts must populate record.tools");
assert.equal(withTool.record.tools[0].id, "call_vid_1");
assert.equal(withTool.record.tools[0].name, "bash");
assert.equal(withTool.record.tools[0].status, "done", "completed maps to done");
assert.equal(withTool.record.meta.toolsSummary.count, 1, "toolsSummary reflects real count");
assert.ok(
  withTool.record.tools[0].result.content.includes("generated-assets/video-a92cdf.mp4"),
  "captured tool output (with the generated media path) is preserved",
);

// Coalesced assistant runs must keep tools from every fragment, not just the last.
const toolMerge = adaptOpencodeMessagesPage({
  items: [
    {
      info: { id: "msg_tm1", role: "assistant", time: { created: 1, completed: 2 } },
      parts: [{ type: "tool", tool: "bash", callID: "c1", state: { status: "completed", output: "a", input: {} } }],
    },
    {
      info: { id: "msg_tm2", role: "assistant", time: { created: 3, completed: 4 } },
      parts: [{ type: "tool", tool: "bash", callID: "c2", state: { status: "completed", output: "b", input: {} } }],
    },
  ],
});
assert.equal(toolMerge.conversation[0].record.tools.length, 2, "tools from all coalesced assistant fragments survive");

console.log("opencode-conversation-adapter: ok");
