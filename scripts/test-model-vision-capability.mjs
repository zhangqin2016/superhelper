#!/usr/bin/env node
/**
 * A custom model that accepts images must become usable for image recognition:
 * the probe detects vision from the endpoint's own response, it is persisted on
 * the preset (capabilities.vision), a manual toggle also sets it, and
 * activePresetSupportsVision() then routes images to the model (not the bridge).
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
process.env.LILY_ALLOW_PLAINTEXT_SECRETS = "1";
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lily-vision-"));
process.env.LILY_USER_DATA_DIR = tmp; process.env.LILY_HOME = os.homedir(); process.env.LILY_DOCUMENTS_DIR = tmp;
const require = createRequire(import.meta.url);
const presets = require("../src/main/model-presets.js");

// A vision-capable endpoint: accepts an image content part; a text-only one 400s on images.
const mk = (vision) => http.createServer((req, res) => {
  let b = ""; req.on("data", (c) => { b += c; });
  req.on("end", () => {
    const p = JSON.parse(b || "{}"); const json = (s, o) => { res.writeHead(s, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
    if (!req.url.includes("/chat/completions")) return json(404, { error: "nope" });
    const hasImage = (p.messages || []).some((m) => Array.isArray(m.content) && m.content.some((c) => c?.type === "image_url"));
    if (hasImage && !vision) return json(400, { error: { message: "This model does not support image input.", type: "invalid_request_error", param: "messages", code: "unsupported" } });
    const hasTools = Array.isArray(p.tools) && p.tools.length;
    const call = { id: "c", type: "function", function: { name: "lily_probe_tool", arguments: "{\"ok\":true}" } };
    if (p.stream) { res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: hasTools ? { tool_calls: [{ index: 0, ...call }] } : { content: "ok" }, finish_reason: hasTools ? "tool_calls" : "stop" }] })}\n\n`);
      res.write("data: [DONE]\n\n"); res.end(); return; }
    json(200, { choices: [{ index: 0, message: hasTools ? { role: "assistant", content: null, tool_calls: [call] } : { role: "assistant", content: "ok" }, finish_reason: hasTools ? "tool_calls" : "stop" }], usage: {} });
  });
});
const listen = (s) => new Promise((r) => s.listen(0, "127.0.0.1", () => r(`http://127.0.0.1:${s.address().port}/v1`)));
const visionSrv = mk(true), textSrv = mk(false);
const vurl = await listen(visionSrv), turl = await listen(textSrv);
try {
  // 1. Probe auto-detects vision on the vision endpoint.
  const saved = await presets.saveCustomPresetWithProbe({ label: "Vision Model", model: "vm", baseUrl: vurl, apiKey: "sk-x0123456789", protocol: "openai", probeTimeoutMs: 5000 });
  assert.equal(saved.ok, true, JSON.stringify(saved));
  const vp = presets.listPresetsPublic().presets.find((p) => p.custom && p.model === "vm");
  assert.equal(vp?.capabilities?.vision, true, "probe auto-detected vision is persisted on the preset");
  presets.setActivePreset(vp.id);
  assert.equal(presets.activePresetSupportsVision(), true, "images route to the model, not the bridge");

  // 2. A text-only endpoint does NOT get vision (probe fail-open).
  const savedText = await presets.saveCustomPresetWithProbe({ label: "Text Model", model: "tm", baseUrl: turl, apiKey: "sk-y0123456789", protocol: "openai", probeTimeoutMs: 5000 });
  assert.equal(savedText.ok, true, JSON.stringify(savedText));
  const tp = presets.listPresetsPublic().presets.find((p) => p.custom && p.model === "tm");
  assert.ok(!tp?.capabilities?.vision, "a text-only endpoint is not marked vision-capable");

  // 3. Manual toggle sets vision even without a probe (LILY_PROBE_VISION=0 → probe off).
  process.env.LILY_PROBE_VISION = "0";
  const manual = await presets.saveCustomPresetWithProbe({ label: "Manual Vision", model: "mv", baseUrl: turl, apiKey: "sk-z0123456789", protocol: "openai", capabilities: { vision: true }, probeTimeoutMs: 5000 });
  assert.equal(manual.ok, true, JSON.stringify(manual));
  const mp = presets.listPresetsPublic().presets.find((p) => p.custom && p.model === "mv");
  assert.equal(mp?.capabilities?.vision, true, "the manual toggle sets vision even with probing off");
  delete process.env.LILY_PROBE_VISION;

  // 4. An unrelated edit does not clear a set vision flag.
  const upd = presets.updateCustomPreset(mp.id, { label: "Manual Vision (renamed)", model: "mv", baseUrl: turl, protocol: "openai" });
  assert.equal(upd.ok, true, JSON.stringify(upd));
  const mp2 = presets.listPresetsPublic().presets.find((p) => p.id === mp.id);
  assert.equal(mp2?.capabilities?.vision, true, "a rename does not silently clear vision");
  console.log("model vision capability: ok");
} finally { visionSrv.close(); textSrv.close(); fs.rmSync(tmp, { recursive: true, force: true }); }
