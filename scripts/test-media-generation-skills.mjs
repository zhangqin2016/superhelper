#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

function runNode(script, input, env, cwd) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script], {
      cwd,
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(JSON.stringify(input));
  });
}

function readJson(req) {
  return new Promise((resolve) => {
    let raw = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => resolve(raw ? JSON.parse(raw) : {}));
  });
}

async function startMockServer() {
  const seen = { image: 0, video: 0, speech: 0 };
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    if (req.method === "POST" && url.pathname.endsWith("/multimodal-generation/generation")) {
      const body = await readJson(req);
      seen.image += 1;
      assert.equal(body.model, "qwen-image-2.0-pro");
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          output: {
            choices: [
              {
                message: {
                  content: [{ image: `${base}/media/generated.png` }],
                },
              },
            ],
          },
        }),
      );
      return;
    }
    if (req.method === "POST" && url.pathname.endsWith("/video-synthesis")) {
      const body = await readJson(req);
      seen.video += 1;
      assert.equal(body.model, "wan2.7-t2v");
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ output: { task_id: "video-task" } }));
      return;
    }
    if (req.method === "GET" && url.pathname.endsWith("/tasks/video-task")) {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ output: { task_status: "SUCCEEDED", video_url: `${base}/media/generated.mp4` } }));
      return;
    }
    if (req.method === "POST" && url.pathname.endsWith("/SpeechSynthesizer")) {
      const body = await readJson(req);
      seen.speech += 1;
      assert.equal(body.model, "cosyvoice-v3-flash");
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ output: { audio: { url: `${base}/media/generated.wav` } } }));
      return;
    }
    if (req.method === "GET" && url.pathname === "/media/generated.png") {
      res.setHeader("Content-Type", "image/png");
      res.end(Buffer.from("mock-png"));
      return;
    }
    if (req.method === "GET" && url.pathname === "/media/generated.mp4") {
      res.setHeader("Content-Type", "video/mp4");
      res.end(Buffer.from("mock-mp4"));
      return;
    }
    if (req.method === "GET" && url.pathname === "/media/generated.wav") {
      res.setHeader("Content-Type", "audio/wav");
      res.end(Buffer.from("mock-wav"));
      return;
    }
    res.statusCode = 404;
    res.end("not found");
  });

  let base = "";
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  base = `http://${address.address}:${address.port}`;
  return { server, base, seen };
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lily-media-skills-"));
const scripts = {
  image: path.join(ROOT, "resources/skills/lily-image-generation/scripts/generate-image.cjs"),
  video: path.join(ROOT, "resources/skills/lily-video-generation/scripts/generate-video.cjs"),
  speech: path.join(ROOT, "resources/skills/lily-speech-generation/scripts/generate-speech.cjs"),
};

const missingKey = await runNode(scripts.image, { prompt: "test" }, { DASHSCOPE_API_KEY: "" }, tmp);
assert.notEqual(missingKey.code, 0);
assert.match(missingKey.stderr, /DASHSCOPE_API_KEY/);

const { server, base, seen } = await startMockServer();
try {
  const env = {
    DASHSCOPE_API_KEY: "test-key",
    DASHSCOPE_BASE_URL: base,
    LILY_MEDIA_POLL_INTERVAL_MS: "50",
  };
  const image = await runNode(scripts.image, { prompt: "一张莲花图", size: "1328*1328" }, env, tmp);
  assert.equal(image.code, 0, image.stderr);
  assert.match(image.stdout, /generated_media type="image"/);
  assert.match(image.stdout, /generated-assets\/image-/);

  const video = await runNode(scripts.video, { prompt: "一段莲花盛开视频", timeout_ms: 5000 }, env, tmp);
  assert.equal(video.code, 0, video.stderr);
  assert.match(video.stdout, /generated_media type="video"/);
  assert.match(video.stdout, /generated-assets\/video-/);

  const speech = await runNode(scripts.speech, { text: "你好，欢迎使用 Lily Workbench" }, env, tmp);
  assert.equal(speech.code, 0, speech.stderr);
  assert.match(speech.stdout, /generated_media type="speech"/);
  assert.match(speech.stdout, /generated-assets\/speech-/);

  const aliyunAlias = await runNode(
    scripts.speech,
    { text: "百炼别名密钥测试", output_dir: "alias-assets" },
    { DASHSCOPE_API_KEY: "", DASHSCOPE_BASE_URL: base, ALIYUN_BAILIAN_API_KEY: "test-key" },
    tmp,
  );
  assert.equal(aliyunAlias.code, 0, aliyunAlias.stderr);
  assert.match(aliyunAlias.stdout, /alias-assets\/speech-/);

  assert.equal(seen.image, 1);
  assert.equal(seen.video, 1);
  assert.equal(seen.speech, 2);
  assert.equal(fs.readdirSync(path.join(tmp, "generated-assets")).length, 3);
} finally {
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log("media-generation-skills: ok");
