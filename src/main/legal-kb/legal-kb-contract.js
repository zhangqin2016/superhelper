"use strict";

const PACK_ID_RE = /^[a-z][a-z0-9-]{2,79}$/;
const SHA256_RE = /^[a-f0-9]{64}$/i;
const VERSION_RE = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/;

const LEGAL_KB_SCHEMA_VERSION = 1;

function normalizeArchivePath(value) {
  const raw = String(value || "").replaceAll("\\", "/");
  if (!raw) throw new Error("LEGAL_KB_EMPTY_PATH");
  if (raw.startsWith("/") || /^[A-Za-z]:\//.test(raw)) {
    throw new Error("LEGAL_KB_ABSOLUTE_PATH");
  }
  const normalized = raw
    .split("/")
    .filter((part) => part && part !== ".")
    .join("/");
  if (!normalized || normalized.split("/").includes("..")) {
    throw new Error("LEGAL_KB_PATH_TRAVERSAL");
  }
  return normalized;
}

function isIgnoredSourcePath(value) {
  let normalized;
  try {
    normalized = normalizeArchivePath(value).toLowerCase();
  } catch {
    return true;
  }
  return normalized.includes("/tools/")
    || normalized.startsWith("tools/")
    || normalized.includes("/vendor/")
    || normalized.startsWith("vendor/")
    || normalized.includes("/output/")
    || normalized.startsWith("output/")
    || /\.(?:cjs|mjs|js|html?|sh|bat|cmd|exe|dll|dylib|so|wasm|onnx)$/i.test(normalized);
}

function validateLegalPackManifest(input = {}) {
  const manifest = {
    schemaVersion: Number(input.schemaVersion || LEGAL_KB_SCHEMA_VERSION),
    packId: String(input.packId || "").trim(),
    contentVersion: String(input.contentVersion || "").trim(),
    sourceVersion: String(input.sourceVersion || input.contentVersion || "").trim(),
    articleCount: Number(input.articleCount || 0),
    documentCount: Number(input.documentCount || 0),
    sha256: input.sha256 == null ? "" : String(input.sha256).trim().toLowerCase(),
    sizeBytes: input.sizeBytes == null ? 0 : Number(input.sizeBytes),
  };
  const errors = [];
  if (!PACK_ID_RE.test(manifest.packId)) errors.push("PACK_ID_INVALID");
  if (!VERSION_RE.test(manifest.contentVersion)) errors.push("CONTENT_VERSION_INVALID");
  if (!VERSION_RE.test(manifest.sourceVersion)) errors.push("SOURCE_VERSION_INVALID");
  if (manifest.schemaVersion !== LEGAL_KB_SCHEMA_VERSION) errors.push("SCHEMA_VERSION_UNSUPPORTED");
  if (!Number.isSafeInteger(manifest.articleCount) || manifest.articleCount < 1) errors.push("ARTICLE_COUNT_INVALID");
  if (!Number.isSafeInteger(manifest.documentCount) || manifest.documentCount < 1) errors.push("DOCUMENT_COUNT_INVALID");
  if (manifest.sha256 && !SHA256_RE.test(manifest.sha256)) errors.push("SHA256_INVALID");
  if (!Number.isSafeInteger(manifest.sizeBytes) || manifest.sizeBytes < 0) errors.push("SIZE_INVALID");
  return errors.length ? { ok: false, errors, manifest } : { ok: true, manifest };
}

module.exports = {
  LEGAL_KB_SCHEMA_VERSION,
  normalizeArchivePath,
  isIgnoredSourcePath,
  validateLegalPackManifest,
};
