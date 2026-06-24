#!/usr/bin/env node
import assert from "node:assert/strict";
import module from "node:module";

const require = module.createRequire(import.meta.url);
const {
  buildShortFollowupContext,
  isTerseFollowup,
  withShortFollowupContext,
} = require("../src/main/session-followup-context.js");

assert.equal(isTerseFollowup("？"), true);
assert.equal(isTerseFollowup("?"), true);
assert.equal(isTerseFollowup("继续"), true);
assert.equal(isTerseFollowup("分析 imsdk 流转流程"), false);

const context = buildShortFollowupContext({
  userText: "？",
  summary: {
    lastUserIntent: "分析 imsdk 流转流程",
    lastAssistantResult: "基于 cst-acc-ws 和 cst-lcas 分析了会议链路。",
    pendingTask: "分析 imsdk 流转流程",
  },
  messages: [
    { role: "user", content: "分析 imsdk 流转流程" },
    {
      role: "assistant",
      failed: true,
      content: "基于 cst-* 代码分析会议链路。",
      record: { terminal: "turn.failed" },
    },
  ],
});

assert.match(context, /Short Follow-up Continuity/);
assert.match(context, /分析 imsdk 流转流程/);
assert.match(context, /incomplete/);
assert.match(context, /cst-\*/);
assert.match(context, /last substantive request/);
assert.match(context, /substituted neighboring subsystem/);

const layered = withShortFollowupContext({
  userText: "？",
  engineText: "？",
  summary: { pendingTask: "分析 imsdk 流转流程" },
  messages: [{ role: "user", content: "分析 imsdk 流转流程" }],
});
assert.equal(layered.applied, true);
assert.match(layered.text, /title="platform_context"/);
assert.match(layered.text, /title="user_original_request"/);
assert.match(layered.text, /分析 imsdk 流转流程/);
assert.match(layered.text, />\nHighest priority[\s\S]*？\n<\/lily_layer>/);

console.log("session-followup-context: ok");
