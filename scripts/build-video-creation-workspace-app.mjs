#!/usr/bin/env node
// Build the "视频创作" (Video Creation) Lily workspace-app package for the app
// store. It carries NO heavy binary — ffmpeg + a CJK subtitle font are fetched on
// first use by files/scripts/setup-ffmpeg.cjs, so the main installer stays lean and
// only users who install this app download them. The actual film pipeline lives in
// the required skills (lily-video-generation's generate-film.cjs et al.).
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import JSZip from "jszip";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_OUT_DIR = path.join(ROOT, "dist", "workspace-apps");
const APP_ID = "video-creation";
const APP_NAME = "视频创作";
const REQUIRED_SKILLS = ["lily-video-generation", "lily-image-generation", "lily-speech-generation"];

function parseArgs(argv) {
  const args = { outDir: DEFAULT_OUT_DIR, version: "1.0.0", exportedAt: new Date().toISOString() };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--out" || arg === "--out-dir") args.outDir = path.resolve(argv[++i] || "");
    else if (arg === "--version") args.version = argv[++i] || "";
    else if (arg === "--exported-at") args.exportedAt = argv[++i] || "";
    else if (arg === "--help" || arg === "-h") args.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return args;
}

function usage() {
  return [
    "Usage: node scripts/build-video-creation-workspace-app.mjs [--out dist/workspace-apps] [--version 1.0.0] [--exported-at ISO]",
    "",
    "Builds the Lily 视频创作 workspace app package (director → storyboard → finished film).",
  ].join(os.EOL);
}

function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function readme() {
  return `# Lily App: 视频创作

把一段文案/剧本变成一条**带配音、字幕、配乐的完整成片**。你当导演,Lily 把它
拆成分镜、逐镜生成画面(依赖即梦/Seedance、可灵、万相等 AI 视频接口)、配音、
并用 ffmpeg 合成为一个 mp4。

## 适合怎么用

\`\`\`text
把这章小说做成 30 秒竖屏宣传片,仙侠水墨风,带旁白和字幕
用这段产品文案做一条 16:9 的介绍视频,主角形象保持一致
\`\`\`

## 工作流(导演 → 成片)

1. **首次使用先装 ffmpeg**:运行 \`files/scripts/setup-ffmpeg.cjs\`,它会按你的系统
   解析/下载 ffmpeg 与中文字幕字体,并打印路径。
2. **导演**:把文案拆成 storyboard(每镜:画风、角色、关键帧、镜头提示词、旁白)。
3. **成片**:把 storyboard 交给视频技能的成片脚本(generate-film.cjs),传入
   \`FFMPEG_BIN\` / \`SUBTITLE_FONT\`(来自第 1 步),产出最终 mp4。

## 画质与一致性

- 画面质量取决于所选 AI 视频接口(即梦/可灵/万相…),在「设置 → 图片视频」选默认。
- 跨镜一致性靠**关键帧锚定**:先出一张角色/画风关键帧,逐镜用图生视频(首帧)生成。
- 视频模型**画不准字幕文字**,字幕由成片阶段烧录,不要写进画面提示词。

## 依赖

- 必需技能:\`${REQUIRED_SKILLS.join("`、`")}\`。
- ffmpeg + 中文字体:由本应用首次运行时按平台获取(不进主安装包)。
`;
}

function agentsMd() {
  return `# Lily 视频创作 App

You are the **film director** inside Lily's Video Creation app. Turn the user's
文案/script into ONE finished film, not loose clips.

## Required skills

Use \`${REQUIRED_SKILLS.join("`, `")}\`. The finished-film producer is
\`lily-video-generation\`'s \`generate-film.cjs\`.

## Pipeline (always)

1. **Ensure ffmpeg (first run)** — run the app's setup once and capture the paths:
   \`\`\`bash
   node files/scripts/setup-ffmpeg.cjs
   \`\`\`
   It prints JSON \`{ "ffmpeg": "<path|ffmpeg>", "font": "<path|>" }\`. Pass these as
   \`FFMPEG_BIN\` and \`SUBTITLE_FONT\` env when running the film producer.
2. **Direct → storyboard** — translate the 文案 into a storyboard JSON. Write
   \`style\` and \`character\` ONCE (vividly); they are reused on every shot. One shot
   = one ~5–10s beat; set \`duration\` to fit its \`narration\`. Add a \`keyframe\` per
   shot to lock the look (image-to-video). Never put on-screen text in prompts.
3. **Produce the film** — hand the storyboard to this app's producer:
   \`\`\`bash
   FFMPEG_BIN=<from step 1> SUBTITLE_FONT=<from step 1> \\
     echo '<storyboard json>' | node files/scripts/generate-film.cjs
   \`\`\`
   The producer (an app file) generates each shot, the voice-over, burns subtitles,
   stitches + mixes music, and returns the final mp4. It auto-finds the installed
   image/video/speech skills via \`LILY_USER_DATA_DIR\` — you only pass FFMPEG_BIN /
   SUBTITLE_FONT. Reply with the film path and a preview.

## Rules

- The video models cap visual quality; your leverage is direction, consistency,
  and post (subtitles/music) — make the prompts concrete and filmable.
- On any failure the producer reports the error and lists the per-shot clips it
  already made — surface those so work is never lost.
- Keep API keys out of chat, files, and artifacts; the platform injects them.
`;
}

// App-owned scripts live as real source files under resources/workspace-apps/
// video-creation/scripts and are bundled verbatim into the package. Heavy film
// orchestration (generate-film.cjs) and ffmpeg provisioning (setup-ffmpeg.cjs)
// belong to the APP, not the skill — the skill stays single-clip and lightweight.
const APP_SRC = path.join(ROOT, "resources", "workspace-apps", "video-creation");
function readAppFile(rel) {
  return fs.readFileSync(path.join(APP_SRC, rel), "utf8");
}

function conventionsMd() {
  return [
    "# 视频创作约定",
    "",
    "- 成片前先运行 setup-ffmpeg.cjs 取得 ffmpeg/字体路径,作为 FFMPEG_BIN/SUBTITLE_FONT 传给成片脚本。",
    "- 当导演:文案先拆 storyboard,style+character 写一次全程复用;一镜一事件。",
    "- 字幕由成片阶段烧录,不要写进视频画面提示词(模型画不准文字)。",
    "- 失败时保留已生成的分镜片段并告知用户,绝不交付损坏成片。",
    "",
  ].join("\n");
}

async function build(args) {
  if (!args.version) throw new Error("--version is required");
  if (!args.outDir) throw new Error("--out is required");
  const exportedAt = new Date(args.exportedAt);
  if (Number.isNaN(exportedAt.getTime())) throw new Error("--exported-at must be a valid ISO date");

  const files = new Map([
    ["README.md", readme()],
    ["AGENTS.md", agentsMd()],
    ["scripts/setup-ffmpeg.cjs", readAppFile("scripts/setup-ffmpeg.cjs")],
    ["scripts/generate-film.cjs", readAppFile("scripts/generate-film.cjs")],
  ]);

  const manifest = {
    schemaVersion: 1,
    kind: "lily-workspace-app",
    appId: APP_ID,
    name: APP_NAME,
    folderName: APP_ID,
    description:
      "把文案/剧本做成带配音、字幕、配乐的完整成片:导演拆分镜 → 逐镜 AI 生成(即梦/可灵/万相等)→ ffmpeg 合成。ffmpeg 按需下载,不进主安装包。",
    exportedAt: exportedAt.toISOString(),
    fileCount: files.size,
    hasConventions: true,
    requiredSkills: REQUIRED_SKILLS,
    requiredRuntimePacks: [],
  };

  const zip = new JSZip();
  zip.file("lily-workspace.json", `${JSON.stringify(manifest, null, 2)}\n`);
  zip.file("conventions.md", conventionsMd());
  for (const [relPath, content] of files) {
    zip.file(`files/${relPath}`, content.endsWith("\n") ? content : `${content}\n`);
  }

  const buffer = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
  fs.mkdirSync(args.outDir, { recursive: true });
  const fileName = `${APP_ID}-${args.version}.lilyspace.zip`;
  const outPath = path.join(args.outDir, fileName);
  fs.writeFileSync(outPath, buffer);

  return {
    appId: APP_ID, name: APP_NAME, version: args.version, path: outPath, fileName,
    sizeBytes: buffer.length, sha256: sha256(buffer), requiredSkills: REQUIRED_SKILLS,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { console.log(usage()); return; }
  const result = await build(args);
  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exit(1);
});
