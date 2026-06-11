#!/usr/bin/env node
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const require = createRequire(import.meta.url);

const renderer = await import(path.join(ROOT, "src/renderer/modules/tool-preview-label.js"));
const main = require(path.join(ROOT, "src/main/tool-preview-label.cjs"));

for (const mod of [renderer, main]) {
  const { buildToolPreviewLabel, looksLikeJsonPreview } = mod;

  assert.equal(
    buildToolPreviewLabel({
      name: "Task",
      input: {
        subject: "分析 safar-web 证据上传实现（参照）",
        description: "找到 safar-web 中证据上传的完整前端代码，梳理表单字段与接口",
      },
    }),
    "分析 safar-web 证据上传实现（参照）",
  );

  assert.equal(
    buildToolPreviewLabel({
      name: "TodoWrite",
      input: { taskId: "1", status: "in_progress" },
    }),
    "#1 · in_progress",
  );

  assert.equal(
    buildToolPreviewLabel({
      name: "TodoWrite",
      input: {
        todos: [
          { content: "对比 safar-web 上传组件", status: "in_progress" },
          { content: "迁移到 safar-public-web", status: "pending" },
        ],
      },
    }),
    "对比 safar-web 上传组件 (+1)",
  );

  assert.equal(
    buildToolPreviewLabel({
      name: "Task",
      input: {
        preview: '{"subject":"hidden"}',
        subject: "应优先 subject",
      },
    }),
    "应优先 subject",
  );

  // Media commands must show a localized human label, never the raw Bash
  // line. Renderer resolves via the i18n table (raw key under plain node);
  // the main mirror reads the app locale with an English fallback.
  const mediaCases = [
    ['echo \'{"prompt":"画一张图"}\' | node /x/resources/skills/lily-image-generation/scripts/generate-image.cjs', /生成图片|Generate image|toolPreview\.generateImage/],
    ["node /x/lily-video-generation/scripts/generate-video.cjs", /生成视频|Generate video|toolPreview\.generateVideo/],
    ["node /x/generate-speech.cjs", /生成语音|Generate speech|toolPreview\.generateSpeech/],
  ];
  for (const [command, pattern] of mediaCases) {
    const label = buildToolPreviewLabel({ name: "Bash", input: { command } });
    assert.ok(pattern.test(label), `media label expected, got: ${label}`);
    assert.ok(!label.startsWith("Bash "), `media command must not fall through to raw Bash: ${label}`);
  }

  assert.ok(looksLikeJsonPreview('{"a":1}'));
  assert.ok(!looksLikeJsonPreview("Read src/a.js"));
}

console.log("tool-preview-label: ok");
