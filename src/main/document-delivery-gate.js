"use strict";

const fs = require("node:fs");
const path = require("node:path");

const DOCUMENT_EXTENSIONS = new Set([
  ".doc",
  ".docx",
  ".xls",
  ".xlsx",
  ".ppt",
  ".pptx",
  ".pdf",
  ".odt",
  ".ods",
  ".odp",
  ".rtf",
]);
const OOXML_EXTENSIONS = new Set([".docx", ".xlsx", ".pptx"]);
const DOCUMENT_OPERATIONS = new Set(["create", "modify", "convert"]);
const MAX_DEEP_STRUCTURE_BYTES = 20 * 1024 * 1024;
const MAX_SCAN_CHARS = 64 * 1024;
const FORMULA_TASK_RE = /公式|重算|计算|财务模型|测算|formula|recalc|calculation|financial\s+model/i;
const RENDER_COMMAND_RE = /(?:render_document\.py|convert_pdf_to_images\.py|pdftoppm\b|soffice(?:\.py)?[^\n]{0,160}--convert-to\s+pdf)/i;
const RECALC_COMMAND_RE = /(?:recalc\.py|formula[^\n]{0,80}(?:recalc|recalculate))/i;
const IMAGE_INSPECTION_TOOL_RE = /(?:^|_)(?:read|view_image|vision|inspect_image|open_image)(?:$|_)/i;

function compactText(value, limit = MAX_SCAN_CHARS) {
  if (typeof value === "string") return value.slice(0, limit);
  try {
    return JSON.stringify(value ?? "").slice(0, limit);
  } catch {
    return "";
  }
}

function successfulTool(tool = {}) {
  if (/fail|error|cancel/i.test(String(tool.status || ""))) return false;
  const result = tool.result ?? tool.output;
  if (result && typeof result === "object") {
    if (result.ok === false || result.success === false) return false;
    const exitCode = Number(result.exitCode);
    if (Number.isFinite(exitCode) && exitCode !== 0) return false;
  }
  return true;
}

function toolText(tool = {}) {
  return `${compactText(tool.input)}\n${compactText(tool.result ?? tool.content ?? tool.output)}`;
}

function normalizedPath(value = "") {
  return String(value || "").replace(/\\\\/g, "\\").replace(/\\/g, "/").toLowerCase();
}

function artifactMentioned(text, artifact = {}) {
  const haystack = normalizedPath(text);
  const full = normalizedPath(artifact.path);
  const base = String(artifact.fileName || path.basename(artifact.path || "")).toLowerCase();
  return Boolean((full && haystack.includes(full)) || (base && haystack.includes(base)));
}

function collectImagePaths(value, output = new Set(), depth = 0) {
  if (depth > 8 || value == null || output.size >= 200) return output;
  if (typeof value === "string") {
    const source = value.replace(/\\\\/g, "\\").slice(0, MAX_SCAN_CHARS);
    const pattern = /((?:[A-Za-z]:[\\/]|\/|\.{1,2}[\\/])[^\s"'`<>|\]]+?\.(?:png|jpe?g|webp))/gi;
    for (const match of source.matchAll(pattern)) {
      output.add(normalizedPath(match[1]));
      if (output.size >= 200) break;
    }
    return output;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectImagePaths(item, output, depth + 1);
    return output;
  }
  if (typeof value === "object") {
    for (const item of Object.values(value)) collectImagePaths(item, output, depth + 1);
  }
  return output;
}

function parseRenderedPageCount(tool = {}, imagePaths = []) {
  const result = tool.result ?? tool.content ?? tool.output;
  if (result && typeof result === "object") {
    const pages = Number(result.pages ?? result.pageCount);
    if (Number.isFinite(pages) && pages > 0) return Math.floor(pages);
  }
  const text = compactText(result);
  const match = text.match(/["']?(?:pages|pageCount)["']?\s*[:=]\s*(\d+)/i);
  const parsed = Number(match?.[1] || 0);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : imagePaths.length;
}

function imagePathMatches(left = "", right = "") {
  const a = normalizedPath(left);
  const b = normalizedPath(right);
  if (!a || !b) return false;
  const bothAbsolute = /^(?:[a-z]:\/|\/)/i.test(a) && /^(?:[a-z]:\/|\/)/i.test(b);
  if (bothAbsolute) return a === b;
  return a === b || a.endsWith(`/${path.basename(b)}`) || b.endsWith(`/${path.basename(a)}`);
}

function readFileSlice(file, length, position = 0) {
  const fd = fs.openSync(file, "r");
  try {
    const buffer = Buffer.alloc(length);
    const bytesRead = fs.readSync(fd, buffer, 0, length, position);
    return buffer.subarray(0, bytesRead);
  } finally {
    fs.closeSync(fd);
  }
}

function visualCoverage(renderedImages = [], inspectedImages = [], pageCount = 0) {
  const rendered = [...new Set(renderedImages.map(normalizedPath).filter(Boolean))];
  const inspected = [...new Set(inspectedImages.map(normalizedPath).filter(Boolean))];
  const matched = rendered.filter((image) => inspected.some((seen) => imagePathMatches(image, seen)));
  const total = Math.max(pageCount, rendered.length);
  if (total <= 0) return { ok: inspected.length > 0, inspected: inspected.length, total };
  if (total <= 12) return { ok: matched.length >= total, inspected: matched.length, total };
  const firstSeen = rendered.length ? inspected.some((seen) => imagePathMatches(rendered[0], seen)) : inspected.length > 0;
  const lastSeen = rendered.length ? inspected.some((seen) => imagePathMatches(rendered.at(-1), seen)) : inspected.length > 1;
  const minimum = Math.min(6, total);
  return {
    ok: firstSeen && lastSeen && (rendered.length ? matched.length : inspected.length) >= minimum,
    inspected: rendered.length ? matched.length : inspected.length,
    total,
  };
}

function structureCheck(artifact = {}) {
  const file = String(artifact.path || "");
  if (!file) return { ok: false, reason: "missing_path" };
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    return { ok: false, reason: "missing_file" };
  }
  if (!stat.isFile() || stat.size <= 0) return { ok: false, reason: "empty_file" };
  const ext = String(artifact.ext || path.extname(file)).toLowerCase();
  try {
    const head = readFileSlice(file, Math.min(16, stat.size));
    if (OOXML_EXTENSIONS.has(ext) && !head.subarray(0, 2).equals(Buffer.from("PK"))) {
      return { ok: false, reason: "invalid_ooxml_header" };
    }
    if (ext === ".pdf" && !head.subarray(0, 4).equals(Buffer.from("%PDF"))) {
      return { ok: false, reason: "invalid_pdf_header" };
    }
    if (OOXML_EXTENSIONS.has(ext) && stat.size <= MAX_DEEP_STRUCTURE_BYTES) {
      const contents = fs.readFileSync(file);
      if (!contents.includes("[Content_Types].xml")) return { ok: false, reason: "missing_content_types" };
    }
    if (ext === ".pdf") {
      const tailSize = Math.min(1024, stat.size);
      const tail = readFileSlice(file, tailSize, stat.size - tailSize);
      if (!tail.includes("%%EOF")) return { ok: false, reason: "missing_pdf_eof" };
    }
  } catch {
    return { ok: false, reason: "structure_check_failed" };
  }
  return { ok: true, reason: "structure_valid" };
}

function documentArtifacts(artifacts = []) {
  return (Array.isArray(artifacts) ? artifacts : [])
    .filter((artifact) => DOCUMENT_EXTENSIONS.has(String(artifact?.ext || path.extname(artifact?.path || "")).toLowerCase()))
    .slice(0, 20);
}

function requiresDocumentDelivery(taskContract = null) {
  if (taskContract?.taskType !== "document_work") return false;
  const operation = taskContract?.semanticIntent?.operation || taskContract?.contentIntent?.operation || "unknown";
  const outputMode = taskContract?.semanticIntent?.outputMode || taskContract?.contentIntent?.outputMode || "unknown";
  return DOCUMENT_OPERATIONS.has(operation) || outputMode === "artifact";
}

function assessArtifact(artifact, tools, { requireRecalc = false } = {}) {
  const structure = structureCheck(artifact);
  const successful = tools.map((tool, index) => ({ tool, index })).filter(({ tool }) => successfulTool(tool));
  const renderEntry = successful.find(({ tool }) => {
    const text = toolText(tool);
    return RENDER_COMMAND_RE.test(text) && artifactMentioned(text, artifact);
  });
  const renderedImages = renderEntry ? [...collectImagePaths(renderEntry.tool.result ?? renderEntry.tool.output ?? "")] : [];
  const pageCount = renderEntry ? parseRenderedPageCount(renderEntry.tool, renderedImages) : 0;
  const inspectedImages = [];
  if (renderEntry) {
    for (const { tool, index } of successful) {
      if (index <= renderEntry.index || !IMAGE_INSPECTION_TOOL_RE.test(String(tool.name || ""))) continue;
      const inputImages = [...collectImagePaths(tool.input)];
      for (const image of inputImages) {
        if (!renderedImages.length || renderedImages.some((rendered) => imagePathMatches(rendered, image))) {
          inspectedImages.push(image);
        }
      }
    }
  }
  const visual = visualCoverage(renderedImages, inspectedImages, pageCount);
  const ext = String(artifact.ext || path.extname(artifact.path || "")).toLowerCase();
  const recalculated = ext !== ".xlsx" || !requireRecalc || successful.some(({ tool }) => {
    const text = toolText(tool);
    return RECALC_COMMAND_RE.test(text) && artifactMentioned(text, artifact);
  });
  const missing = [];
  if (!structure.ok) missing.push("structure");
  if (!renderEntry) missing.push("render");
  if (renderEntry && !visual.ok) missing.push("visual_inspection");
  if (!recalculated) missing.push("formula_recalculation");
  return {
    path: artifact.path,
    ext,
    ok: missing.length === 0,
    missing,
    checks: {
      structure,
      rendered: Boolean(renderEntry),
      pageCount,
      visual,
      recalculated,
    },
  };
}

function assessDocumentDelivery({ taskContract = null, artifacts = [], tools = [], userText = "" } = {}) {
  const required = requiresDocumentDelivery(taskContract);
  if (!required) return { required: false, ok: true, status: "not_required", artifacts: [], missing: [] };
  const documents = documentArtifacts(artifacts);
  if (!documents.length) {
    return {
      required: true,
      ok: false,
      status: "unverified",
      reason: "document_delivery_missing:output_file",
      artifacts: [],
      missing: ["output_file"],
      retryRecommended: false,
    };
  }
  const requireRecalc = FORMULA_TASK_RE.test(String(userText || ""));
  const results = documents.map((artifact) => assessArtifact(artifact, Array.isArray(tools) ? tools : [], { requireRecalc }));
  const missing = [...new Set(results.flatMap((item) => item.missing))];
  return {
    required: true,
    ok: missing.length === 0,
    status: missing.length ? "unverified" : "verified",
    reason: missing.length ? `document_delivery_missing:${missing.join(",")}` : "document_delivery_verified",
    artifacts: results,
    missing,
    retryRecommended: missing.length > 0,
  };
}

function withDocumentOutputEvidence(summary = null, artifacts = [], delivery = null) {
  const documents = documentArtifacts(artifacts);
  if (!documents.length) return summary;
  const current = summary && typeof summary === "object" ? summary : {};
  const verified = Boolean(delivery?.required && delivery?.ok);
  const existingVerifications = Number(current.counts?.verifications || 0);
  return {
    ...current,
    hasDocumentOutputEvidence: true,
    ...(verified ? { hasVerificationEvidence: true } : {}),
    counts: {
      ...(current.counts || {}),
      documentOutputs: documents.length,
      ...(verified ? { verifications: Math.max(existingVerifications, documents.length) } : {}),
    },
  };
}

function answerLanguage(value = "") {
  const text = String(value || "");
  if (/[\u3400-\u9fff]/u.test(text)) return "zh";
  if (/[\u0600-\u06ff]/u.test(text)) return "ar";
  return "en";
}

function safeDocumentDeliveryFallback({ assessment = null, userText = "" } = {}) {
  const language = answerLanguage(userText);
  const paths = (assessment?.artifacts || []).map((item) => item.path).filter(Boolean);
  const missing = (assessment?.missing || []).join(", ") || "verification";
  const pathText = paths.length ? `\n${paths.map((item) => `- ${item}`).join("\n")}` : "";
  const messages = {
    zh: paths.length
      ? `文档文件已经生成，但交付验证尚未通过（缺少：${missing}），因此当前不能标记为已验证成品。文件仍保留在：${pathText}`
      : "本轮尚未发现实际生成的办公文档或 PDF 输出文件，因此不能把任务标记为已交付。",
    ar: paths.length
      ? `تم إنشاء ملف المستند، لكن فحص التسليم لم يكتمل بعد (${missing})، لذلك لن أصفه بأنه مُتحقق منه. الملف محفوظ في:${pathText}`
      : "لم أعثر على ملف مستند أو PDF تم إنشاؤه فعليا في هذه الجولة، لذلك لا يمكن اعتبار المهمة مُسلّمة.",
    en: paths.length
      ? `The document file was created, but its delivery verification is incomplete (missing: ${missing}), so I cannot mark it as a verified deliverable yet. The file remains at:${pathText}`
      : "No generated Office or PDF output file was found in this turn, so I cannot mark the document task as delivered.",
  };
  return messages[language];
}

function buildDocumentDeliveryRecoveryPrompt(assessment = null, userText = "") {
  const paths = (assessment?.artifacts || []).map((item) => item.path).filter(Boolean);
  const language = answerLanguage(userText);
  const listed = paths.map((item) => `- ${item}`).join("\n");
  if (language === "zh") {
    return [
      "[系统文档交付续检] 这是对刚生成文件的一次内部续接，不是让你从头重做原任务。",
      "请继续完成当前文档的交付验收；保留原内容和原路径，只在看到确定的质量问题时修改源文件。",
      "待验文件：",
      listed,
      "必须完成：",
      "1. 用确定性库重新打开文件并确认结构有效；Excel 有公式时执行 recalc.py 并消除公式错误。",
      "2. 使用 Lily 的 render_document.py 将每个文件渲染为逐页图片。缺 LibreOffice 时走受管理 runtime pack；禁止临时 pip/npm/playwright install。",
      "3. 真正用图像读取工具查看渲染页：12 页以内逐页查看；更多页至少查看首页、末页和分布在全文的 6 页。",
      "4. 检查遮挡、溢出、截断、空白页、字体替换、表格/图表错位、图片缺失和页边距。只修复实际发现的问题，然后重新渲染受影响页。",
      "5. 最终直接交付同一文件，说明检查了什么、修了什么；仍无法验证的部分必须明确标为未验证。不要复述这段系统续检说明。",
    ].join("\n");
  }
  return [
    "[system document delivery continuation] This is an internal continuation for files just created, not a request to redo the original task from scratch.",
    "Finish delivery QA for the current documents. Preserve their content and paths; modify a source file only for a defect you actually observe.",
    "Artifacts to verify:",
    listed,
    "Required:",
    "1. Reopen each file with a deterministic library and confirm its structure. If an XLSX contains formulas, run recalc.py and resolve formula errors.",
    "2. Render every artifact to page images with Lily's render_document.py. If LibreOffice is missing, use the managed runtime-pack route; never run ad-hoc pip/npm/playwright install.",
    "3. Actually inspect rendered pages with an image-reading tool: inspect every page up to 12 pages; for longer files inspect the first, last, and at least 6 pages distributed through the document.",
    "4. Check clipping, overlap, overflow, blank pages, font fallback, table/chart alignment, missing images, and margins. Fix only confirmed defects, then re-render affected pages.",
    "5. Deliver the same artifact directly and state what was checked and fixed. Explicitly label anything still unverified. Do not repeat this internal continuation notice.",
  ].join("\n");
}

module.exports = {
  DOCUMENT_EXTENSIONS,
  assessDocumentDelivery,
  buildDocumentDeliveryRecoveryPrompt,
  documentArtifacts,
  requiresDocumentDelivery,
  safeDocumentDeliveryFallback,
  structureCheck,
  visualCoverage,
  withDocumentOutputEvidence,
};
