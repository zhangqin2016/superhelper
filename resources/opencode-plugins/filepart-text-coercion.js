// Coerce model-incompatible file parts to inline TEXT right before every model
// call — the engine-side self-heal for AI_UnsupportedFunctionalityError.
//
// THE BUG: a file part whose media type is not an image (or PDF) — e.g. a JSON /
// XML / CSV attachment — is handed to the provider's AI SDK adapter as a raw
// `{type:"file", mediaType:"application/json"}` part. deepseek and most
// custom/BYOK providers only accept IMAGE file parts, so the adapter throws
// `AI_UnsupportedFunctionalityError` in getArgs, BEFORE any HTTP call. That kills
// the turn — and worse, it kills COMPACTION, which re-serializes the whole
// stored history: once such a part is in a session's history, every later turn
// and every compaction fails and the conversation is stuck.
//
// WHY HERE: `experimental.chat.messages.transform` fires on BOTH the normal turn
// path (prompt.ts) and the compaction path (compaction.ts), on the parts BEFORE
// `toModelMessages` converts them for the model. The engine's own `stripMedia`
// only strips `isMedia` mimes (image/* + application/pdf); everything else falls
// through as a file part. So converting the non-media file parts to text here
// self-heals BOTH new sends AND already-poisoned sessions, model-agnostically —
// nothing is lost, the content just takes a universally-accepted shape (text).
//
// Images and PDFs are LEFT ALONE (vision/pdf-capable models legitimately take
// them, and the engine handles them). Only non-media file parts are coerced.
//
// FAIL OPEN: never throws — any error leaves the parts untouched (today's
// behavior). Kill switch: LILY_FILEPART_COERCE=0. Budget: LILY_FILEPART_TEXT_MAX_CHARS.
//
// NOTE: only the plugin factory is exported (named + default). The OpenCode
// plugin loader instantiates EVERY export of a plugin file as a plugin factory,
// so exporting a helper would make it call the helper as a factory → crash.
// Keep all helpers INTERNAL.

import fs from "node:fs";

const MAX_CHARS = Math.max(4_000, Number(process.env.LILY_FILEPART_TEXT_MAX_CHARS) || 32_000);

// image/* and application/pdf are real media the engine + capable models handle.
function isMediaMime(mime) {
  const m = String(mime || "").toLowerCase();
  return m.startsWith("image/") || m === "application/pdf";
}

// text/plain and directory markers are already handled by the engine's own
// conversion — leaving them avoids double-handling.
function isEngineHandledMime(mime) {
  const m = String(mime || "").toLowerCase();
  return m === "text/plain" || m === "application/x-directory";
}

// Textual/structured content that decodes cleanly to UTF-8 (so we can inline the
// real bytes). Anything else becomes a short note instead of decoded garbage.
function isTextualMime(mime) {
  const m = String(mime || "").toLowerCase();
  if (m.startsWith("text/")) return true;
  return /(?:\+|\/|-|\b)(?:json|xml|yaml|yml|ndjson|jsonl|javascript|ecmascript|csv|tsv|toml|ini|graphql|sql|html|markdown|x-www-form-urlencoded)\b/.test(m);
}

function boundText(text) {
  const value = String(text || "");
  if (value.length <= MAX_CHARS) return value;
  const headLen = Math.floor(MAX_CHARS * 0.7);
  const tailLen = Math.max(0, MAX_CHARS - headLen - 200);
  const head = value.slice(0, headLen);
  const tail = tailLen > 0 ? value.slice(-tailLen) : "";
  return `${head}\n\n[… ${value.length - headLen - tailLen} chars omitted to keep the model context small …]\n\n${tail}`;
}

// Recover the file's text content from its part url (data: URL or a local path /
// file:// URL). Returns null when it cannot be decoded as text.
function extractText(url) {
  const raw = String(url || "");
  if (!raw) return null;
  try {
    if (raw.startsWith("data:")) {
      const comma = raw.indexOf(",");
      if (comma < 0) return null;
      const meta = raw.slice(5, comma);
      const payload = raw.slice(comma + 1);
      if (/;base64/i.test(meta)) return Buffer.from(payload, "base64").toString("utf8");
      return decodeURIComponent(payload);
    }
    let filePath = raw;
    if (raw.startsWith("file://")) {
      try { filePath = decodeURIComponent(new URL(raw).pathname); } catch { filePath = raw.slice(7); }
    }
    if (filePath.startsWith("/") && fs.existsSync(filePath)) {
      const stat = fs.statSync(filePath);
      if (stat.isFile() && stat.size <= MAX_CHARS * 8) return fs.readFileSync(filePath, "utf8");
    }
  } catch {
    /* fall through to null */
  }
  return null;
}

function coercePart(part) {
  if (!part || part.type !== "file") return;
  const mime = part.mime || "";
  if (isMediaMime(mime) || isEngineHandledMime(mime)) return;
  const label = part.filename || "attachment";
  const decoded = isTextualMime(mime) ? extractText(part.url) : null;
  const text =
    decoded != null
      ? `[Attached ${mime || "file"}: ${label}]\n\n\`\`\`\n${boundText(decoded)}\n\`\`\``
      : `[Attached ${mime || "file"}: ${label} — not inlined as a raw file part because the model does not accept this file type. Ask to open it with file tools if a source path is available.]`;
  // Mutate in place so the message keeps its id/role/ordering; toModelMessages
  // reads only type + text for a text part.
  part.type = "text";
  part.text = text;
  delete part.mime;
  delete part.url;
  delete part.filename;
}

export const FilePartTextCoercionPlugin = async () => ({
  "experimental.chat.messages.transform": async (_input, output) => {
    try {
      if (process.env.LILY_FILEPART_COERCE === "0") return;
      const messages = output && Array.isArray(output.messages) ? output.messages : null;
      if (!messages) return;
      for (const message of messages) {
        const parts = message && Array.isArray(message.parts) ? message.parts : null;
        if (!parts) continue;
        for (const part of parts) coercePart(part);
      }
    } catch {
      /* fail open — this transform must never break a turn or compaction */
    }
  },
});

export default FilePartTextCoercionPlugin;
