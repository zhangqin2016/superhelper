#!/usr/bin/env node

import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  adaptOpencodeMessagesPage,
  adaptOpencodeMessageItem,
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

console.log("opencode-conversation-adapter: ok");
