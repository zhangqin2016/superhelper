import crypto from "node:crypto";
import zlib from "node:zlib";

// The client sends at most ~1.5 MB of log text; these bounds leave headroom
// and still stop an anonymous caller from parking arbitrary payloads here.
export const MAX_LOG_COMPRESSED_BYTES = 1024 * 1024;
export const MAX_LOG_BYTES = 4 * 1024 * 1024;
export const MAX_REPORT_BYTES = 256 * 1024;
export const LOG_ENCODING = "gzip+base64";

function decodeLog(log) {
  if (!log || typeof log !== "object") return null;
  if (log.encoding !== LOG_ENCODING || typeof log.data !== "string" || !log.data) return null;
  const compressed = Buffer.from(log.data, "base64");
  if (!compressed.length || compressed.length > MAX_LOG_COMPRESSED_BYTES) return null;
  let text;
  try {
    // maxOutputLength is the zip-bomb guard: a tiny body must not inflate
    // into something that takes the process down.
    text = zlib.gunzipSync(compressed, { maxOutputLength: MAX_LOG_BYTES });
  } catch {
    return null;
  }
  return {
    log_gzip: compressed,
    log_bytes: text.length,
    log_compressed_bytes: compressed.length,
    log_sha256: crypto.createHash("sha256").update(text).digest("hex"),
    log_truncated: Boolean(log.truncated),
  };
}

function normalizeReport(report) {
  if (!report || typeof report !== "object" || Array.isArray(report)) return null;
  let json;
  try {
    json = JSON.stringify(report);
  } catch {
    return null;
  }
  if (!json || Buffer.byteLength(json) > MAX_REPORT_BYTES) return null;
  return json;
}

/**
 * Turn the submitted diagnostics into a row, or null.
 *
 * Never throws and never rejects the request: the feedback text is the thing
 * the user wrote, and a malformed attachment must not cost them that. A bad
 * log is dropped, a bad report is dropped, and whatever survives is kept.
 */
export function normalizeSubmittedDiagnostics(input) {
  if (!input || typeof input !== "object") return null;
  const report = normalizeReport(input.report);
  const log = decodeLog(input.log);
  if (!report && !log) return null;
  return {
    report,
    log_gzip: log?.log_gzip ?? null,
    log_bytes: log?.log_bytes ?? null,
    log_compressed_bytes: log?.log_compressed_bytes ?? null,
    log_sha256: log?.log_sha256 ?? null,
    log_truncated: log?.log_truncated ?? false,
  };
}

/** What the admin list shows: the report and the log's size, never its bytes. */
export function diagnosticsForAdmin(row) {
  if (!row) return null;
  return {
    report: row.report || null,
    hasLog: Boolean(row.log_bytes),
    logBytes: row.log_bytes ?? null,
    logCompressedBytes: row.log_compressed_bytes ?? null,
    logTruncated: Boolean(row.log_truncated),
    logSha256: row.log_sha256 || null,
  };
}

export function inflateStoredLog(buffer) {
  return zlib.gunzipSync(Buffer.from(buffer), { maxOutputLength: MAX_LOG_BYTES });
}
