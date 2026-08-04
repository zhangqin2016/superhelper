"use strict";

/**
 * Pre-send enrichment: turn images into recognized text (vision) and documents
 * into extracted text (document) BEFORE the message reaches the engine. Factored
 * out of turn-orchestrator so the orchestration (notice sequence + outbound file
 * pruning + failure shapes) is unit-testable in isolation.
 *
 * Notices are emitted via an injected `emitNotice(notice)` callback rather than
 * reaching into the orchestrator, so these are plain functions, not methods.
 * Returns { ok: true, text, files } on success. Enrichment failures degrade into
 * guarded context plus original files so the engine can still inspect/retry;
 * preflight must not make the product worse by killing the user's turn.
 */

const path = require("node:path");
const { resolveLiveFilePath } = require("./live-file-source");

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"]);
const DOCUMENT_EXTENSIONS = new Set([".pdf", ".docx", ".xlsx", ".pptx", ".txt", ".md", ".csv", ".json", ".yaml", ".yml", ".xml", ".html", ".htm", ".rtf"]);

function isVisionRasterFile(file) {
  if (!file) return false;
  const ext = path.extname(String(file.path || file.name || "")).toLowerCase();
  return IMAGE_EXTENSIONS.has(ext);
}

function withoutVisionFiles(files = []) {
  return (files || []).filter((file) => {
    if (!file) return false;
    return !isVisionRasterFile(file);
  });
}

function documentInputFiles(files = [], isExtractableDocumentFile = null) {
  if (typeof isExtractableDocumentFile === "function") {
    return (files || []).filter((file) => isExtractableDocumentFile(file));
  }
  return (files || []).filter((file) => DOCUMENT_EXTENSIONS.has(
    path.extname(String(file?.path || file?.name || "")).toLowerCase(),
  ));
}

function sourceContentEvidence({ sourceType, method, status, sourceCount = 0, observedCount = 0, failedCount = 0, extractedChars = 0, coverageLimited = false } = {}) {
  const normalizedSourceCount = Math.max(0, Number(sourceCount || 0));
  const normalizedObservedCount = Math.max(0, Number(observedCount || 0));
  const normalizedFailedCount = Math.max(0, Number(failedCount || 0));
  return {
    sourceType: String(sourceType || "unknown"),
    method: String(method || "unknown"),
    status: String(status || "unavailable"),
    sourceCount: normalizedSourceCount,
    observedCount: normalizedObservedCount,
    failedCount: normalizedFailedCount,
    extractedChars: Math.max(0, Number(extractedChars || 0)),
    coverageLimited: Boolean(coverageLimited),
    complete: status === "complete" && normalizedSourceCount > 0 && normalizedObservedCount >= normalizedSourceCount,
  };
}

function buildVisionFailureContext(files = [], detail = "") {
  const attached = (files || [])
    .filter((file) => file?.path || file?.name)
    .map((file) => {
      const label = file.name || path.basename(String(file.path || ""));
      const source = file.path ? ` (${file.path})` : "";
      return `- ${label}${source}`;
    });
  return [
    "Image recognition fallback",
    detail ? `Recognition error: ${detail}` : "Recognition error: VISION_FAILED",
    attached.length ? "Attached image/vector file(s):" : "",
    ...attached,
    "",
    "The image recognition bridge did not produce text before sending. Do not claim visual details unless you can inspect the file through an available tool or the model can read the attachment directly. If the file is SVG or another text/vector artifact, read the file content directly. Keep the user's request moving instead of failing the turn.",
  ].filter(Boolean).join("\n");
}

function buildDocumentFailureContext(files = [], detail = "") {
  const attached = (files || [])
    .filter((file) => file?.path || file?.name)
    .map((file) => {
      const label = file.name || path.basename(String(file.path || ""));
      const source = file.path ? ` (${file.path})` : "";
      return `- ${label}${source}`;
    });
  return [
    "Document extraction fallback",
    detail ? `Extraction error: ${detail}` : "Extraction error: DOCUMENT_FAILED",
    attached.length ? "Attached file(s):" : "",
    ...attached,
    "",
    "The document content was not parsed before sending. Do not summarize, quote, or infer facts from the document based only on this metadata. Keep the user's request moving by retrying extraction with available tools/dependency packs, or explain that the file content could not be read yet.",
  ].filter(Boolean).join("\n");
}

async function runVisionPreflight(text, files, { emitNotice, nativeVision } = {}) {
  const {
    buildEnrichedUserText,
    hasVisionInputFiles,
    translateImages,
  } = require("./vision-translator");
  const notify = typeof emitNotice === "function" ? emitNotice : () => {};
  const visionFiles = (files || []).filter(isVisionRasterFile);

  // The active model recognizes images itself — skip the Qwen bridge entirely
  // and let images pass through untouched so they reach the engine as image
  // blocks (agent-session.buildUserMessagePayload).
  if (nativeVision) {
    return {
      ok: true,
      text,
      files,
      visionEvidence: visionFiles.length ? sourceContentEvidence({
        sourceType: "image",
        method: "native_model_input",
        status: "available",
        sourceCount: visionFiles.length,
      }) : null,
    };
  }

  if (!hasVisionInputFiles(files)) {
    return { ok: true, text, files: withoutVisionFiles(files) };
  }

  notify({ code: "visionPreparing", level: "progress", panel: true, replace: true });

  const result = await translateImages(files, { userText: text });
  if (result === null) {
    notify({
      code: "visionSkipped",
      level: "warning",
      panel: true,
      replace: true,
      replacesCode: "visionPreparing",
      done: true,
    });
    const fallbackText = buildVisionFailureContext(files, "No readable local image file was available to the vision bridge.");
    return {
      ok: true,
      text: buildEnrichedUserText(text, fallbackText),
      files,
      visionDegraded: true,
      visionEvidence: sourceContentEvidence({
        sourceType: "image",
        method: "vision_bridge",
        status: "unavailable",
        sourceCount: visionFiles.length,
        failedCount: visionFiles.length,
      }),
    };
  }

  if (!result.ok) {
    notify({
      code: "visionSkipped",
      level: "warning",
      panel: true,
      replace: true,
      replacesCode: "visionPreparing",
      done: true,
    });
    const detail = result.detail || result.reason || "VISION_FAILED";
    const fallbackText = buildVisionFailureContext(files, detail);
    return {
      ok: true,
      text: buildEnrichedUserText(text, fallbackText),
      files,
      visionDegraded: true,
      visionEvidence: sourceContentEvidence({
        sourceType: "image",
        method: "vision_bridge",
        status: "unavailable",
        sourceCount: visionFiles.length,
        failedCount: visionFiles.length,
      }),
    };
  }

  notify({
    code: "visionReady",
    level: "info",
    panel: true,
    replace: true,
    replacesCode: "visionPreparing",
    done: true,
  });

  const failedFiles = Array.isArray(result.failedFiles) ? result.failedFiles : [];
  const partialFailureContext = failedFiles.length
    ? buildVisionFailureContext(
        failedFiles,
        `${failedFiles.length} attached image(s) could not be recognized by the vision bridge.`,
      )
    : "";
  const enrichedText = buildEnrichedUserText(
    text,
    [result.text, partialFailureContext].filter(Boolean).join("\n\n"),
  );
  const outboundFiles = result.keepOriginal || failedFiles.length
    ? files
    : withoutVisionFiles(files);
  const sourceCount = Number(result.sourceCount || visionFiles.length);
  const observedCount = Number(result.recognizedCount ?? Math.max(0, sourceCount - Number(result.failedCount || 0)));
  const status = observedCount >= sourceCount && sourceCount > 0 ? "complete" : observedCount > 0 ? "partial" : "unavailable";
  return {
    ok: true,
    text: enrichedText,
    files: outboundFiles,
    visionEvidence: sourceContentEvidence({
      sourceType: "image",
      method: "vision_bridge",
      status,
      sourceCount,
      observedCount,
      failedCount: Number(result.failedCount || Math.max(0, sourceCount - observedCount)),
      extractedChars: String(result.text || "").length,
    }),
  };
}

async function runDocumentPreflight(text, files, { emitNotice } = {}) {
  const {
    buildEnrichedUserText,
    extractDocuments,
    hasDocumentInputFiles,
    isExtractableDocumentFile,
  } = require("./document-translator");
  const notify = typeof emitNotice === "function" ? emitNotice : () => {};
  const sourceFiles = documentInputFiles(files, isExtractableDocumentFile);

  if (!hasDocumentInputFiles(files)) {
    return { ok: true, text, files };
  }

  notify({ code: "documentPreparing", level: "progress", panel: true, replace: true });

  const result = await extractDocuments(files, {
    onProgress: (event = {}) => {
      if (!event.phase || event.phase === "started") return;
      const total = Number(event.total || 0);
      const processed = Number(event.processed || 0);
      const label = String(event.label || "").trim();
      const error = String(event.error || "").trim();
      const suffix = total > 0 ? `${processed}/${total}` : "";
      const detail = [label, suffix, event.indexPolicy ? `· ${event.indexPolicy}` : "", error ? `· ${error}` : ""]
        .filter(Boolean)
        .join(" ");
      notify({
        code: "workProgress",
        level: "progress",
        panel: true,
        replace: true,
        replacesCode: "documentPreparing",
        detail,
        progress: {
          domain: "document",
          phase: event.phase,
          processed,
          total,
          label,
          indexPolicy: event.indexPolicy || "",
          error,
        },
      });
    },
  });
  if (result === null) {
    return {
      ok: true,
      text,
      files,
      documentEvidence: {
        index: null,
        documents: [],
        chunks: [],
        extractedPaths: [],
        ...sourceContentEvidence({
          sourceType: "document",
          method: "local_document_extraction",
          status: "unavailable",
          sourceCount: sourceFiles.length,
          failedCount: sourceFiles.length,
        }),
      },
      documentDegraded: sourceFiles.length > 0,
    };
  }

  if (!result.ok) {
    notify({
      code: "documentSkipped",
      level: "warning",
      panel: true,
      replace: true,
      replacesCode: "documentPreparing",
      done: true,
    });
    const fallbackText = buildDocumentFailureContext(files, result.detail || result.reason || "DOCUMENT_FAILED");
    return {
      ok: true,
      text: buildEnrichedUserText(text, fallbackText),
      files,
      documentEvidence: {
        index: null,
        documents: [],
        chunks: [],
        extractedPaths: [],
        ...sourceContentEvidence({
          sourceType: "document",
          method: "local_document_extraction",
          status: "unavailable",
          sourceCount: sourceFiles.length,
          failedCount: sourceFiles.length,
        }),
      },
      documentDegraded: true,
    };
  }

  if (result.degraded) {
    notify({
      code: "documentSkipped",
      level: "warning",
      panel: true,
      replace: true,
      replacesCode: "documentPreparing",
      done: true,
    });
  } else {
    notify({
      code: "documentReady",
      level: "info",
      panel: true,
      replace: true,
      replacesCode: "documentPreparing",
      done: true,
    });
  }

  const extracted = new Set(result.extractedPaths || []);
  const outboundFiles = result.keepOriginal
    ? files
    : (files || []).filter((file) => !extracted.has(resolveLiveFilePath(file)));
  const documentContext = [result.text, result.documentIndexText].filter(Boolean).join("\n\n");
  const enrichedText = buildEnrichedUserText(text, documentContext);
  const extractedCount = (result.extractedPaths || []).length;
  const coverageLimited = /\[Content truncated, original length:/i.test(String(result.text || ""));
  const status = extractedCount <= 0
    ? "unavailable"
    : result.degraded || coverageLimited || extractedCount < sourceFiles.length
      ? "partial"
      : "complete";
  return {
    ok: true,
    text: enrichedText,
    files: outboundFiles,
    documentEvidence: {
      index: result.documentIndex || null,
      documents: Array.isArray(result.documentIndex?.documents) ? result.documentIndex.documents : [],
      chunks: Array.isArray(result.documentIndex?.chunks) ? result.documentIndex.chunks : [],
      extractedPaths: result.extractedPaths || [],
      ...sourceContentEvidence({
        sourceType: "document",
        method: "local_document_extraction",
        status,
        sourceCount: sourceFiles.length,
        observedCount: extractedCount,
        failedCount: Math.max(0, sourceFiles.length - extractedCount),
        extractedChars: String(result.text || "").length,
        coverageLimited,
      }),
    },
    documentDegraded: Boolean(result.degraded),
  };
}

module.exports = {
  buildDocumentFailureContext,
  buildVisionFailureContext,
  isVisionRasterFile,
  runVisionPreflight,
  runDocumentPreflight,
  withoutVisionFiles,
};
