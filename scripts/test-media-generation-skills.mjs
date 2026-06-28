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

function generatedFilePaths(stdout) {
  return [...String(stdout || "").matchAll(/<file\b[^>]*\bpath="([^"]+)"/g)].map((match) => match[1]);
}

function assertGeneratedPath(stdout, expectedDirName) {
  const [filePath] = generatedFilePaths(stdout);
  assert.ok(filePath, `missing generated file path in stdout: ${stdout}`);
  assert.ok(path.isAbsolute(filePath), `generated file path must be absolute: ${filePath}`);
  const expectedRoot = fs.realpathSync(path.join(tmp, expectedDirName));
  const generatedDir = fs.realpathSync(path.dirname(filePath));
  assert.ok(
    generatedDir === expectedRoot,
    `generated file path should stay under ${expectedDirName}: ${filePath}`,
  );
  // Containment is verified above via realpath; the format assertions match on
  // POSIX separators, so normalize the absolute path before returning it.
  return filePath.split(path.sep).join("/");
}

function countGeneratedMediaFiles(outputs) {
  return outputs.reduce((total, output) => total + generatedFilePaths(output.stdout).length, 0);
}

async function startMockServer() {
  const seen = {
    image: 0, video: 0, speech: 0, volcImage: 0, volcVideo: 0,
    klingImage: 0, klingVideo: 0, mmImage: 0, mmVideo: 0, zhipuImage: 0, zhipuVideo: 0,
  };
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    // Kling (可灵) — async create + poll, JWT bearer. Hosted under /kling.
    if (req.method === "POST" && url.pathname === "/kling/v1/images/generations") {
      const body = await readJson(req);
      seen.klingImage += 1;
      assert.match(req.headers.authorization || "", /^Bearer .+\..+\..+$/, "kling must send a JWT bearer");
      assert.equal(body.model_name, "kling-v1-5");
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ code: 0, data: { task_id: "kling-img" } }));
      return;
    }
    if (req.method === "GET" && url.pathname === "/kling/v1/images/generations/kling-img") {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ code: 0, data: { task_status: "succeed", task_result: { images: [{ url: `${base}/media/generated.png` }] } } }));
      return;
    }
    if (req.method === "POST" && url.pathname === "/kling/v1/videos/text2video") {
      const body = await readJson(req);
      seen.klingVideo += 1;
      assert.equal(body.model_name, "kling-v1-6");
      assert.equal(body.duration, "5", "kling duration must be a string");
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ code: 0, data: { task_id: "kling-vid" } }));
      return;
    }
    if (req.method === "GET" && url.pathname === "/kling/v1/videos/text2video/kling-vid") {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ code: 0, data: { task_status: "succeed", task_result: { videos: [{ url: `${base}/media/generated.mp4` }] } } }));
      return;
    }
    // MiniMax (海螺) — image sync, video async 3-step. Hosted under /minimax.
    if (req.method === "POST" && url.pathname === "/minimax/v1/image_generation") {
      const body = await readJson(req);
      seen.mmImage += 1;
      assert.equal(body.model, "image-01");
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ data: { image_urls: [`${base}/media/generated.png`] }, base_resp: { status_code: 0 } }));
      return;
    }
    if (req.method === "POST" && url.pathname === "/minimax/v1/video_generation") {
      seen.mmVideo += 1;
      assert.equal(url.searchParams.get("GroupId"), "grp-1", "minimax must carry GroupId");
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ task_id: "mm-vid", base_resp: { status_code: 0 } }));
      return;
    }
    if (req.method === "GET" && url.pathname === "/minimax/v1/query/video_generation") {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ status: "Success", file_id: "mm-file", base_resp: { status_code: 0 } }));
      return;
    }
    if (req.method === "GET" && url.pathname === "/minimax/v1/files/retrieve") {
      assert.equal(url.searchParams.get("file_id"), "mm-file");
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ file: { download_url: `${base}/media/generated.mp4` }, base_resp: { status_code: 0 } }));
      return;
    }
    // Zhipu (智谱) — image sync, video async 2-step. Hosted under /zhipu.
    if (req.method === "POST" && url.pathname === "/zhipu/images/generations") {
      const body = await readJson(req);
      seen.zhipuImage += 1;
      assert.equal(body.model, "cogview-4-250304");
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ data: [{ url: `${base}/media/generated.png` }] }));
      return;
    }
    if (req.method === "POST" && url.pathname === "/zhipu/videos/generations") {
      const body = await readJson(req);
      seen.zhipuVideo += 1;
      assert.equal(body.model, "cogvideox-3");
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ id: "zhipu-vid", task_status: "PROCESSING" }));
      return;
    }
    if (req.method === "GET" && url.pathname === "/zhipu/async-result/zhipu-vid") {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ task_status: "SUCCESS", video_result: [{ url: `${base}/media/generated.mp4` }] }));
      return;
    }
    // Volcengine Ark (Seedream image — synchronous). Hosted at root.
    if (req.method === "POST" && url.pathname === "/images/generations") {
      const body = await readJson(req);
      seen.volcImage += 1;
      assert.equal(req.headers.authorization, "Bearer volc-key");
      assert.equal(body.model, "doubao-seedream-4-0-250828");
      assert.equal(body.response_format, "url");
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ data: [{ url: `${base}/media/generated.png` }] }));
      return;
    }
    // Volcengine Ark (Seedance video — async create + poll).
    if (req.method === "POST" && url.pathname.endsWith("/contents/generations/tasks")) {
      const body = await readJson(req);
      seen.volcVideo += 1;
      assert.equal(req.headers.authorization, "Bearer volc-key");
      assert.ok(Array.isArray(body.content), "seedance body.content must be an array");
      assert.match(body.content[0].text, /--resolution 720p/);
      assert.match(body.content[0].text, /--duration 5/);
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ id: "seedance-task" }));
      return;
    }
    if (req.method === "GET" && url.pathname.endsWith("/contents/generations/tasks/seedance-task")) {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ id: "seedance-task", status: "succeeded", content: { video_url: `${base}/media/generated.mp4` } }));
      return;
    }
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
    LILY_LOCALE: "zh-CN",
    DASHSCOPE_API_KEY: "test-key",
    DASHSCOPE_BASE_URL: `${base}/apps/anthropic`,
    DASHSCOPE_IMAGE_BASE_URL: base,
    DASHSCOPE_VIDEO_BASE_URL: base,
    DASHSCOPE_TTS_BASE_URL: base,
    LILY_MEDIA_POLL_INTERVAL_MS: "50",
  };
  const image = await runNode(scripts.image, { prompt: "一张莲花图", size: "1328*1328" }, env, tmp);
  assert.equal(image.code, 0, image.stderr);
  assert.match(image.stdout, /generated_media type="image"/);
  assert.match(assertGeneratedPath(image.stdout, "generated-assets"), /generated-assets\/image-/);
  assert.match(image.stdout, /!\[生成图片\]\(/);
  assert.match(image.stderr, /正在提交图片生成任务/);

  const video = await runNode(scripts.video, { prompt: "一段莲花盛开视频", timeout_ms: 5000 }, env, tmp);
  assert.equal(video.code, 0, video.stderr);
  assert.match(video.stdout, /generated_media type="video"/);
  assert.match(assertGeneratedPath(video.stdout, "generated-assets"), /generated-assets\/video-/);

  const speech = await runNode(scripts.speech, { text: "你好，欢迎使用 Lily Workbench" }, env, tmp);
  assert.equal(speech.code, 0, speech.stderr);
  assert.match(speech.stdout, /generated_media type="speech"/);
  assert.match(assertGeneratedPath(speech.stdout, "generated-assets"), /generated-assets\/speech-/);

  const aliyunAlias = await runNode(
    scripts.speech,
    { text: "百炼别名密钥测试", output_dir: "alias-assets" },
    {
      DASHSCOPE_API_KEY: "",
      DASHSCOPE_BASE_URL: `${base}/apps/anthropic`,
      DASHSCOPE_TTS_BASE_URL: base,
      ALIYUN_BAILIAN_API_KEY: "test-key",
    },
    tmp,
  );
  assert.equal(aliyunAlias.code, 0, aliyunAlias.stderr);
  assert.match(assertGeneratedPath(aliyunAlias.stdout, "alias-assets"), /alias-assets\/speech-/);

  // Volcengine Ark provider: image selected via input.provider, video via the
  // LILY_VIDEO_PROVIDER env — both dispatch paths exercised.
  const volcEnv = {
    LILY_LOCALE: "zh-CN",
    VOLCENGINE_API_KEY: "volc-key",
    VOLCENGINE_IMAGE_BASE_URL: base,
    VOLCENGINE_VIDEO_BASE_URL: base,
    LILY_MEDIA_POLL_INTERVAL_MS: "50",
  };
  const volcImage = await runNode(scripts.image, { prompt: "霓虹星云里的柯基宇航员", provider: "volcengine" }, volcEnv, tmp);
  assert.equal(volcImage.code, 0, volcImage.stderr);
  assert.match(volcImage.stdout, /generated_media type="image"/);
  assert.match(assertGeneratedPath(volcImage.stdout, "generated-assets"), /generated-assets\/image-/);

  const volcVideo = await runNode(
    scripts.video,
    { prompt: "雪山日出航拍", timeout_ms: 5000 },
    { ...volcEnv, LILY_VIDEO_PROVIDER: "volcengine" },
    tmp,
  );
  assert.equal(volcVideo.code, 0, volcVideo.stderr);
  assert.match(volcVideo.stdout, /generated_media type="video"/);
  assert.match(assertGeneratedPath(volcVideo.stdout, "generated-assets"), /generated-assets\/video-/);

  // Unknown provider must fail loud, not silently fall back.
  const badProvider = await runNode(scripts.image, { prompt: "x", provider: "nope" }, volcEnv, tmp);
  assert.notEqual(badProvider.code, 0);
  assert.match(badProvider.stderr, /provider/i);

  // Kling (可灵): direct mode signs a JWT locally from AccessKey + SecretKey.
  const klingEnv = { LILY_LOCALE: "zh-CN", KLING_BASE_URL: `${base}/kling`, KLING_ACCESS_KEY: "ak", KLING_SECRET_KEY: "sk", LILY_MEDIA_POLL_INTERVAL_MS: "50" };
  const klingImage = await runNode(scripts.image, { prompt: "雪山日出", provider: "kling" }, klingEnv, tmp);
  assert.equal(klingImage.code, 0, klingImage.stderr);
  assert.match(assertGeneratedPath(klingImage.stdout, "generated-assets"), /generated-assets\/image-/);
  const klingVideo = await runNode(scripts.video, { prompt: "海浪", provider: "kling", timeout_ms: 5000 }, klingEnv, tmp);
  assert.equal(klingVideo.code, 0, klingVideo.stderr);
  assert.match(assertGeneratedPath(klingVideo.stdout, "generated-assets"), /generated-assets\/video-/);

  // MiniMax (海螺): GroupId must be carried through create/query/retrieve.
  const mmEnv = { LILY_LOCALE: "zh-CN", MINIMAX_BASE_URL: `${base}/minimax`, MINIMAX_API_KEY: "mm-key", MINIMAX_GROUP_ID: "grp-1", LILY_MEDIA_POLL_INTERVAL_MS: "50" };
  const mmImage = await runNode(scripts.image, { prompt: "一只猫", provider: "minimax" }, mmEnv, tmp);
  assert.equal(mmImage.code, 0, mmImage.stderr);
  assert.match(assertGeneratedPath(mmImage.stdout, "generated-assets"), /generated-assets\/image-/);
  const mmVideo = await runNode(scripts.video, { prompt: "无人机舞蹈", provider: "minimax", timeout_ms: 5000 }, mmEnv, tmp);
  assert.equal(mmVideo.code, 0, mmVideo.stderr);
  assert.match(assertGeneratedPath(mmVideo.stdout, "generated-assets"), /generated-assets\/video-/);

  // Zhipu (智谱): image sync, video async 2-step.
  const zhipuEnv = { LILY_LOCALE: "zh-CN", ZHIPU_BASE_URL: `${base}/zhipu`, ZHIPU_API_KEY: "zhipu-key", LILY_MEDIA_POLL_INTERVAL_MS: "50" };
  const zhipuImage = await runNode(scripts.image, { prompt: "星空狐狸", provider: "zhipu" }, zhipuEnv, tmp);
  assert.equal(zhipuImage.code, 0, zhipuImage.stderr);
  assert.match(assertGeneratedPath(zhipuImage.stdout, "generated-assets"), /generated-assets\/image-/);
  const zhipuVideo = await runNode(scripts.video, { prompt: "夕阳礁石", provider: "zhipu", timeout_ms: 5000 }, zhipuEnv, tmp);
  assert.equal(zhipuVideo.code, 0, zhipuVideo.stderr);
  assert.match(assertGeneratedPath(zhipuVideo.stdout, "generated-assets"), /generated-assets\/video-/);

  assert.equal(seen.image, 1);
  assert.equal(seen.video, 1);
  assert.equal(seen.speech, 2);
  assert.equal(seen.volcImage, 1);
  assert.equal(seen.volcVideo, 1);
  assert.equal(seen.klingImage, 1);
  assert.equal(seen.klingVideo, 1);
  assert.equal(seen.mmImage, 1);
  assert.equal(seen.mmVideo, 1);
  assert.equal(seen.zhipuImage, 1);
  assert.equal(seen.zhipuVideo, 1);
  assert.equal(countGeneratedMediaFiles([
    image, video, speech,
    volcImage, volcVideo,
    klingImage, klingVideo,
    mmImage, mmVideo,
    zhipuImage, zhipuVideo,
  ]), 11);
} finally {
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log("media-generation-skills: ok");
