"use strict";

const path = require("node:path");

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".tif", ".tiff", ".heic", ".svg"]);
const PDF_EXTENSIONS = new Set([".pdf"]);
const DOCUMENT_EXTENSIONS = new Set([".doc", ".docx", ".odt", ".rtf", ".txt", ".md", ".html", ".xml"]);
const SPREADSHEET_EXTENSIONS = new Set([".xls", ".xlsx", ".xlsm", ".csv", ".tsv"]);
const PRESENTATION_EXTENSIONS = new Set([".ppt", ".pptx", ".odp"]);
const AUDIO_EXTENSIONS = new Set([".mp3", ".wav", ".m4a", ".aac", ".flac", ".ogg"]);
const VIDEO_EXTENSIONS = new Set([".mp4", ".mov", ".mkv", ".avi", ".webm"]);

const OPERATION_SIGNALS = Object.freeze({
  extract: [
    [/\b(?:ocr|read|extract|transcribe|recognize)\b|识别|读取|读出|提取|转文字|文字提取|抄录|转录/i, 5],
    [/翻译|translate/i, 3],
  ],
  understand: [
    [/分析|总结|概括|归纳|解释|说明|描述|审查|检查|对比|比较|问答|找出|看懂|summari[sz]e|analy[sz]e|explain|describe|review|inspect|compare/i, 4],
    [/是什么|有什么|讲了什么|里面.{0,8}(?:什么|内容)|看一下|看一看|看看|what(?:'s| is)|tell me|show me/i, 3],
  ],
  create: [
    [/生成|创建|制作|绘制|画一|设计一|generate|create|draw|make|design/i, 5],
  ],
  modify: [
    [/修改|编辑|修复|修正|修图|裁剪|去背景|背景移除|抠图|替换|增强|润色|改成|变成|edit|modify|fix|correct|crop|retouch|remove.{0,12}background|replace|enhance|turn.{0,12}into/i, 5],
  ],
  convert: [
    [/转成|转换成|转换为|导出为|另存为|convert|transcode|export.{0,12}as|save.{0,12}as/i, 6],
  ],
});

const SOURCE_ANCHOR_RE = /(?:这|这个|这张|这份|该|当前|刚上传|上传的|附件|文件里|图里|文档里|其中|里面).{0,16}(?:图片|图像|照片|截图|pdf|文档|文件|表格|幻灯片|视频|音频|内容)|(?:attached|uploaded|this|current)\s+(?:image|picture|photo|screenshot|pdf|document|file|spreadsheet|presentation|video|audio)/i;
const CONTENT_TARGET_RE = /内容|文字|文本|数据|表格|条款|字段|信息|画面|对象|页面|页码|text|content|data|table|clause|field|page/i;
const ENGINEERING_CONTEXT_RE = /模块|代码|接口|功能|系统|流程|算法|模型|能力|实现|开发|接入|重构|测试|module|code|api|feature|system|pipeline|algorithm|model|capability|implement|develop|refactor|test/i;
const COMMAND_RE = /帮我|请(?:你)?|给我|需要|直接|马上|现在|生成一|创建一|制作一|修改这|编辑这|把这|please|can you|i need|generate (?:a|an)|create (?:a|an)|edit this|convert this/i;
const INSTRUCTIONAL_RE = /怎么|如何|教程|方法|原理|能不能|是否可以|how to|guide|tutorial|what is the best way/i;

const MENTION_PATTERNS = Object.freeze({
  image: /图片|图像|照片|截图|产品图|海报|封面|image|picture|photo|screenshot|poster|cover/i,
  pdf: /\bpdf\b/i,
  document: /文档|合同|报告|简历|文件|word|docx|document|contract|report|resume/i,
  spreadsheet: /表格|工作簿|电子表格|excel|xlsx|csv|spreadsheet|workbook|worksheet/i,
  presentation: /幻灯片|演示文稿|pptx?|powerpoint|presentation|slides?/i,
  audio: /音频|语音|录音|audio|voice|recording/i,
  video: /视频|录像|video|movie|clip/i,
});

function unique(values = []) {
  return [...new Set(values.filter(Boolean))];
}

function sourceKindForFile(file = {}) {
  const input = file && typeof file === "object" ? file : {};
  const mime = String(input.mime || input.type || input.mimeType || "").toLowerCase();
  const name = String(input.name || input.path || input.fileName || "");
  const ext = path.extname(name).toLowerCase();
  if (IMAGE_EXTENSIONS.has(ext) || (input.isImage === true && mime !== "image/svg+xml") || /^image\/(?!svg)/.test(mime)) return "image";
  if (PDF_EXTENSIONS.has(ext) || mime === "application/pdf") return "pdf";
  if (SPREADSHEET_EXTENSIONS.has(ext)) return "spreadsheet";
  if (PRESENTATION_EXTENSIONS.has(ext)) return "presentation";
  if (DOCUMENT_EXTENSIONS.has(ext)) return "document";
  if (AUDIO_EXTENSIONS.has(ext) || /^audio\//.test(mime)) return "audio";
  if (VIDEO_EXTENSIONS.has(ext) || /^video\//.test(mime)) return "video";
  return "";
}

function attachmentKinds(files = []) {
  return unique((Array.isArray(files) ? files : []).map(sourceKindForFile));
}

function mentionedKinds(text = "") {
  const source = String(text || "");
  return Object.entries(MENTION_PATTERNS)
    .filter(([, pattern]) => pattern.test(source))
    .map(([kind]) => kind);
}

function operationScores(text = "") {
  const source = String(text || "");
  return Object.fromEntries(
    Object.entries(OPERATION_SIGNALS).map(([operation, signals]) => [
      operation,
      signals.reduce((score, [pattern, weight]) => score + (pattern.test(source) ? weight : 0), 0),
    ]),
  );
}

function selectOperation(scores, { hasAttachment = false, genericSourceQuestion = false } = {}) {
  if (scores.convert > 0) return "convert";
  if (scores.modify > 0) return "modify";
  if (scores.create > 0 && (scores.extract > 0 || scores.understand > 0)) return "create";
  if (scores.extract > 0) return "extract";
  if (scores.understand > 0) return "understand";
  if (scores.create > 0) return "create";
  if (hasAttachment || genericSourceQuestion) return "understand";
  return "unknown";
}

function inferTargetKinds(text = "", operation = "unknown") {
  if (!["create", "modify", "convert"].includes(operation)) return [];
  const source = String(text || "");
  const target = source.match(/(?:生成|创建|制作|绘制|画|改成|变成|转成|转换成|转换为|导出为|另存为|generate|create|make|draw|turn.{0,8}into|convert.{0,8}to|export.{0,8}as)(.{0,40})/i)?.[1] || source;
  return mentionedKinds(target);
}

function routeForIntent({ operation, sourceKinds, targetKinds, sourceAnchored, commandIntent, instructional }) {
  const kinds = new Set([...sourceKinds, ...targetKinds]);
  if (["extract", "understand"].includes(operation) && sourceKinds.length && sourceAnchored) {
    return "content_extraction";
  }
  if (!["create", "modify", "convert"].includes(operation)) return "";
  if (instructional && !sourceAnchored && !commandIntent) return "";
  if (!commandIntent && !sourceAnchored) return "";
  if (["image", "audio", "video"].some((kind) => kinds.has(kind))) return "media_generation";
  if (["pdf", "document", "spreadsheet", "presentation"].some((kind) => kinds.has(kind))) return "document_work";
  return "";
}

function inferContentTaskIntent({ text = "", files = [] } = {}) {
  const source = String(text || "").trim();
  const attached = attachmentKinds(files);
  const mentioned = mentionedKinds(source);
  const scores = operationScores(source);
  const genericSourceQuestion = Boolean(mentioned.length && /是什么|有什么|内容|里面|what|describe|tell me|show me/i.test(source));
  const operation = selectOperation(scores, { hasAttachment: attached.length > 0, genericSourceQuestion });
  const sourceKinds = unique(attached.length ? [...attached, ...mentioned] : mentioned);
  const targetKinds = inferTargetKinds(source, operation);
  const explicitAnchor = SOURCE_ANCHOR_RE.test(source) || CONTENT_TARGET_RE.test(source);
  const sourceAnchored = attached.length > 0 || explicitAnchor;
  const engineeringOnly = ENGINEERING_CONTEXT_RE.test(source) && !attached.length && !explicitAnchor;
  const commandIntent = COMMAND_RE.test(source);
  const instructional = INSTRUCTIONAL_RE.test(source);
  const routeTaskType = engineeringOnly
    ? ""
    : routeForIntent({ operation, sourceKinds, targetKinds, sourceAnchored, commandIntent, instructional });
  const outputMode = ["create", "modify", "convert"].includes(operation) && (routeTaskType || commandIntent)
    ? "artifact"
    : "answer";
  const reasonCodes = unique([
    attached.length ? "attachment_type" : "",
    mentioned.length ? "referenced_source_type" : "",
    scores[operation] > 0 ? `operation_${operation}` : "attachment_default_understanding",
    sourceAnchored ? "source_anchored" : "",
    engineeringOnly ? "engineering_context_preserved" : "",
  ]);
  const confidence = routeTaskType
    ? attached.length || (explicitAnchor && scores[operation] > 0) ? "high" : "medium"
    : "low";
  return {
    schemaVersion: 1,
    active: Boolean(routeTaskType),
    operation,
    sourceKinds,
    attachmentKinds: attached,
    targetKinds,
    outputMode,
    confidence,
    routeTaskType,
    reasonCodes,
  };
}

function extractExplicitNegativePhrases(text = "") {
  const source = String(text || "").trim();
  if (!source) return [];
  const tail = "[^，。；;.!?！？\\n]{0,80}";
  const patterns = [
    new RegExp(`(?:不要|无需|不需要|不用|禁止|不是|并非|切勿)\\s*${tail}`, "giu"),
    new RegExp(`(?:请别|千万别|(?:^|[\\s，。；;.!?！？]|你|您|也|就|先|再|都|可|但)别(?!的(?:\\s|$)|人|处|名|称|类|样|致))\\s*${tail}`, "gimu"),
    new RegExp(`\\b(?:do not|don't|dont|never|no need to|not)\\b\\s*${tail}`, "gi"),
  ];
  const found = [];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      const value = String(match[0] || "").replace(/^[\s，。；;.!?！？]+/u, "").trim();
      if (value && !found.includes(value)) found.push(value);
    }
  }
  return found;
}

module.exports = {
  attachmentKinds,
  extractExplicitNegativePhrases,
  inferContentTaskIntent,
  sourceKindForFile,
};
