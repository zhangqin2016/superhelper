// Verifies BYOK OpenAI-compatible image generation is actually usable:
//   1. the openai adapter POSTs /images/generations and writes b64_json output
//   2. it accepts a returned url when no b64 is present
//   3. it self-heals a server that rejects response_format (gpt-image-1) by
//      retrying once without it, instead of failing
//   4. a missing key fails with a clear, non-empty error (never a silent no-op)
//   5. media-provider-settings maps the openai BYOK choice to the exact env
//      vars the adapter reads (OPENAI_IMAGE_API_KEY/BASE_URL/MODEL)
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, readdirSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const TINY = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const SCRIPT = path.resolve("resources/skills/lily-image-generation/scripts/providers/openai.cjs");
const SHELL = path.resolve("resources/skills/lily-image-generation/scripts/generate-image.cjs");

// mode drives the mock's response so one server exercises every path.
function startServer(mode) {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      if (!req.url.includes("/images/generations")) { res.writeHead(404); res.end("{}"); return; }
      const payload = JSON.parse(body || "{}");
      seen.push(payload);
      const json = (code, obj) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };
      if (mode === "reject-rf" && payload.response_format) {
        return json(400, { error: { message: "Unsupported parameter: response_format is not supported with this model." } });
      }
      if (mode === "url") return json(200, { created: 1, data: [{ url: `http://127.0.0.1:${server.address().port}/img.png` }] });
      return json(200, { created: 1, data: [{ b64_json: TINY }] });
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port, seen })));
}

function runShell({ port, env = {}, input }) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SHELL], {
      env: { ...process.env, LILY_LOCALE: "en", ...env },
    });
    let out = "", err = "";
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { err += d; });
    child.on("close", (code) => resolve({ code, out, err }));
    child.stdin.end(JSON.stringify(input));
  });
}

test("openai adapter writes b64_json output", async () => {
  const { server, port, seen } = await startServer("b64");
  const outDir = mkdtempSync(path.join(os.tmpdir(), "img-"));
  const r = await runShell({
    port,
    env: { OPENAI_IMAGE_API_KEY: "sk-x", OPENAI_IMAGE_BASE_URL: `http://127.0.0.1:${port}/v1`, OPENAI_IMAGE_MODEL: "gpt-image-1" },
    input: { provider: "openai", prompt: "a red circle", output_dir: outDir },
  });
  server.close();
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /generated_media type="image"/);
  assert.equal(seen[0].model, "gpt-image-1", "adapter sends the configured image model");
  const pngs = readdirSync(outDir).filter((f) => f.endsWith(".png"));
  assert.equal(pngs.length, 1, "one image file written");
  assert.ok(statSync(path.join(outDir, pngs[0])).size > 0, "image file is non-empty");
});

test("openai adapter accepts a returned url", async () => {
  const { server, port } = await startServer("url");
  const outDir = mkdtempSync(path.join(os.tmpdir(), "img-"));
  const r = await runShell({
    port,
    env: { OPENAI_IMAGE_API_KEY: "sk-x", OPENAI_IMAGE_BASE_URL: `http://127.0.0.1:${port}/v1` },
    input: { provider: "openai", prompt: "x", output_dir: outDir },
  });
  server.close();
  // download of the fake url returns the 404 body but the adapter path (url vs b64) is what we assert:
  // the run reaches the download stage rather than failing at "no image data".
  assert.doesNotMatch(r.err, /no image data was returned/);
});

test("openai adapter retries once when the server rejects response_format", async () => {
  const { server, port, seen } = await startServer("reject-rf");
  const outDir = mkdtempSync(path.join(os.tmpdir(), "img-"));
  const r = await runShell({
    port,
    env: { OPENAI_IMAGE_API_KEY: "sk-x", OPENAI_IMAGE_BASE_URL: `http://127.0.0.1:${port}/v1`, OPENAI_IMAGE_MODEL: "gpt-image-1" },
    input: { provider: "openai", prompt: "x", output_dir: outDir },
  });
  server.close();
  assert.equal(r.code, 0, r.err);
  assert.equal(seen.length, 2, "one rejected call, one retry");
  assert.ok(seen[0].response_format, "first attempt included response_format");
  assert.ok(!("response_format" in seen[1]), "retry dropped response_format");
  assert.equal(readdirSync(outDir).filter((f) => f.endsWith(".png")).length, 1, "image produced after retry");
});

test("missing key fails loudly, never silently", async () => {
  const outDir = mkdtempSync(path.join(os.tmpdir(), "img-"));
  const r = await runShell({
    env: { LILY_IMAGE_PROVIDER: "openai", OPENAI_IMAGE_API_KEY: "", OPENAI_IMAGE_BASE_URL: "" },
    input: { provider: "openai", prompt: "x", output_dir: outDir },
  });
  assert.notEqual(r.code, 0, "a keyless run must fail");
  assert.match(r.err, /image api key|API Key/i, "the error names the missing key");
});

test("media-provider settings maps the openai BYOK choice to adapter env", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "mps-"));
  process.env.LILY_USER_DATA_DIR = dir;
  const settings = require("../src/main/media-provider-settings.js");
  settings.setProviderKey("openai", { apiKey: "sk-live", baseUrl: "https://proxy.example.com/v1", imageModel: "dall-e-3" });
  settings.setModalityChoice("image", "own", "openai");
  const env = settings.getMediaProviderSpawnEnv();
  assert.equal(env.LILY_IMAGE_PROVIDER, "openai");
  assert.equal(env.OPENAI_IMAGE_API_KEY, "sk-live");
  assert.equal(env.OPENAI_IMAGE_BASE_URL, "https://proxy.example.com/v1");
  assert.equal(env.OPENAI_IMAGE_MODEL, "dall-e-3");
});
