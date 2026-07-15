#!/usr/bin/env node
// Guards the reasoning-model probe fixes: a thinking model that (a) emits
// reasoning_content, (b) rejects a FORCED tool_choice with 400, but (c) tool-calls
// fine under tool_choice:"auto" — must be ACCEPTED by the compatibility probe
// (via the auto fallback), not false-rejected as MODEL_TOOL_CALLS_UNAVAILABLE.
import assert from "node:assert/strict";
import http from "node:http";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { probeCustomModelProfile } = require("../src/main/model-compatibility-probe.js");

let forcedRejections = 0;
let autoToolCalls = 0;

const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => { body += c; });
  req.on("end", () => {
    const parsed = JSON.parse(body || "{}");
    const hasTools = Array.isArray(parsed.tools) && parsed.tools.length > 0;
    const forcedChoice = hasTools && parsed.tool_choice && typeof parsed.tool_choice === "object";

    // Thinking model: forced tool_choice is a hard 400 (deepseek behavior).
    if (forcedChoice) {
      forcedRejections += 1;
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "Thinking mode does not support this tool_choice", type: "invalid_request_error" } }));
      return;
    }

    const wantsTool = hasTools && parsed.tool_choice === "auto";
    if (wantsTool) autoToolCalls += 1;
    const toolCall = { id: "call_probe", type: "function", function: { name: "lily_probe_tool", arguments: "{\"ok\":true}" } };

    if (parsed.stream) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      const send = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`);
      // reasoning first (exercises reasoning_content recognition), then payload
      send({ choices: [{ index: 0, delta: { reasoning_content: "thinking…" }, finish_reason: null }] });
      send({ choices: [{ index: 0, delta: wantsTool ? { tool_calls: [{ index: 0, ...toolCall }] } : { content: "pong" }, finish_reason: null }] });
      send({ choices: [{ index: 0, delta: {}, finish_reason: wantsTool ? "tool_calls" : "stop" }] });
      res.write("data: [DONE]\n\n");
      res.end();
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      model: parsed.model,
      choices: [{
        index: 0,
        message: wantsTool
          ? { role: "assistant", content: "", reasoning_content: "thinking…", tool_calls: [toolCall] }
          : { role: "assistant", content: "pong", reasoning_content: "thinking…" },
        finish_reason: wantsTool ? "tool_calls" : "stop",
      }],
    }));
  });
});

await new Promise((r) => server.listen(0, "127.0.0.1", r));
const { port } = server.address();

try {
  const probe = await probeCustomModelProfile({
    protocol: "openai",
    baseUrl: `http://127.0.0.1:${port}/v1`,
    apiKey: "sk-test",
    model: "thinking/model",
    timeoutMs: 5_000,
  });
  assert.equal(probe.ok, true, `thinking model must be accepted via tool_choice auto fallback (got ${probe.error})`);
  assert.ok(forcedRejections > 0, "probe must have first tried a forced tool_choice (then fallen back)");
  assert.ok(autoToolCalls > 0, "probe must have retried with tool_choice:auto after the forced rejection");
} finally {
  server.close();
}

console.log("model-probe-thinking-toolchoice: ok");
