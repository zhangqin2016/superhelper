#!/usr/bin/env node
/** A probe rejection the learner could not turn into a lesson is reported to
 *  the server (host, model, the server's redacted words) so a hint can be
 *  shipped — best effort, never blocking the save, never carrying the key. */
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
process.env.LILY_ALLOW_PLAINTEXT_SECRETS = "1";
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "probe-telemetry-"));
process.env.LILY_USER_DATA_DIR = tmp; process.env.LILY_HOME = os.homedir(); process.env.LILY_DOCUMENTS_DIR = tmp;
const reports = [];
const scPath = require.resolve("../src/main/service-client.js");
require.cache[scPath] = { id: scPath, filename: scPath, loaded: true, exports: { reportRuntimeDiagnostic: async (payload) => { reports.push(payload); return { ok: true }; }, configuredServiceApiBaseUrl: () => "" } };
const presets = require("../src/main/model-presets.js");
const server = http.createServer((req, res) => { let b = ""; req.on("data", (c) => { b += c; }); req.on("end", () => { res.writeHead(404, { "content-type": "application/json" }); res.end(JSON.stringify({ error: { message: "The model `ghost` does not exist or you do not have access to it.", code: "model_not_found" } })); }); });
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
const key = "sk-very-secret-key-1234567890";
try {
  const saved = await presets.saveCustomPresetWithProbe({ label: "Ghost", model: "ghost", baseUrl, apiKey: key, protocol: "openai", probeTimeoutMs: 3000 });
  assert.equal(saved.ok, false); assert.equal(saved.error, "HTTP_404");
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(reports.length, 1, "exactly one report for the unhandled rejection");
  assert.equal(reports[0].eventType, "model_probe"); assert.equal(reports[0].normalizedKind, "model_not_found");
  assert.match(reports[0].summary, /127\.0\.0\.1.*ghost.*does not exist/);
  assert.equal(JSON.stringify(reports[0]).includes(key), false, "the key never rides a report");
  console.log("model probe telemetry: ok");
} finally { server.close(); fs.rmSync(tmp, { recursive: true, force: true }); }
