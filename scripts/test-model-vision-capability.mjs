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

  // 6. The probe image itself must be a VALID PNG. A strict endpoint decodes it
  // and rejects a malformed one, so a corrupt constant silently turned every
  // image-capable preset into vision:false (2026-09-19 field case: the previous
  // constant was truncated and carried a wrong IDAT CRC).
  const { TINY_PNG_DATA_URL } = require("../src/main/model-probe-vision.js");
  const png = Buffer.from(String(TINY_PNG_DATA_URL).split(",")[1] || "", "base64");
  assert.ok(png.length > 0, "the probe image must decode from base64");
  assert.equal(png.subarray(0, 8).toString("hex"), "89504e470d0a1a0a", "PNG signature");
  const table = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc32 = (buf) => { let c = 0xffffffff; for (const byte of buf) c = table[(c ^ byte) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  let at = 8; const seen = [];
  while (at + 12 <= png.length) {
    const len = png.readUInt32BE(at);
    const type = png.subarray(at + 4, at + 8).toString("latin1");
    assert.ok(at + 12 + len <= png.length, `chunk ${type} is truncated`);
    const stored = png.readUInt32BE(at + 8 + len);
    assert.equal(stored, crc32(png.subarray(at + 4, at + 8 + len)), `chunk ${type} CRC must match`);
    seen.push(type); at += 12 + len;
  }
  assert.equal(at, png.length, "no trailing bytes after the last chunk");
  assert.ok(seen.includes("IHDR") && seen.includes("IDAT") && seen.includes("IEND"), `probe PNG chunks: ${seen.join(",")}`);

  // And the same image must survive an endpoint that actually decodes it.
  const strictSrv = http.createServer((req, res) => {
    let body = ""; req.on("data", (c) => { body += c; });
    req.on("end", () => {
      const p = JSON.parse(body || "{}");
      const send = (s, o) => { res.writeHead(s, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
      const part = (p.messages || []).flatMap((m) => (Array.isArray(m.content) ? m.content : [])).find((c) => c?.type === "image_url");
      if (part) {
        const bytes = Buffer.from(String(part.image_url?.url || "").split(",")[1] || "", "base64");
        let valid = bytes.subarray(0, 8).toString("hex") === "89504e470d0a1a0a";
        let i = 8; const kinds = [];
        while (valid && i + 12 <= bytes.length) {
          const len = bytes.readUInt32BE(i); const type = bytes.subarray(i + 4, i + 8).toString("latin1");
          if (i + 12 + len > bytes.length || bytes.readUInt32BE(i + 8 + len) !== crc32(bytes.subarray(i + 4, i + 8 + len))) { valid = false; break; }
          kinds.push(type); i += 12 + len;
        }
        if (!valid || i !== bytes.length || !kinds.includes("IEND")) {
          return send(400, { error: { message: "The image data you provided does not represent a valid image.", type: "invalid_request_error", code: "invalid_value" } });
        }
      }
      send(200, { choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }], usage: {} });
    });
  });
  const strictUrl = await listen(strictSrv);
  try {
    const { probeVision } = require("../src/main/model-probe-vision.js");
    const detected = await probeVision({ baseUrl: strictUrl, apiKey: "k", model: "strict", timeoutMs: 10_000 });
    assert.equal(detected, true, "an endpoint that truly decodes images must still be detected as vision-capable");
  } finally { strictSrv.close(); }

  console.log("model vision capability: ok");
} finally { visionSrv.close(); textSrv.close(); fs.rmSync(tmp, { recursive: true, force: true }); }
