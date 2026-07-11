"use strict";

const path = require("node:path");

const { PACK_SPECS } = require("./runtime-pack-specs");
const { planCapabilityReadiness } = require("./capability-readiness");

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

const OFFICE_STARTER_PACK_IDS = [
  "libreoffice",
  "large-document",
  "pro-pdf",
  "rapidocr",
  "opencv",
];

const SKILL_RUNTIME_PACKS = {
  "lily-office-intent": OFFICE_STARTER_PACK_IDS,
  "lily-pdf-extraction-router": ["large-document", "pro-pdf", "rapidocr", "opencv"],
  "lily-excel-data-analysis": ["libreoffice", "large-document"],
  "lily-ppt-design-qa": ["libreoffice"],
  "anthropics-docx": ["libreoffice"],
  "anthropics-pdf": ["large-document", "pro-pdf", "rapidocr", "opencv"],
  "anthropics-pptx": ["libreoffice"],
  "anthropics-xlsx": ["libreoffice", "large-document"],
  "anthropics-doc-coauthoring": ["libreoffice"],
  "lily-template-fill": ["libreoffice"],
  "lily-document-verify": ["libreoffice"],
  "lily-document-query": ["large-document", "pro-pdf", "rapidocr", "opencv"],
  "lily-pdf-form": ["large-document", "pro-pdf"],
  "lily-web-system-learning": ["web-automation"],
  "lily-browser-qa": ["web-automation"],
  "lily-video-generation": ["ffmpeg"],
};

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

function collectSkillIds(payload = {}) {
  const ids = [];
  const append = (value) => {
    if (typeof value === "string" && value.trim()) ids.push(value.trim());
  };
  for (const key of ["skillIds", "enabledSkillIds", "sessionSkillIds"]) {
    for (const id of Array.isArray(payload[key]) ? payload[key] : []) append(id);
  }
  return [...new Set(ids)];
}

function addSkillRuntimePacks(ids, skillIds = []) {
  for (const skillId of skillIds) {
    const packIds = SKILL_RUNTIME_PACKS[skillId] || [];
    for (const packId of packIds) addPack(ids, packId);
  }
}

function planRuntimePacks(payload = {}) {
  const text = textOf(payload.text || payload.prompt || payload.message);
  const facts = collectFileFacts(payload.files || payload.attachments || []);
  const planned = planCapabilityReadiness({
    text,
    files: payload.files || payload.attachments || [],
  });
  const requiredPackIds = [...planned.requiredPackIds];
  const enhancementPackIds = [...planned.enhancementPackIds];

  for (const id of Array.isArray(payload.requiredPackIds) ? payload.requiredPackIds : []) {
    addPack(requiredPackIds, id);
  }

  addSkillRuntimePacks(requiredPackIds, collectSkillIds(payload));

  if (facts.hasOffice || hasAny(text, OFFICE_PATTERNS)) {
    addPack(requiredPackIds, "libreoffice");
  }

  if ((facts.hasPdf || hasAny(text, PDF_PATTERNS)) && !planned.capabilityIds.includes("pdf-read")) {
    addPack(enhancementPackIds, "large-document");
    addPack(enhancementPackIds, "pro-pdf");
  }

  if (facts.hasPdf && hasAny(text, OCR_PATTERNS)) {
    addPack(requiredPackIds, "rapidocr");
  }

  if ((facts.hasImage && hasAny(text, OCR_PATTERNS)) || hasAny(text, OCR_PATTERNS)) {
    addPack(requiredPackIds, "rapidocr");
    addPack(requiredPackIds, "opencv");
  }

  if (hasAny(text, WEB_AUTOMATION_PATTERNS)) {
    addPack(requiredPackIds, "web-automation");
  }

  if (facts.hasMedia || hasAny(text, MEDIA_PROCESSING_PATTERNS)) {
    addPack(requiredPackIds, "ffmpeg");
  }

  return {
    capabilityIds: planned.capabilityIds,
    requiredPackIds: [...new Set(requiredPackIds)],
    enhancementPackIds: [...new Set(enhancementPackIds.filter((id) => !requiredPackIds.includes(id)))],
    fallbackCapabilityIds: planned.fallbackCapabilityIds,
  };
}

function inferRuntimePackIds(payload = {}) {
  const plan = planRuntimePacks(payload);
  return [...new Set([...plan.requiredPackIds, ...plan.enhancementPackIds])];
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

function emptyPreflight(requiredPackIds = []) {
  return {
    ok: true,
    blocking: false,
    requiredPackIds,
    missingPackIds: [],
    missingPacks: [],
    installingPackIds: [],
    installingPacks: [],
    agentAdvisory: "",
  };
}

function packListText(packs = []) {
  return (Array.isArray(packs) ? packs : [])
    .map((pack) => pack?.id)
    .filter(Boolean)
    .join(", ");
}

function buildRuntimePackAdvisory(preflight = {}) {
  const missingPacks = Array.isArray(preflight.missingPacks) ? preflight.missingPacks : [];
  const installingPacks = Array.isArray(preflight.installingPacks) ? preflight.installingPacks : [];
  if (!missingPacks.length && !installingPacks.length) return "";

  const missing = packListText(missingPacks);
  const installing = packListText(installingPacks);
  return [
    "Dependency capability advisory",
    "Do not block the user turn for dependency installation. Continue the task and choose the best route yourself.",
    missing ? `Missing dependency pack(s): ${missing}.` : "",
    installing ? `Dependency pack(s) already installing: ${installing}. If needed, observe progress before retrying that capability.` : "",
    "When a pack is truly needed, prefer Lily's runtime_pack_list/runtime_pack_install tools if available. Otherwise read the lily-runtime-packs guide and run its scripts/manage_runtime_pack.py script; do not invoke OpenCode native `skill <id>` for platform catalog skills. Run long installs through lily_process_jobs so progress stays observable.",
    "If installation fails, no artifact exists, or the pack is unnecessary for the specific answer, use built-in file intelligence, bundled Python/Node tools, system tools, direct source inspection, or another safe fallback. Do not ask the user to manually install dependencies unless every Lily-managed route failed.",
  ].filter(Boolean).join("\n");
}

function preflightRuntimePacks(payload = {}) {
  const plan = planRuntimePacks(payload);
  const requiredPackIds = plan.requiredPackIds;
  if (!requiredPackIds.length) {
    return emptyPreflight(requiredPackIds);
  }

  const {
    installedRuntimePackIds,
    installingRuntimePackIds,
    listRuntimePacks,
  } = require("./runtime-pack-installer");
  const installed = installedRuntimePackIds();
  const installing = installingRuntimePackIds();
  const pendingPackIds = requiredPackIds.filter((id) => !installed.has(id));
  const installingPackIds = pendingPackIds.filter((id) => installing.has(id));
  const missingPackIds = pendingPackIds.filter((id) => !installing.has(id));
  if (!missingPackIds.length && !installingPackIds.length) {
    return emptyPreflight(requiredPackIds);
  }

  const catalog = listRuntimePacks();
  const packsById = new Map((catalog?.packs || []).map((pack) => [pack.id, pack]));
  const result = {
    ok: true,
    blocking: false,
    requiredPackIds,
    enhancementPackIds: plan.enhancementPackIds,
    missingPackIds,
    missingPacks: missingPackIds.map((id) => toMissingPack(id, packsById.get(id))),
    installingPackIds,
    installingPacks: installingPackIds.map((id) => toMissingPack(id, packsById.get(id))),
  };
  return {
    ...result,
    agentAdvisory: buildRuntimePackAdvisory(result),
  };
}

module.exports = {
  buildRuntimePackAdvisory,
  inferRuntimePackIds,
  planRuntimePacks,
  preflightRuntimePacks,
  collectSkillIds,
};
