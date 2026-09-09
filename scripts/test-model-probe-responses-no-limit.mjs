#!/usr/bin/env node
/**
 * A Codex/Responses proxy that refuses max_output_tokens.
 *
 * Reproduces the field report: a proxy at /codex/v1 whose chat surface says
 * "use responses" and whose Responses surface rejects `max_output_tokens`
 * ("Unsupported parameter: max_output_tokens"). The probe must learn the
 * Responses surface AND drop the refused field, not fail with HTTP_400.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
process.env.LILY_ALLOW_PLAINTEXT_SECRETS = "1";
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lily-codex-proxy-"));
process.env.LILY_USER_DATA_DIR = tmp; process.env.LILY_HOME = os.homedir(); process.env.LILY_DOCUMENTS_DIR = tmp;
const require = createRequire(import.meta.url);
const { probeCustomModelProfile } = require("../src/main/model-compatibility-probe.js");
const shapes = require("../src/main/openai-request-shape.js");
const responsesProbe = require("../src/main/model-probe-responses.js");

const seen = [];
const server = http.createServer((req, res) => {
  let b = ""; req.on("data", (c) => { b += c; });
  req.on("end", () => {
    const parsed = JSON.parse(b || "{}"); seen.push({ url: req.url, body: parsed });
    const json = (s, o) => { res.writeHead(s, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
    if (req.url.endsWith("/chat/completions")) {
      // Codex proxy: chat surface is not supported, points at responses.
      return json(404, { error: { message: "This model is not supported in the v1/chat/completions endpoint. Use the v1/responses endpoint instead.", type: "invalid_request_error", code: null } });
    }
    if (req.url.endsWith("/responses")) {
      if ("max_output_tokens" in parsed) {
        return json(400, { error: { message: "Unsupported parameter: max_output_tokens", type: "invalid_request_error", param: "max_output_tokens", code: "invalid_request_error" } });
      }
      const wantsTools = Array.isArray(parsed.tools) && parsed.tools.length > 0;
      const call = { type: "function_call", id: "fc_1", call_id: "call_1", name: "lily_probe_tool", arguments: "{\"ok\":true}" };
      if (parsed.stream) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        if (wantsTools) {
          res.write(`data: ${JSON.stringify({ type: "response.output_item.added", item: call })}\n\n`);
          res.write(`data: ${JSON.stringify({ type: "response.function_call_arguments.done", item: call })}\n\n`);
        } else {
          res.write(`data: ${JSON.stringify({ type: "response.output_text.delta", delta: "pong" })}\n\n`);
        }
        res.write(`data: ${JSON.stringify({ type: "response.completed", response: { status: "completed" } })}\n\n`);
        res.write("data: [DONE]\n\n"); res.end(); return;
      }
      return json(200, { id: "r", status: "completed", output: wantsTools ? [call] : [{ type: "message", content: [{ type: "output_text", text: "pong" }] }], usage: { output_tokens: 3 } });
    }
    json(404, { error: "not found" });
  });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const baseUrl = `http://127.0.0.1:${server.address().port}/codex/v1`;
try {
  shapes.resetLearnedShapesForTests(); responsesProbe.resetResponsesProbeStateForTests();
  const r = await probeCustomModelProfile({ protocol: "openai", baseUrl, apiKey: "sk-test", model: "gpt-5.3-codex-spark", timeoutMs: 5000 });
  assert.equal(r.ok, true, `codex proxy that refuses max_output_tokens must still pass: ${JSON.stringify(r)}`);
  assert.equal(r.profile.requestShape?.api, "responses", "learned the Responses surface");
  assert.equal(r.profile.conformance.toolCalls, true);
  // Not one request that survived carried max_output_tokens on /responses AND got 200.
  const okResponses = seen.filter((s) => s.url.endsWith("/responses") && !("max_output_tokens" in s.body));
  assert.ok(okResponses.length >= 1, "at least one accepted /responses request omitted max_output_tokens");
  assert.ok(seen.some((s) => s.url.endsWith("/responses") && "max_output_tokens" in s.body), "the field was tried once (that is how we learn to drop it)");
  // Directly exercise the standalone Responses tool probe (the fallback path):
  // it too must drop max_output_tokens when the endpoint refuses it.
  responsesProbe.resetResponsesProbeStateForTests(); seen.length = 0;
  const direct = await responsesProbe.probeToolsViaResponses({ baseUrl, apiKey: "sk-test", model: "gpt-5.3-codex-spark", timeoutMs: 5000 });
  assert.equal(direct.ok, true, `direct Responses tool probe must pass without max_output_tokens: ${JSON.stringify(direct)}`);
  assert.equal(direct.hasToolCalls, true);
  assert.ok(seen.some((x) => x.url.endsWith("/responses") && "max_output_tokens" in x.body), "tried the field once");
  assert.ok(seen.some((x) => x.url.endsWith("/responses") && !("max_output_tokens" in x.body) && Array.isArray(x.body.tools)), "retried without it and succeeded");
  console.log("model probe responses no-limit (codex proxy): ok");
} finally {
  server.close(); fs.rmSync(tmp, { recursive: true, force: true });
}
