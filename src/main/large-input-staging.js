"use strict";

// Top-tier ingestion: a huge pasted/typed message is a DATA DUMP, not a prompt.
// Dumping it straight into the model context is exactly the anti-pattern that
// bloats history and overflows the window (Cursor/Claude Code never do this —
// they persist bulk content and RETRIEVE only what the question needs).
//
// So when the message text is very large, we stage it to a workspace file and
// replace the model-facing text with a compact DIRECTIVE + a head/tail preview +
// the path, pointing the model at Lily's existing `lily_file_intelligence` tool
// (inspect_file → index/query/sample/extract) to work with it selectively. The
// user's instruction almost always sits at the head/tail, so the preview keeps
// it; the bulk stays on disk, retrievable, out of the context window.
//
// SCOPE: this only touches the ENGINE payload text. Lily's own message store
// keeps the user's original message verbatim, so the chat UI is unchanged.
//
// NEVER DUMBER: only triggers ABOVE a high threshold — normal messages (even
// long ones) pass through untouched. FAIL OPEN: any error returns the original
// text unchanged. Kill switch: LILY_LARGE_INPUT_STAGE=0.

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

// ~40k chars ≈ 10k tokens: comfortably above a real instruction/log a user wants
// read inline, at the point where the text is clearly bulk data, not a prompt.
const DEFAULT_THRESHOLD_CHARS = 40_000;
const DEFAULT_PREVIEW_CHARS = 6_000;
// A weak (lite-grade) model will answer from whatever preview it sees instead of
// retrieving — so for lite we give it a SMALL preview (just enough for the
// instruction) to force it through the retrieval path, plus a hard step-by-step
// directive. This is the enforcement lever: less to latch onto → must query.
const LITE_PREVIEW_CHARS = 1_500;

function positiveInt(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}

function headTailPreview(text, previewChars) {
  const s = String(text || "");
  if (s.length <= previewChars) return s;
  const headLen = Math.floor(previewChars * 0.7);
  const tailLen = Math.max(0, previewChars - headLen);
  const head = s.slice(0, headLen);
  const tail = tailLen > 0 ? s.slice(-tailLen) : "";
  const omitted = s.length - head.length - tail.length;
  return `${head}\n\n[… ${omitted} chars omitted — the FULL text is in the saved file, not here …]\n\n${tail}`;
}

function buildDirective({ filePath, chars, preview, strict }) {
  const head = `[Large input: ${chars} chars pasted into this message were saved to a workspace file to keep the model context small — the full content is NOT inlined below.]`;
  const instruction = strict
    ? [
        // Enforced retrieval path for weak models: a numbered, mandatory recipe
        // and an explicit ban on blind-reading the whole file.
        "You MUST retrieve from the file with the lily_file_intelligence tool — do NOT read the whole file (a blind read returns only a truncated head and you will answer wrong). Follow these steps:",
        `1) inspect_file { "path": "${filePath}" }`,
        `2) index { "path": "${filePath}" }  → note the returned indexId`,
        '3) query { "indexId": "<from step 2>", "query": "<the user\'s goal from the preview>", "limit": 5 }',
        "Answer ONLY from the retrieved chunks; state your coverage; never claim full coverage from the preview.",
      ].join("\n")
    : "Work with it via the lily_file_intelligence tool based on the request in the preview: inspect_file first, then index/query for targeted retrieval, or sample_file/extract_file_range — do NOT assume the preview is the whole content, and never claim full coverage from the preview alone.";
  return [
    head,
    `Source path: ${filePath}`,
    "",
    instruction,
    "",
    "--- preview (head + tail of the full input; the user's instruction is usually here) ---",
    preview,
    "--- end preview ---",
  ].join("\n");
}

/**
 * Stage an oversized message text to a workspace file and return a compact
 * model-facing replacement. Small texts pass through untouched.
 *
 * @returns {{ staged: boolean, text: string, file: {path,name,size}|null }}
 */
function stageLargeInputText({ text, cwd, threshold, previewChars, grade } = {}) {
  const source = typeof text === "string" ? text : "";
  try {
    const lite = String(grade || "").toLowerCase() === "lite";
    if (process.env.LILY_LARGE_INPUT_STAGE === "0") return { staged: false, text: source, file: null };
    const limit =
      positiveInt(threshold) ||
      positiveInt(process.env.LILY_LARGE_INPUT_STAGE_CHARS) ||
      DEFAULT_THRESHOLD_CHARS;
    if (source.length <= limit) return { staged: false, text: source, file: null };
    if (!cwd || typeof cwd !== "string") return { staged: false, text: source, file: null };

    const dir = path.join(cwd, ".lily-work", "inbox");
    fs.mkdirSync(dir, { recursive: true });
    const hash = crypto.createHash("sha1").update(source).digest("hex").slice(0, 12);
    const filePath = path.join(dir, `input-${hash}.txt`);
    // Content-addressed: identical re-sends (retries) reuse the same file.
    if (!fs.existsSync(filePath)) fs.writeFileSync(filePath, source);

    const previewLimit =
      positiveInt(previewChars) ||
      positiveInt(process.env.LILY_LARGE_INPUT_PREVIEW_CHARS) ||
      (lite ? LITE_PREVIEW_CHARS : DEFAULT_PREVIEW_CHARS);
    const replacement = buildDirective({
      filePath,
      chars: source.length,
      preview: headTailPreview(source, previewLimit),
      strict: lite,
    });
    return {
      staged: true,
      text: replacement,
      file: { path: filePath, name: path.basename(filePath), size: Buffer.byteLength(source) },
    };
  } catch {
    // Fail open: on any error the original text is sent unchanged (today's behavior).
    return { staged: false, text: source, file: null };
  }
}

module.exports = {
  DEFAULT_THRESHOLD_CHARS,
  DEFAULT_PREVIEW_CHARS,
  headTailPreview,
  stageLargeInputText,
};
