"use strict";

const fs = require("node:fs");
const path = require("node:path");

const FILE_MIME = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
  ".svg": "image/svg+xml",
  ".pdf": "application/pdf",
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xls": "application/vnd.ms-excel",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".ppt": "application/vnd.ms-powerpoint",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".json": "application/json",
  ".csv": "text/csv",
};

const DEFAULT_MAX_INLINE_FILE_BYTES =
  Number(process.env.LILY_OPENCODE_MAX_INLINE_FILE_BYTES) || 8 * 1024 * 1024;
const DEFAULT_MAX_TEXT_ATTACHMENT_CHARS =
  Number(process.env.LILY_OPENCODE_MAX_TEXT_ATTACHMENT_CHARS) || 80_000;

// `.svg` is an IMAGE mime but text content, so it has always been inlined as
// text rather than sent as an image file part.
const TEXT_ATTACHMENT_EXTENSIONS = new Set([".svg"]);

// Text-like structured/data/markup files. These used to be sent as raw file
// parts (mime application/json etc.), which breaks every model whose provider
// adapter only accepts image file parts (deepseek, most custom/BYOK) — the AI
// SDK throws AI_UnsupportedFunctionalityError while building the request, before
// it ever reaches the gateway. They are TEXT, so we inline them as fenced text
// (bounded by the size/char limits — oversized ones fall through to a source
// path). Text is understood by every model, so nothing is lost and no provider
// can reject it.
const STRUCTURED_TEXT_EXTENSIONS = new Set([
  ".json", ".geojson", ".ndjson", ".jsonl",
  ".xml", ".xhtml", ".html", ".htm",
  ".yaml", ".yml", ".toml", ".ini",
  ".csv", ".tsv", ".txt", ".md", ".log",
]);

function isInlineTextExtension(ext) {
  return TEXT_ATTACHMENT_EXTENSIONS.has(ext) || STRUCTURED_TEXT_EXTENSIONS.has(ext);
}
const RASTER_IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"]);
const PATH_ONLY_DOCUMENT_EXTENSIONS = new Set([
  ".pdf",
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

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return "unknown size";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function buildSkippedAttachmentNote(skipped = []) {
  if (!skipped.length) return "";
  const lines = skipped.map((item) => {
    const size = Number.isFinite(item.size) ? `, ${formatBytes(item.size)}` : "";
    const name = item.filename || path.basename(item.path || "") || "attachment";
    const source = item.path ? ` (source path: ${item.path})` : "";
    return `- ${name}${source}${size}: ${item.reason}`;
  });
  return [
    "[Attachment note]",
    "Some local files were not inlined into the OpenCode request to keep the desktop app responsive and avoid sending raw attachment bytes to the model service.",
    ...lines,
    "If document extraction succeeded, use the extracted text above. Otherwise use the source path with available file tools instead of asking the user to re-upload.",
  ].join("\n");
}

function buildAttachmentIndex(files = []) {
  const list = (Array.isArray(files) ? files : []).filter(Boolean);
  if (!list.length) return "";
  const lines = list.slice(0, 20).map((file, index) => {
    const filePath = file.path || file.filePath || "";
    const name = file.name || file.filename || path.basename(filePath) || `attachment-${index + 1}`;
    let stat = null;
    if (filePath) {
      try {
        stat = fs.statSync(filePath);
      } catch {
        stat = null;
      }
    }
    return [
      `- ${name}`,
      filePath ? `  source path: ${filePath}` : "  source path: unavailable",
      file.sourcePath && file.sourcePath !== filePath ? `  original path: ${file.sourcePath}` : "",
      typeof file.isImage === "boolean" ? `  image: ${file.isImage ? "yes" : "no"}` : "",
      stat?.isFile?.() ? `  size: ${formatBytes(stat.size)}` : "",
      filePath ? `  readable now: ${stat?.isFile?.() ? "yes" : "no"}` : "",
    ].filter(Boolean).join("\n");
  });
  const omitted = list.length > 20 ? `\n\n${list.length - 20} more attachment(s) omitted from this index.` : "";
  return [
    "[Attachment index]",
    "Use these exact local source paths when a task requires inspecting or editing an attached file. Do not search the workspace by filename unless the listed source path is missing or unreadable.",
    ...lines,
    omitted,
  ].filter(Boolean).join("\n");
}

function truncateAttachmentText(text, limit = DEFAULT_MAX_TEXT_ATTACHMENT_CHARS) {
  const value = String(text || "");
  if (value.length <= limit) return value;
  return `${value.slice(0, limit)}\n\n[Attachment text truncated, original length: ${value.length} characters]`;
}

function textFenceForExtension(ext) {
  switch (ext) {
    case ".svg":
    case ".xml":
    case ".xhtml":
      return "xml";
    case ".html":
    case ".htm":
      return "html";
    case ".json":
    case ".geojson":
    case ".ndjson":
    case ".jsonl":
      return "json";
    case ".yaml":
    case ".yml":
      return "yaml";
    case ".toml":
      return "toml";
    case ".ini":
      return "ini";
    case ".csv":
      return "csv";
    case ".md":
      return "markdown";
    default:
      return "";
  }
}

function fileExtension(file = {}, filePath = "") {
  const pathExt = path.extname(filePath || "").toLowerCase();
  if (pathExt) return pathExt;
  return path.extname(file.name || file.filename || "").toLowerCase();
}

function documentMimeLike(value = "") {
  const mime = String(value || "").toLowerCase();
  return Boolean(mime) && (
    mime === "application/pdf" ||
    mime.includes("officedocument") ||
    mime.includes("msword") ||
    mime.includes("vnd.ms-") ||
    mime.includes("wordprocessingml") ||
    mime.includes("spreadsheetml") ||
    mime.includes("presentationml") ||
    mime.includes("opendocument") ||
    mime === "application/rtf" ||
    mime === "text/rtf"
  );
}

function isPathOnlyDocumentAttachment(file = {}, filePath = "") {
  const ext = fileExtension(file, filePath);
  if (PATH_ONLY_DOCUMENT_EXTENSIONS.has(ext)) return true;
  return documentMimeLike(file.mime || file.type || file.mimeType || file.mediaType || "");
}

function imageMimeLike(value = "") {
  const mime = String(value || "").toLowerCase();
  return mime.startsWith("image/") && mime !== "image/svg+xml";
}

function isRasterImageAttachment(file = {}, filePath = "", mime = "") {
  const ext = fileExtension(file, filePath);
  if (RASTER_IMAGE_EXTENSIONS.has(ext)) return true;
  return imageMimeLike(mime || file.mime || file.type || file.mimeType || file.mediaType || "");
}

// Whether the ACTIVE model is declared to accept this mime as a raw file part.
// There is NO universal allow-list: a hardcoded list (the old behavior) sent
// e.g. application/json file parts to every model, but only image file parts are
// broadly supported — deepseek and most custom/BYOK providers reject anything
// else and the engine's AI SDK throws AI_UnsupportedFunctionalityError while
// BUILDING the request (before the gateway, so nothing server-side can rescue
// it). Images are gated separately by `allowImageFileParts`; this covers the
// non-image case and defaults to DENY. A preset opts specific types in via
// `capabilities.filePartMimes` → threaded here as `allowedFilePartMimes`.
// Everything denied here still reaches the model as inline text or a source path
// (see isInlineTextExtension / the skipped-attachment note), so no content is
// lost — it just takes a universally-supported shape.
function filePartMimeAllowed(mime, opts = {}) {
  const value = String(mime || "").toLowerCase();
  if (!value) return false;
  // Images are governed by allowImageFileParts (the raster-image check runs
  // before this gate); reaching here with an image mime means it was already
  // approved for native vision, so let it through.
  if (value.startsWith("image/") && opts.allowImageFileParts === true) return true;
  const allowed = Array.isArray(opts.allowedFilePartMimes) ? opts.allowedFilePartMimes : [];
  if (!allowed.length) return false;
  return allowed.map((m) => String(m || "").toLowerCase()).includes(value);
}

function skipPathOnlyAttachment(filePath, filename, opts = {}, reason = "not an explicitly safe inline type; use the source path with local tools") {
  if (typeof opts.onSkip === "function") {
    opts.onSkip({ path: filePath, filename, reason });
  }
}

function skipImageAttachment(filePath, filename, opts = {}) {
  skipPathOnlyAttachment(
    filePath,
    filename,
    opts,
    "image handled through Lily vision extraction/source path, not uploaded as a raw model file part",
  );
}

function fileToTextAttachment(file, opts = {}) {
  if (!file || typeof file !== "object") return null;
  const filePath = file.path || file.filePath;
  if (!filePath || !fs.existsSync(filePath)) return null;
  const ext = fileExtension(file, filePath);
  if (!isInlineTextExtension(ext)) return null;
  const filename = file.name || path.basename(filePath);
  const maxInlineFileBytes =
    Number.isFinite(opts.maxInlineFileBytes) && opts.maxInlineFileBytes >= 0
      ? opts.maxInlineFileBytes
      : DEFAULT_MAX_INLINE_FILE_BYTES;
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return null;
    if (stat.size > maxInlineFileBytes) {
      if (typeof opts.onSkip === "function") {
        opts.onSkip({
          path: filePath,
          filename,
          size: stat.size,
          reason: `larger than text inline limit ${formatBytes(maxInlineFileBytes)}`,
        });
      }
      return null;
    }
    const source = fs.readFileSync(filePath, "utf8");
    const fence = textFenceForExtension(ext);
    const body = truncateAttachmentText(source, opts.maxTextAttachmentChars);
    return [
      `[Attached ${ext.slice(1).toUpperCase()}: ${filename}]`,
      `Source path: ${filePath}`,
      "",
      `\`\`\`${fence}`,
      body,
      "```",
    ].join("\n");
  } catch {
    return null;
  }
}

/**
 * Turn one Lily file ({path,name,isImage} from the composer, or {uri,mime})
 * into an OpenCode FilePart { type:"file", mime, filename, url }. Local files
 * become base64 `data:` URLs only for explicitly allowed inline-safe types.
 * Raster images require native-vision opt-in; otherwise Lily sends the vision
 * extraction/path context instead of raw image bytes.
 */
function fileToPart(file, opts = {}) {
  if (!file || typeof file !== "object") return null;
  if (file.uri && file.mime) {
    if (isRasterImageAttachment(file, file.path || file.filePath || "", file.mime) && opts.allowImageFileParts !== true) {
      skipImageAttachment(file.path || file.filePath || "", file.name || file.filename || "", opts);
      return null;
    }
    if (isPathOnlyDocumentAttachment(file)) {
      skipPathOnlyAttachment(
        file.path || file.filePath || "",
        file.name || file.filename || "",
        opts,
        "document handled through Lily document extraction/source path, not uploaded as a raw model file part",
      );
      return null;
    }
    if (!filePartMimeAllowed(file.mime, opts)) {
      skipPathOnlyAttachment(file.path || file.filePath || "", file.name || file.filename || "", opts);
      return null;
    }
    return {
      type: "file",
      url: file.uri,
      mime: file.mime,
      ...(file.name ? { filename: file.name } : {}),
    };
  }
  const filePath = file.path || file.filePath;
  if (!filePath || !fs.existsSync(filePath)) return null;
  const ext = fileExtension(file, filePath);
  const mime = file.mime || FILE_MIME[ext] || "application/octet-stream";
  const filename = file.name || path.basename(filePath);
  if (isInlineTextExtension(ext)) {
    if (typeof opts.onSkip === "function") {
      opts.onSkip({
        path: filePath,
        filename,
        reason: `${ext.slice(1)}_text_attachment`,
      });
    }
    return null;
  }
  if (isPathOnlyDocumentAttachment(file, filePath)) {
    skipPathOnlyAttachment(
      filePath,
      filename,
      opts,
      "document handled through Lily document extraction/source path, not uploaded as a raw model file part",
    );
    return null;
  }
  if (isRasterImageAttachment(file, filePath, mime) && opts.allowImageFileParts !== true) {
    skipImageAttachment(filePath, filename, opts);
    return null;
  }
  if (!filePartMimeAllowed(mime, opts)) {
    skipPathOnlyAttachment(filePath, filename, opts);
    return null;
  }
  const maxInlineFileBytes =
    Number.isFinite(opts.maxInlineFileBytes) && opts.maxInlineFileBytes >= 0
      ? opts.maxInlineFileBytes
      : DEFAULT_MAX_INLINE_FILE_BYTES;
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return null;
    if (stat.size > maxInlineFileBytes) {
      if (typeof opts.onSkip === "function") {
        opts.onSkip({
          path: filePath,
          filename,
          size: stat.size,
          reason: `larger than inline limit ${formatBytes(maxInlineFileBytes)}`,
        });
      }
      return null;
    }
    const data = fs.readFileSync(filePath).toString("base64");
    return {
      type: "file",
      mime,
      filename,
      url: `data:${mime};base64,${data}`,
    };
  } catch {
    return null;
  }
}

/**
 * Build the official OpenCode prompt body shape:
 * { agent, system?, model?, parts:[...fileParts, textPart] }.
 */
function buildOpencodePromptBody(opts = {}) {
  const parts = [];
  const skipped = [];
  const textAttachments = [];
  const guidance = typeof opts.guidance === "string" ? opts.guidance.trim() : "";
  if (Array.isArray(opts.files)) {
    for (const file of opts.files) {
      const textAttachment = fileToTextAttachment(file, {
        maxInlineFileBytes: opts.maxInlineFileBytes,
        maxTextAttachmentChars: opts.maxTextAttachmentChars,
        onSkip: (item) => skipped.push(item),
      });
      if (textAttachment) {
        textAttachments.push(textAttachment);
        continue;
      }
      // A DISK text-type attachment that did not inline (too big / unreadable)
      // must NOT be resent as a raw file part — its content lives at the source
      // path and it was already noted. Sending it as a file part is exactly what
      // throws AI_UnsupportedFunctionalityError on image-only models. (URI
      // attachments have no disk path to inline, so they fall through to the
      // capability-gated file-part path below.)
      const diskPath = file && (file.path || file.filePath);
      if (diskPath && isInlineTextExtension(fileExtension(file, diskPath))) continue;
      const part = fileToPart(file, {
        maxInlineFileBytes: opts.maxInlineFileBytes,
        allowImageFileParts: opts.allowImageFileParts === true,
        allowedFilePartMimes: opts.allowedFilePartMimes,
        onSkip: (item) => skipped.push(item),
      });
      if (part) parts.push(part);
    }
  }
  const indexNote = buildAttachmentIndex(opts.files);
  const note = buildSkippedAttachmentNote(skipped);
  const text = [String(opts.text || ""), indexNote, ...textAttachments, note].filter(Boolean).join("\n\n");
  parts.push({ type: "text", text });
  const body = { agent: opts.agent || "build", parts };
  if (guidance) body.system = truncateSystemGuidance(guidance, opts.maxSystemPromptChars, { intentText: opts.text });
  if (opts.model?.providerID && opts.model?.modelID) {
    body.model = { providerID: opts.model.providerID, modelID: opts.model.modelID };
  }
  return body;
}

// Guide sections that are GUARDRAILS rather than skill documentation. When the
// guide must shrink to a weak gateway's system budget, these survive first —
// they are exactly the rules that keep a weak model from drowning itself
// (blind whole-file reads, fake background-job claims).
// Sections a weak model needs MOST — kept first, shed last. The English
// protocol titles are fixed machine anchors; the Universal Operating Discipline
// title is localized (zh/en/ar), so match all three. Its anti-hallucination
// rules ("evidence first / say unknown when unsure") were being shed under a
// tight prompt budget, which is what let the model answer confidently wrong.
// (A distilled copy also rides the never-truncated head; this keeps the FULL
// discipline block whenever the budget allows.)
const GUARDRAIL_SECTION_TITLE = /^(?:(?:Large Input Protocol|Process Job Protocol|Tool Protocol)\b|Execution Protocol \(lite support\)$|通用执行纪律|Universal Operating Discipline|انضباط التنفيذ)/i;

const TRUNCATION_NOTICE =
  "[System guide truncated by Lily for this model's input limit. Use available tools and ask for narrower scope if a capability guide is missing.]";

/** Split markdown guidance into [head, ...sections] on `## ` headings. */
function splitGuidanceSections(text) {
  const lines = String(text || "").split("\n");
  const sections = [];
  let current = { title: "", lines: [] };
  for (const line of lines) {
    if (line.startsWith("## ")) {
      sections.push(current);
      current = { title: line.slice(3).trim(), lines: [line] };
    } else {
      current.lines.push(line);
    }
  }
  sections.push(current);
  return sections;
}

function legacyHeadCut(text, limit, notice) {
  const safeLimit = Math.max(0, Math.floor(limit));
  if (safeLimit <= notice.length) return notice.slice(0, safeLimit);
  const headLimit = safeLimit - notice.length;
  return `${text.slice(0, headLimit).trimEnd()}${notice}`;
}

function omittedSectionsLine(sections) {
  if (!sections.length) return "";
  const titles = sections.map((section) => section.title || "(untitled)").join("; ").slice(0, 150);
  return `\n\n[Omitted for this model's input limit: ${titles}. Ask the user to narrow scope if one is needed.]`;
}

function minimumGuardrailBody(body) {
  const source = String(body || "").trim();
  const newline = source.indexOf("\n");
  if (newline < 0) return source;
  const heading = source.slice(0, newline).trim();
  const content = source.slice(newline).trim();
  if (!content) return heading;
  const preview = content.slice(0, 180).trimEnd();
  return preview.length < content.length
    ? `${heading}\n\n${preview}\n[…]`
    : `${heading}\n\n${preview}`;
}

function truncateGuardrailBody(body, targetLength) {
  const source = String(body || "").trim();
  const minimum = minimumGuardrailBody(source);
  const target = Math.max(minimum.length, Math.floor(targetLength));
  if (source.length <= target) return source;
  const suffix = "\n[…]";
  return `${source.slice(0, Math.max(0, target - suffix.length)).trimEnd()}${suffix}`;
}

/**
 * Budget-aware guide truncation. The old behavior was a blind head-cut, which
 * dropped whatever sat at the tail — usually the protocol appendices, i.e. the
 * guardrails a weak model needs MOST. Now: the head (identity + core rules)
 * and guardrail sections are kept first, the remaining budget goes to skill
 * sections — ranked by relevance to THIS turn's request when `intentText` is
 * provided (intent-gated guidance: within the same budget, the sections that
 * survive are the ones this turn needs), authored order otherwise — and
 * dropped sections are NAMED so the model knows what it is missing.
 * Byte-identical when the guide fits (strong models without a probed budget
 * never enter this path); falls back to the legacy head-cut on any parsing
 * surprise.
 */
function truncateSystemGuidance(guidance, maxChars, { intentText = "" } = {}) {
  const text = String(guidance || "").trim();
  const limit = Number(maxChars);
  if (!text || !Number.isFinite(limit) || limit <= 0 || text.length <= limit) return text;
  const notice = `\n\n${TRUNCATION_NOTICE}`;
  try {
    const sections = splitGuidanceSections(text);
    if (sections.length <= 1) return legacyHeadCut(text, limit, notice);

    const head = sections[0];
    const rest = sections.slice(1);
    const guardrails = rest.filter((section) => GUARDRAIL_SECTION_TITLE.test(section.title));
    let others = rest.filter((section) => !GUARDRAIL_SECTION_TITLE.test(section.title));
    // Intent gating: rank skill sections by overlap with the outgoing request
    // so the surviving sections are the relevant ones. Stable for ties (and
    // for empty/no-signal requests), so behavior without a signal is exactly
    // the authored order.
    if (String(intentText || "").trim() && others.length > 1) {
      const { intentOverlapScore } = require("./intent-relevance");
      others = others
        .map((section, index) => ({
          section,
          index,
          score: intentOverlapScore(intentText, `${section.title}\n${section.lines.slice(0, 12).join("\n")}`),
        }))
        .sort((a, b) => (b.score - a.score) || (a.index - b.index))
        .map((entry) => entry.section);
    }
    const headText = head.lines.join("\n").trim();
    const guardrailBodies = guardrails.map((section) => section.lines.join("\n").trim());
    const minimumGuardrails = guardrailBodies.map(minimumGuardrailBody);
    const render = (keptBodies, omittedSections) => (
      `${[headText, ...keptBodies].filter(Boolean).join("\n\n")}${omittedSectionsLine(omittedSections)}${notice}`
    );

    // Start with every guardrail in full and every ordinary section omitted.
    // If this is too large, shrink only guardrails that have room above their
    // actionable minimum, largest-first. Re-rendering gives exact accounting
    // for separators and notices instead of reserving broad slack that can
    // trigger a final blind head cut.
    const keptGuardrails = [...guardrailBodies];
    let result = render(keptGuardrails, others);
    while (result.length > limit) {
      let candidateIndex = -1;
      let candidateReducible = 0;
      for (let index = 0; index < keptGuardrails.length; index += 1) {
        const reducible = keptGuardrails[index].length - minimumGuardrails[index].length;
        if (reducible > candidateReducible) {
          candidateIndex = index;
          candidateReducible = reducible;
        }
      }
      if (candidateIndex < 0 || candidateReducible <= 0) {
        return legacyHeadCut(text, limit, notice);
      }
      const excess = result.length - limit;
      keptGuardrails[candidateIndex] = truncateGuardrailBody(
        keptGuardrails[candidateIndex],
        keptGuardrails[candidateIndex].length - Math.min(excess, candidateReducible),
      );
      result = render(keptGuardrails, others);
    }

    // Spend any exact remainder on ordinary sections in relevance/authored
    // order. The omitted-title line is recomputed for every candidate because
    // it is part of the real gateway budget too.
    const kept = [...keptGuardrails];
    const omitted = [...others];
    for (const section of others) {
      const body = section.lines.join("\n").trim();
      const nextOmitted = omitted.filter((item) => item !== section);
      const candidate = render([...kept, body], nextOmitted);
      if (candidate.length <= limit) {
        kept.push(body);
        omitted.splice(omitted.indexOf(section), 1);
        result = candidate;
      }
    }

    return result.length <= limit ? result : legacyHeadCut(text, limit, notice);
  } catch {
    return legacyHeadCut(text, limit, notice);
  }
}

module.exports = {
  DEFAULT_MAX_INLINE_FILE_BYTES,
  DEFAULT_MAX_TEXT_ATTACHMENT_CHARS,
  buildSkippedAttachmentNote,
  buildAttachmentIndex,
  buildOpencodePromptBody,
  truncateSystemGuidance,
  fileToTextAttachment,
  fileToPart,
  filePartMimeAllowed,
  isInlineTextExtension,
};
