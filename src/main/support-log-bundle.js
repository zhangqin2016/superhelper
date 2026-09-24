"use strict";

/**
 * What a feedback ticket carries so it can be acted on.
 *
 * A user writes in after the failure, often after restarting Lily; by then
 * every live check is green. The main log is the one record of what actually
 * happened, so a ticket carries its most recent part — the newest bytes across
 * the rotated generations, redacted, gzipped — plus the diagnostics report.
 *
 * This leaves the machine, so it is only ever sent when the user leaves the
 * box ticked, and everything it can strip before sending, it strips: keys,
 * tokens, passwords, the home directory (which names the OS account) and phone
 * numbers. Conversation text in the log is not removable without destroying
 * the log, which is why the choice is shown to the user rather than made for
 * them.
 */

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const zlib = require("node:zlib");

// Small enough to gzip to a few hundred KB (the server accepts 1 MB
// compressed), large enough to hold the session a user is complaining about.
const MAX_LOG_TAIL_BYTES = 1536 * 1024;
// Server keeps at most 1 MB compressed; stay clear of it.
const MAX_COMPRESSED_BYTES = 900 * 1024;
const LOG_ENCODING = "gzip+base64";
const DIAGNOSTICS_TIMEOUT_MS = 10_000;

function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Strip what can be stripped without making the log useless. */
function redactLogText(text, { homeDir = safeHomeDir() } = {}) {
  let out = String(text || "");
  out = out
    .replace(/\b(sk-[A-Za-z0-9._-]{6,})/g, "[redacted-key]")
    .replace(/\blilygw\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "[redacted-token]")
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, "[redacted-jwt]")
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, "$1 [redacted]")
    // key=value, key: value, "key":"value" — for any key that names a secret.
    // A bare number is left alone: "outputTokens=812" is a count, not a token.
    .replace(
      /(["']?[A-Za-z0-9_-]*(?:api[_-]?key|access[_-]?key|secret|token|password|passwd|authorization|signature|cookie)[A-Za-z0-9_-]*["']?\s*[:=]\s*)(["']?)(?![0-9]+(?:[\s,;}&"']|$))([^"'\s,;}&]+)/gi,
      "$1$2[redacted]",
    )
    // Mainland mobile numbers (the SMS login) — not needed to diagnose anything.
    .replace(/(^|[^\d])(1[3-9]\d{9})(?!\d)/g, "$1[redacted-phone]");
  if (homeDir && homeDir.length > 3) {
    const variants = new Set([homeDir, homeDir.replace(/\\/g, "/"), homeDir.replace(/\\/g, "\\\\")]);
    for (const variant of variants) {
      out = out.replace(new RegExp(escapeRegExp(variant), "gi"), "~");
    }
  }
  return out;
}

function safeHomeDir() {
  try {
    return os.homedir();
  } catch {
    return "";
  }
}

function defaultLogPaths() {
  const live = (() => {
    try {
      return require("./diagnostics/main-log-file").mainLogPaths();
    } catch {
      return [];
    }
  })();
  if (live.length) return live;
  // The sink may not have started in this process; the files from the last
  // run are still exactly what support needs.
  try {
    const { FILE_NAME, MAX_FILES } = require("./diagnostics/main-log-file");
    const base = path.join(require("./config").userDataPath("logs"), FILE_NAME);
    return [base, ...Array.from({ length: MAX_FILES }, (_, index) => `${base}.${index + 1}`)];
  } catch {
    return [];
  }
}

function readTail(file, maxBytes) {
  const fd = fs.openSync(file, "r");
  try {
    const size = fs.fstatSync(fd).size;
    const length = Math.min(size, maxBytes);
    const buffer = Buffer.alloc(length);
    fs.readSync(fd, buffer, 0, length, size - length);
    return { buffer, truncated: size > length };
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * The newest `maxBytes` of the log, oldest line first.
 * @param {{ paths?: string[], maxBytes?: number }} options  paths newest first
 * @returns {{ text: string, truncated: boolean, fileCount: number } | null}
 */
function collectLogTail({ paths = defaultLogPaths(), maxBytes = MAX_LOG_TAIL_BYTES } = {}) {
  const chunks = [];
  let remaining = maxBytes;
  let truncated = false;
  for (const file of paths) {
    if (remaining <= 0) {
      if (fs.existsSync(file)) truncated = true;
      continue;
    }
    let tail;
    try {
      if (!fs.existsSync(file)) continue;
      tail = readTail(file, remaining);
    } catch {
      continue;
    }
    if (!tail.buffer.length) continue;
    chunks.unshift(tail.buffer);
    remaining -= tail.buffer.length;
    if (tail.truncated) truncated = true;
  }
  if (!chunks.length) return null;
  let text = Buffer.concat(chunks).toString("utf8");
  // A cut tail starts mid-line (and possibly mid-character); drop the fragment.
  if (truncated) {
    const newline = text.indexOf("\n");
    if (newline >= 0) text = text.slice(newline + 1);
  }
  return { text, truncated, fileCount: chunks.length };
}

/** The log in the shape the server accepts, or null when there is none. */
function buildLogAttachment(options = {}) {
  let maxBytes = options.maxBytes || MAX_LOG_TAIL_BYTES;
  for (;;) {
    const built = buildLogAttachmentOnce({ ...options, maxBytes });
    // Text that compresses badly (base64 blobs in a log line) could exceed what
    // the server keeps, and it would drop the log silently. Send less instead.
    if (!built || built.compressedBytes <= MAX_COMPRESSED_BYTES || maxBytes <= 64 * 1024) {
      return built && built.compressedBytes <= MAX_COMPRESSED_BYTES ? built : null;
    }
    maxBytes = Math.floor(maxBytes / 2);
  }
}

function buildLogAttachmentOnce(options) {
  const tail = collectLogTail(options);
  if (!tail || !tail.text.trim()) return null;
  const text = Buffer.from(redactLogText(tail.text, options), "utf8");
  const compressed = zlib.gzipSync(text, { level: 9 });
  return {
    encoding: LOG_ENCODING,
    data: compressed.toString("base64"),
    originalBytes: text.length,
    compressedBytes: compressed.length,
    sha256: crypto.createHash("sha256").update(text).digest("hex"),
    truncated: tail.truncated,
    fileCount: tail.fileCount,
  };
}

/** The report is already key-redacted; this also takes the home dir out of its paths. */
function redactReport(report, options = {}) {
  try {
    return JSON.parse(redactLogText(JSON.stringify(report), options));
  } catch {
    return null;
  }
}

function withTimeout(promise, ms) {
  let timer;
  return Promise.race([
    promise,
    new Promise((resolve) => { timer = setTimeout(() => resolve(null), ms); }),
  ]).finally(() => clearTimeout(timer));
}

/**
 * Report + log for a feedback ticket. Never throws: a ticket without
 * diagnostics is still a ticket, which is exactly what it was before.
 */
async function collectFeedbackDiagnostics(options = {}) {
  const runReport = options.runReport || (() => require("./support-diagnostics").runSupportDiagnosticsPublic({
    // Local checks only: a model probe can take 12s+ and says nothing about the
    // failure the user is reporting, which already happened.
    refreshService: false,
    probeModel: false,
    engineBootTimeoutMs: 4_000,
  }));
  const raw = await withTimeout(Promise.resolve().then(runReport).catch(() => null), options.timeoutMs || DIAGNOSTICS_TIMEOUT_MS);
  const report = raw ? redactReport(raw, options) : null;
  let log = null;
  try {
    log = (options.buildLog || buildLogAttachment)(options);
  } catch {
    log = null;
  }
  if (!report && !log) return null;
  return { report: report || null, log };
}

module.exports = {
  LOG_ENCODING,
  MAX_LOG_TAIL_BYTES,
  buildLogAttachment,
  collectFeedbackDiagnostics,
  collectLogTail,
  redactLogText,
};
