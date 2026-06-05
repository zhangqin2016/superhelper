#!/usr/bin/env node

import assert from "node:assert/strict";
import {
  truncateToolResultForUi,
  processEventFromClaudeEvent,
} from "../src/main/cli-process-payload.js";

{
  const short = truncateToolResultForUi("hello");
  assert.equal(short.truncated, false);
  assert.equal(short.content, "hello");

  const long = truncateToolResultForUi("x".repeat(20_000));
  assert.equal(long.truncated, true);
  assert.ok(long.content.includes("truncated for display"));
  assert.equal(long.fullText.length, 20_000);
}

{
  const payload = processEventFromClaudeEvent(
    { type: "assistant", subtype: "message", message: { content: [{ type: "text", text: "hi" }] } },
    [{ kind: "assistant_text", text: "hi" }],
  );
  assert.equal(payload.rawType, "assistant");
  assert.equal(payload.summary, "hi");
  assert.equal(payload.actions.length, 1);
}

console.log("test-cli-process-payload: ALL_OK");
