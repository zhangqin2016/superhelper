#!/usr/bin/env node

import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { buildOpencodePromptBody } = require("../src/main/runtime/opencode-message-parts.js");

{
  const body = buildOpencodePromptBody({
    agent: "build",
    guidance: "SYSTEM GUIDE",
    text: "user request",
    model: { providerID: "anthropic", modelID: "deepseek-v4-pro[1m]" },
  });
  assert.equal(body.system, "SYSTEM GUIDE", "guidance must use OpenCode's system field");
  assert.deepEqual(body.parts, [{ type: "text", text: "user request" }], "user parts contain only user content");
  assert.deepEqual(body.model, { providerID: "anthropic", modelID: "deepseek-v4-pro[1m]" }, "model ref carried");
}

{
  const body = buildOpencodePromptBody({ guidance: "  ", text: "hello" });
  assert.equal("system" in body, false, "blank guidance is omitted");
  assert.deepEqual(body.parts, [{ type: "text", text: "hello" }], "text-only prompt remains valid");
}

console.log("opencode-message-parts: ok");
