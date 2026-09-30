"use strict";

const script = require("../shared/script.mjs");

const fileKinds = require("../shared/file-kinds.mjs");

const fs = require("node:fs");
const path = require("node:path");
const { visionInspectionPaths } = require("./vision-inspection-receipt.js");
const { inspectedByContent, renderReceiptFor, inspectedImages: receiptInspectedImages } = require("./document-render-receipt.js");
const { workbookRecalculation, xlsxFormulaState } = require("./workbook-recalc-receipt.js");

const DOCUMENT_EXTENSIONS = new Set([...fileKinds.EXTENSIONS.pathOnlyDocument, ...fileKinds.EXTENSIONS.textDocument]);
const OOXML_EXTENSIONS = new Set([...fileKinds.EXTENSIONS.ooxml]);
const DOCUMENT_OPERATIONS = new Set(["create", "modify", "convert"]);
const MAX_DEEP_STRUCTURE_BYTES = 20 * 1024 * 1024;
const MAX_SCAN_CHARS = 64 * 1024;
const RENDER_COMMAND_RE = /(?:render_document\.py|convert_pdf_to_images\.py|pdftoppm\b|soffice(?:\.py)?[^\n]{0,160}--convert-to\s+pdf)/i;
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
  // NFC: macOS file names arrive decomposed from some tools, composed from others.
  return String(value || "").normalize("NFC").replace(/\\\\/g, "\\").replace(/\\/g, "/").toLowerCase();
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
    const pattern = new RegExp(String.raw`((?:[A-Za-z]:[\\/]|\/|\.{1,2}[\\/])[^\s"'\`<>|\]]+?\.(?:${fileKinds.alternation(fileKinds.EXTENSIONS.visionRaster)}))`, "gi");
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

function textReadable(file) {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(fs.readFileSync(file));
    if (text.includes("\uFFFD")) return { ok: false, reason: "replacement_characters" };
    if (!text.trim()) return { ok: false, reason: "empty_text" };
    return { ok: true, reason: "utf8_text_readable" };
  } catch {
    return { ok: false, reason: "invalid_utf8" };
  }
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

// The render receipt carries render_document.py's schema check of the same,
// unchanged file. A header-level check passes any zip that names
// [Content_Types].xml; Word refuses a package whose markup puts one vocabulary's
// element where the schema does not allow it (2026-09-29: 238 DrawingML fonts in
// w:rPr — LibreOffice rendered it, Word would not open it). Not judged → no change.
function withPackageConformance(structure, receipt) {
  const pkg = receipt?.package;
  if (!structure.ok || !pkg || pkg.checked !== true || !(Number(pkg.count) > 0)) return structure;
  return {
    ok: false,
    reason: "ooxml_schema_violation",
    count: Number(pkg.count),
    violations: (Array.isArray(pkg.violations) ? pkg.violations : []).slice(0, 5),
  };
}

// Whether an .xlsx contains formula cells: read from the file (workbook-recalc-receipt).
function xlsxContainsFormulas(file) {
  return xlsxFormulaState(file).formulas > 0;
}

function documentArtifacts(artifacts = []) {
  return (Array.isArray(artifacts) ? artifacts : [])
    .filter((artifact) => DOCUMENT_EXTENSIONS.has(String(artifact?.ext || path.extname(artifact?.path || "")).toLowerCase()))
    .slice(0, 20);
}

function requiresDocumentDelivery(taskContract = null, artifacts = []) {
  // Output provenance survives short follow-ups whose intent is "general".
  // Merely citing/reading an existing document must not start delivery QA.
  if (documentArtifacts(artifacts).some((artifact) => artifact.display !== "compact"
    && String(artifact.source || "").split(",").some((source) =>
      ["file_change", "tool_write", "tool_output", "inherited_delivery"].includes(source)))) return true;
  if (taskContract?.taskType !== "document_work") return false;
  const operation = taskContract?.semanticIntent?.operation || taskContract?.contentIntent?.operation || "unknown";
  const outputMode = taskContract?.semanticIntent?.outputMode || taskContract?.contentIntent?.outputMode || "unknown";
  return DOCUMENT_OPERATIONS.has(operation) || outputMode === "artifact";
}

// The host ledgers' entries for this turn: `inspections` (vision, [{ path, at }]),
// `renders` ([{ source, receipt, at }]), `recalcs` ([{ sha256, at }]).
function assessArtifact(artifact, tools, { inspections = [], renders = [], recalcs = [], detail = false } = {}) {
  let structure = structureCheck(artifact);
  if (fileKinds.EXTENSIONS.textDocument.has(String(artifact.ext || path.extname(artifact.path || "")).toLowerCase())) {
    // Text delivery has no page rendering. What the gate can certify about text
    // it checks itself: the file decodes as UTF-8 with no replacement
    // characters and has content. Whether what it SAYS holds is the evidence
    // gate's job. (This used to report content_verification missing whatever
    // the turn did, so every Markdown delivery ended "not fully checked".)
    const readable = structure.ok ? textReadable(artifact.path) : { ok: false, reason: structure.reason };
    return {
      path: artifact.path, ext: artifact.ext || path.extname(artifact.path || ""),
      ok: readable.ok, missing: readable.ok ? [] : ["structure"],
      checks: { structure: readable.ok ? structure : readable, rendered: false, pageCount: 0, visual: { applicable: false }, recalculated: false },
    };
  }
  const successful = tools.map((tool, index) => ({ tool, index })).filter(({ tool }) => successfulTool(tool));
  const renderEntry = successful.find(({ tool }) => {
    const text = toolText(tool);
    return RENDER_COMMAND_RE.test(text) && artifactMentioned(text, artifact);
  });
  // The platform's render receipt proves the render whatever the calling
  // script printed; its page list is what vision receipts are matched against.
  const ledgerImages = inspections.map((entry) => entry.path);
  const receipt = renderReceiptFor(String(artifact.path || ""), successful.map(({ tool }) => tool), ledgerImages, renders);
  structure = withPackageConformance(structure, receipt);
  const renderedImages = receipt ? receipt.images
    : renderEntry ? [...collectImagePaths(renderEntry.tool.result ?? renderEntry.tool.output ?? "")] : [];
  const pageCount = receipt ? receipt.pages : renderEntry ? parseRenderedPageCount(renderEntry.tool, renderedImages) : 0;
  const inspectedImages = [];
  if (receipt) {
    // A re-render overwrites the same page files: an inspection recorded before
    // this render looked at the previous pages.
    const freshLedger = inspections.filter((entry) => !receipt.renderedAtMs || entry.at >= receipt.renderedAtMs).map((entry) => entry.path);
    const seen = receiptInspectedImages(successful.map(({ tool }) => tool), freshLedger);
    for (const image of seen) {
      if (renderedImages.some((rendered) => imagePathMatches(rendered, image))) inspectedImages.push(image);
    }
    // A page byte-identical to one inspected in ANOTHER render this turn (a PDF
    // export beside its .docx) was inspected too. Within one render every page
    // is still looked at: repeated identical pages do not vouch for each other.
    const unseen = renderedImages.filter((rendered) => !inspectedImages.some((image) => imagePathMatches(rendered, image)));
    const elsewhere = seen.filter((image) => !renderedImages.some((rendered) => imagePathMatches(rendered, image)));
    if (unseen.length && elsewhere.length) inspectedImages.push(...inspectedByContent(unseen, elsewhere));
  } else if (renderEntry) {
    for (const { tool, index } of successful) {
      if (index <= renderEntry.index) continue;
      for (const image of visionInspectionPaths(tool)) {
        if (renderedImages.some((rendered) => imagePathMatches(rendered, image))) inspectedImages.push(image);
      }
      if (IMAGE_INSPECTION_TOOL_RE.test(String(tool.name || ""))) {
        for (const image of [...collectImagePaths(tool.input)]) {
          if (!renderedImages.length || renderedImages.some((rendered) => imagePathMatches(rendered, image))) {
            inspectedImages.push(image);
          }
        }
        continue;
      }
    }
    // A ledger inspection counts from the render on, as a printed one does.
    const renderedAt = Number(renderEntry.tool.startedAt || renderEntry.tool.endedAt) || 0;
    for (const entry of inspections) {
      if (entry.at >= renderedAt && renderedImages.some((rendered) => imagePathMatches(rendered, entry.path))) inspectedImages.push(entry.path);
    }
  }
  const visual = visualCoverage(renderedImages, inspectedImages, pageCount);
  const ext = String(artifact.ext || path.extname(artifact.path || "")).toLowerCase();
  // Recalc is judged from the workbook itself and the recalculating script's
  // receipt — never from keywords in (possibly internal) prompt or command text.
  const recalculation = ext === ".xlsx"
    ? workbookRecalculation(String(artifact.path || ""), { receipts: recalcs, commands: successful.map(({ tool }) => toolText(tool)), mentions: (text) => artifactMentioned(text, artifact) })
    : { needed: false, ok: true };
  const recalculated = recalculation.ok;
  const missing = [];
  if (!structure.ok) missing.push("structure");
  const rendered = Boolean(receipt || renderEntry);
  if (!rendered) missing.push("render");
  if (rendered && !visual.ok) missing.push("visual_inspection");
  if (!recalculated) missing.push("formula_recalculation");
  return {
    path: artifact.path,
    ext,
    ok: missing.length === 0,
    missing,
    checks: {
      structure,
      rendered,
      pageCount,
      visual,
      recalculated,
      ...(recalculation.needed ? { recalculation } : {}),
      // Page by page, for the agent's own check (lily_delivery_check); not stored with the turn.
      ...(detail ? { uninspectedPages: renderedImages.filter((page) => !inspectedImages.some((seen) => imagePathMatches(page, seen))) } : {}),
    },
  };
}

function assessDocumentDelivery({ taskContract = null, artifacts = [], tools = [], userText = "", visionInspections = [], renderReceipts = [], recalcReceipts = [], detail = false } = {}) {
  const required = requiresDocumentDelivery(taskContract, artifacts);
  if (!required) return { required: false, ok: true, status: "not_required", artifacts: [], missing: [] };
  const documents = documentArtifacts(artifacts).filter((artifact) =>
    requiresDocumentDelivery(taskContract) || requiresDocumentDelivery(null, [artifact]));
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
  const inspections = Array.isArray(visionInspections) ? visionInspections : [];
  const evidence = {
    inspections,
    renders: Array.isArray(renderReceipts) ? renderReceipts : [],
    recalcs: Array.isArray(recalcReceipts) ? recalcReceipts : [],
    detail: detail === true,
  };
  const results = documents.map((artifact) => assessArtifact(artifact, Array.isArray(tools) ? tools : [], evidence));
  const missing = [...new Set(results.flatMap((item) => item.missing))];
  return {
    required: true,
    ok: missing.length === 0,
    status: missing.length ? "unverified" : "verified",
    reason: missing.length ? `document_delivery_missing:${missing.join(",")}` : "document_delivery_verified",
    artifacts: results,
    missing,
    retryRecommended: missing.some((item) => item !== "content_verification"),
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

const answerLanguage = script.answerLanguage;

// Missing-check identifiers are internal — users get plain-language labels.
const MISSING_LABELS = {
  zh: { output_file: "输出文件", structure: "结构校验", render: "页面渲染", visual_inspection: "视觉检查", formula_recalculation: "公式重算" },
  en: { output_file: "output file", structure: "structure check", render: "page rendering", visual_inspection: "visual inspection", formula_recalculation: "formula recalculation" },
  ar: { output_file: "ملف الإخراج", structure: "فحص البنية", render: "عرض الصفحات", visual_inspection: "الفحص المرئي", formula_recalculation: "إعادة حساب الصيغ" },
};

function missingLabels(missing = [], language = "en") {
  const labels = { ...(MISSING_LABELS[language] || MISSING_LABELS.en), content_verification: { zh: "内容核验", en: "content verification", ar: "التحقق من المحتوى" }[language] || "content verification" };
  const separator = language === "zh" ? "、" : ", ";
  return (Array.isArray(missing) ? missing : []).map((item) => labels[item] || item).join(separator);
}

function safeDocumentDeliveryFallback({ assessment = null, userText = "" } = {}) {
  const language = answerLanguage(userText);
  const paths = (assessment?.artifacts || []).map((item) => item.path).filter(Boolean);
  const missing = missingLabels(assessment?.missing || [], language) || (language === "zh" ? "验证" : "verification");
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

module.exports = {
  DOCUMENT_EXTENSIONS,
  assessDocumentDelivery,
  documentArtifacts,
  missingLabels,
  requiresDocumentDelivery,
  safeDocumentDeliveryFallback,
  structureCheck,
  visualCoverage,
  withDocumentOutputEvidence,
  xlsxContainsFormulas,
};
