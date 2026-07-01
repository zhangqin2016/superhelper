"use strict";

const path = require("node:path");

const { PACK_SPECS } = require("./runtime-pack-specs");

const OFFICE_EXTENSIONS = new Set([
  ".doc",
  ".docx",
  ".xls",
  ".xlsx",
  ".ppt",
  ".pptx",
  ".odt",
  ".ods",
  ".odp",
  ".rtf",
]);

const PDF_EXTENSIONS = new Set([".pdf"]);
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".bmp", ".tif", ".tiff", ".heic"]);
const MEDIA_EXTENSIONS = new Set([".mp3", ".wav", ".m4a", ".aac", ".flac", ".ogg", ".mp4", ".mov", ".mkv", ".avi", ".webm"]);

const OFFICE_PATTERNS = [
  /(?:word|excel|powerpoint|ppt|docx|xlsx|office|spreadsheet|worksheet|presentation)/i,
  /(?:文档|表格|电子表格|演示文稿|幻灯片|公式重算|打印|转\s*(?:word|excel|pdf|ppt)|导出\s*(?:word|excel|pdf|ppt))/i,
];

const PDF_PATTERNS = [
  /(?:pdf|large document|document layout|table extraction)/i,
  /(?:扫描件|扫描版|复杂\s*pdf|版面|表格结构|阅读顺序|长文档|大文件|大\s*pdf)/i,
];

const OCR_PATTERNS = [
  /(?:ocr|text recognition|recognize text|scanned image|screenshot text)/i,
  /(?:识别.*(?:图片|截图|文字|表格)|截图.*(?:文字|表格)|图片.*(?:文字|表格)|扫描识别|本地\s*ocr)/i,
];

const WEB_AUTOMATION_PATTERNS = [
  /(?:web automation|playwright|browser automation|learn (?:this )?(?:website|web system|oa|erp|crm)|operate (?:the )?(?:website|web system))/i,
  /(?:网页系统学习|学习.*(?:网站|网页|oa|erp|crm|后台|系统)|操作.*(?:网站|网页|oa|erp|crm|后台|系统)|网页登录|浏览器自动化|页面扫描|动作地图|playbook)/i,
];

const MEDIA_PROCESSING_PATTERNS = [
  /(?:ffmpeg|transcode|convert video|clip video|trim video|compress video|extract audio|merge audio|merge video)/i,
  /(?:(?:音频|视频).*(?:转码|转换|裁剪|压缩|合并|提取|封装)|剪视频|压缩视频|提取音频|本地.*(?:音频|视频))/i,
];

function textOf(value) {
  return typeof value === "string" ? value : "";
}

function hasAny(text, patterns) {
  const body = textOf(text);
  return patterns.some((pattern) => pattern.test(body));
}

function fileExt(file) {
  const name = textOf(file?.name) || textOf(file?.path);
  return path.extname(name).toLowerCase();
}

function collectFileFacts(files = []) {
  const facts = {
    hasOffice: false,
    hasPdf: false,
    hasImage: false,
    hasMedia: false,
  };

  for (const file of Array.isArray(files) ? files : []) {
    const ext = fileExt(file);
    facts.hasOffice ||= OFFICE_EXTENSIONS.has(ext);
    facts.hasPdf ||= PDF_EXTENSIONS.has(ext);
    facts.hasImage ||= Boolean(file?.isImage) || IMAGE_EXTENSIONS.has(ext);
    facts.hasMedia ||= MEDIA_EXTENSIONS.has(ext);
  }

  return facts;
}

function addPack(ids, id) {
  if (PACK_SPECS[id] && !ids.includes(id)) ids.push(id);
}

function inferRuntimePackIds(payload = {}) {
  const text = textOf(payload.text || payload.prompt || payload.message);
  const facts = collectFileFacts(payload.files || payload.attachments || []);
  const ids = [];

  if (facts.hasOffice || hasAny(text, OFFICE_PATTERNS)) {
    addPack(ids, "libreoffice");
  }

  if (facts.hasPdf || hasAny(text, PDF_PATTERNS)) {
    addPack(ids, "large-document");
    addPack(ids, "pro-pdf");
  }

  if (facts.hasPdf && hasAny(text, OCR_PATTERNS)) {
    addPack(ids, "rapidocr");
  }

  if ((facts.hasImage && hasAny(text, OCR_PATTERNS)) || hasAny(text, OCR_PATTERNS)) {
    addPack(ids, "rapidocr");
    addPack(ids, "opencv");
  }

  if (hasAny(text, WEB_AUTOMATION_PATTERNS)) {
    addPack(ids, "web-automation");
  }

  if (facts.hasMedia || hasAny(text, MEDIA_PROCESSING_PATTERNS)) {
    addPack(ids, "ffmpeg");
  }

  return ids;
}

function localizedFallbackLabel(id) {
  const spec = PACK_SPECS[id];
  if (!spec) return id;
  return spec.label || id;
}

function toMissingPack(id, catalogPack) {
  const spec = PACK_SPECS[id] || {};
  return {
    id,
    category: catalogPack?.category || spec.category || "other",
    label: catalogPack?.label || localizedFallbackLabel(id),
    description: catalogPack?.description || spec.description || "",
    sizeEstimate: catalogPack?.sizeEstimate || spec.sizeEstimate || "",
  };
}

function preflightRuntimePacks(payload = {}) {
  const requiredPackIds = inferRuntimePackIds(payload);
  if (!requiredPackIds.length) {
    return { ok: true, requiredPackIds, missingPackIds: [], missingPacks: [] };
  }

  const { installedRuntimePackIds, listRuntimePacks } = require("./runtime-pack-installer");
  const installed = installedRuntimePackIds();
  const missingPackIds = requiredPackIds.filter((id) => !installed.has(id));
  if (!missingPackIds.length) {
    return { ok: true, requiredPackIds, missingPackIds: [], missingPacks: [] };
  }

  const catalog = listRuntimePacks();
  const packsById = new Map((catalog?.packs || []).map((pack) => [pack.id, pack]));
  return {
    ok: true,
    requiredPackIds,
    missingPackIds,
    missingPacks: missingPackIds.map((id) => toMissingPack(id, packsById.get(id))),
  };
}

module.exports = {
  inferRuntimePackIds,
  preflightRuntimePacks,
};
