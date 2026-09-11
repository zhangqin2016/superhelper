// Verifies the codex-relay image path: the skill drives /chat/completions,
// pulls the data:image markdown the relay streams back, and saves a real file —
// so a ChatGPT/Codex account (the same token the user chats with) can generate
// images without a separate REST endpoint or API key.
//   1. adapter streams the request, extracts the data-URI, writes a file
//   2. it fails loudly (never silently) when the model returns no image
//   3. media-provider settings maps the BYOK choice to the exact env vars the
//      adapter reads (CODEX_RELAY_API_KEY / BASE_URL / MODEL)
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
const SHELL = path.resolve("resources/skills/lily-image-generation/scripts/generate-image.cjs");

// mode "image": stream a chat chunk whose delta.content is a data:image markdown,
// split across two writes to mimic the real giant-line-across-TCP-chunks case.
// mode "noimage": stream only plain text so the adapter must fail loudly.
function startRelay(mode) {
  const seen = [];
  const server = http.createServer((req, res) => {
    let b = "";
    req.on("data", (c) => { b += c; });
    req.on("end", () => {
      if (!req.url.includes("/chat/completions")) { res.writeHead(404); res.end("{}"); return; }
      seen.push(JSON.parse(b || "{}"));
      res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8" });
      const chunk = (delta) => `data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`;
      if (mode === "noimage") {
        res.write(chunk({ role: "assistant" }));
        res.write(chunk({ content: "I cannot generate that." }));
      } else {
        res.write(chunk({ role: "assistant" }));
        const md = `\n\n![a test image](data:image/png;base64,${TINY})\n`;
        res.write(chunk({ content: md }));
      }
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port, seen })));
}

function runShell({ port, env = {}, input }) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SHELL], { env: { ...process.env, LILY_LOCALE: "en", ...env } });
    let out = "", err = "";
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { err += d; });
    child.on("close", (code) => resolve({ code, out, err }));
    child.stdin.end(JSON.stringify(input));
  });
}

test("codex-relay adapter saves the streamed data:image", async () => {
  const { server, port, seen } = await startRelay("image");
  const outDir = mkdtempSync(path.join(os.tmpdir(), "cr-"));
  const r = await runShell({
    port,
    env: { CODEX_RELAY_API_KEY: "cr_test", CODEX_RELAY_BASE_URL: `http://127.0.0.1:${port}/codex/v1`, CODEX_RELAY_IMAGE_MODEL: "gpt-6-astra:high" },
    input: { provider: "codex-relay", prompt: "a red circle", output_dir: outDir },
  });
  server.close();
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /generated_media type="image"/);
  assert.equal(seen[0].model, "gpt-6-astra", "tier suffix stripped from the model id");
  assert.equal(seen[0].stream, true, "request is streamed (non-stream 502s behind nginx)");
  const pngs = readdirSync(outDir).filter((f) => f.endsWith(".png"));
  assert.equal(pngs.length, 1, "one image file written");
  assert.ok(statSync(path.join(outDir, pngs[0])).size > 0, "image file is non-empty");
});

test("codex-relay adapter fails loudly when no image is returned", async () => {
  const { server, port } = await startRelay("noimage");
  const outDir = mkdtempSync(path.join(os.tmpdir(), "cr-"));
  const r = await runShell({
    port,
    env: { CODEX_RELAY_API_KEY: "cr_test", CODEX_RELAY_BASE_URL: `http://127.0.0.1:${port}/codex/v1` },
    input: { provider: "codex-relay", prompt: "x", output_dir: outDir },
  });
  server.close();
  assert.notEqual(r.code, 0, "a run with no image must fail");
  assert.match(r.err, /no image|图片/i, "the error explains no image came back");
});

test("missing relay config fails loudly", async () => {
  const outDir = mkdtempSync(path.join(os.tmpdir(), "cr-"));
  const r = await runShell({
    env: { LILY_IMAGE_PROVIDER: "codex-relay", CODEX_RELAY_API_KEY: "", CODEX_RELAY_BASE_URL: "" },
    input: { provider: "codex-relay", prompt: "x", output_dir: outDir },
  });
  assert.notEqual(r.code, 0, "keyless/urlless run must fail");
  assert.match(r.err, /relay|中转/i, "the error names the relay config");
});

test("media-provider settings maps the codex-relay BYOK choice to adapter env", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "mps-"));
  process.env.LILY_USER_DATA_DIR = dir;
  const settings = require("../src/main/media-provider-settings.js");
  settings.setProviderKey("codex-relay", { apiKey: "cr_live", baseUrl: "https://host/codex/v1", imageModel: "gpt-6-astra" });
  settings.setModalityChoice("image", "own", "codex-relay");
  const env = settings.getMediaProviderSpawnEnv();
  assert.equal(env.LILY_IMAGE_PROVIDER, "codex-relay");
  assert.equal(env.CODEX_RELAY_API_KEY, "cr_live");
  assert.equal(env.CODEX_RELAY_BASE_URL, "https://host/codex/v1");
  assert.equal(env.CODEX_RELAY_IMAGE_MODEL, "gpt-6-astra");
});
