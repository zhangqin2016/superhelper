#!/usr/bin/env node
// Runtime self-heal closed loop: a stale/wrong compatibility profile + a
// shape-limited gateway → attemptModelSelfHeal force-re-probes, the profile
// gains toolShapeCompat, and the caller is told to retry. Also covers the
// guard rails: cooldown, non-healable codes, kill switch.
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lily-self-heal-"));
process.env.LILY_USER_DATA_DIR = tmp;
process.env.LILY_HOME = os.homedir();
process.env.LILY_DOCUMENTS_DIR = tmp;

const require = createRequire(import.meta.url);

// A gateway in the OICM+ family: rejects Lily-shaped tools (long names /
// nested object params) with an HTML error page, accepts everything else.
let probeRequests = 0;
const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (chunk) => {
    body += chunk;
  });
  req.on("end", () => {
    probeRequests += 1;
    const parsed = JSON.parse(body || "{}");
    const tools = Array.isArray(parsed.tools) ? parsed.tools : [];
    const hasNestedObject = (schema) => Object.values(schema?.properties || {})
      .some((prop) => prop?.type === "object" && prop?.properties);
    const rejected = tools.some((tool) =>
      String(tool?.function?.name || "").length > 35 || hasNestedObject(tool?.function?.parameters));
    if (rejected) {
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<!DOCTYPE html><title>Server Unreachable</title>");
      return;
    }
    if (parsed.stream) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
      send({
        id: "c",
        object: "chat.completion.chunk",
        model: parsed.model,
        choices: [{
          index: 0,
          delta: tools.length
            ? { tool_calls: [{ index: 0, id: "t", type: "function", function: { name: "lily_probe_tool", arguments: "{\"ok\":true}" } }] }
            : { content: "pong" },
          finish_reason: null,
        }],
      });
      send({ id: "c", object: "chat.completion.chunk", model: parsed.model, choices: [{ index: 0, delta: {}, finish_reason: tools.length ? "tool_calls" : "stop" }] });
      res.write("data: [DONE]\n\n");
      res.end();
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      id: "c",
      object: "chat.completion",
      model: parsed.model,
      choices: [{
        index: 0,
        message: tools.length
          ? { role: "assistant", content: null, tool_calls: [{ id: "t", type: "function", function: { name: "lily_probe_tool", arguments: "{\"ok\":true}" } }] }
          : { role: "assistant", content: "pong" },
        finish_reason: tools.length ? "tool_calls" : "stop",
      }],
    }));
  });
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
try {
  const { port } = server.address();
  // Stored profile is current-version but WRONG for this gateway: no
  // toolShapeCompat (mirrors "gateway behavior changed behind an unchanged
  // config" and "profile predates the defect").
  fs.writeFileSync(path.join(tmp, "model-settings.json"), JSON.stringify({
    activePresetId: "custom-heal",
    customPresets: [{
      id: "custom-heal",
      label: "Heal Me",
      model: "provider/heal-model",
      baseUrl: `http://127.0.0.1:${port}/v1`,
      apiKey: "sk-test-heal-123456",
      protocol: "openai",
      compatibilityProfile: {
        probeVersion: 2,
        conformance: { chatCompletions: true, streaming: true, toolCalls: true, contentSource: "plain" },
        prompt: { systemMaxChars: 10000 },
      },
    }],
    apiGateway: { mode: "builtin" },
  }));

  const { attemptModelSelfHeal, isHealableFailureCode, resetSelfHealStateForTests } = require("../src/main/model-self-heal.js");
  const presets = require("../src/main/model-presets.js");

  assert.equal(isHealableFailureCode("EMPTY_ASSISTANT_COMPLETION"), true);
  assert.equal(isHealableFailureCode("RESPONSE_ERROR"), true,
    "explicit empty/invalid-response failures (runtime face of MODEL_STREAMING_NO_CONTENT) are probe-fixable");
  assert.equal(isHealableFailureCode("ENGINE_PROCESS_EXITED"), false, "process exits are not probe-fixable");

  // Non-healable code → no probe traffic.
  const skipped = await attemptModelSelfHeal({ code: "ENGINE_PROCESS_EXITED" });
  assert.equal(skipped.attempted, false);
  assert.equal(probeRequests, 0, "non-healable failures must not probe the gateway");

  // Kill switch → no probe traffic.
  process.env.LILY_ENABLE_MODEL_SELF_HEAL = "0";
  const disabled = await attemptModelSelfHeal({ code: "EMPTY_ASSISTANT_COMPLETION" });
  assert.equal(disabled.attempted, false);
  assert.equal(disabled.reason, "disabled");
  delete process.env.LILY_ENABLE_MODEL_SELF_HEAL;
  assert.equal(probeRequests, 0, "kill switch must prevent all probe traffic");

  // Healable failure → forced re-probe discovers toolShapeCompat → healed.
  const healed = await attemptModelSelfHeal({ code: "EMPTY_ASSISTANT_COMPLETION" });
  assert.equal(healed.attempted, true, `self-heal should attempt: ${JSON.stringify(healed)}`);
  assert.equal(healed.healed, true, `profile change must be reported for retry: ${JSON.stringify(healed)}`);
  assert.ok(probeRequests > 0, "self-heal must actually probe the gateway");
  const stored = JSON.parse(fs.readFileSync(path.join(tmp, "model-settings.json"), "utf8"));
  const profile = stored.customPresets[0].compatibilityProfile;
  assert.equal(profile.toolShapeCompat, true, "healed profile must carry toolShapeCompat");
  const env = presets.getUserApiEnv();
  assert.equal(env.LILY_OPENCODE_TOOL_COMPAT, "1", "healed profile must reach runtime env");

  // Cooldown: an immediate second failure must not probe again.
  const before = probeRequests;
  const cooled = await attemptModelSelfHeal({ code: "EMPTY_ASSISTANT_COMPLETION" });
  assert.equal(cooled.attempted, false);
  assert.equal(cooled.reason, "cooldown");
  assert.equal(probeRequests, before, "cooldown must prevent probe stampedes");

  // After cooldown expires (simulated), a re-probe runs but the profile is now
  // correct → healed=false → no retry loop.
  resetSelfHealStateForTests();
  const again = await attemptModelSelfHeal({ code: "EMPTY_ASSISTANT_COMPLETION" });
  assert.equal(again.attempted, true);
  assert.equal(again.healed, false, "unchanged profile must not trigger another retry");
} finally {
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log("model-self-heal: ok");
