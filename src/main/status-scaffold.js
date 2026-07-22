"use strict";

// Status-report SCAFFOLD stripper (2026-07-22 field case): after a compaction /
// resume the model sometimes echoes the internal handoff summary — "Objective /
// Important Details / Work State / Completed / Active / Blocked / Next Move /
// Relevant Files" (or the opencode compaction template "## Goal / Constraints &
// Preferences / … / Relevant Files") — AS its user-facing reply, then appends
// the real answer. Prompt-level bans exist (session-bootstrap, followup-context,
// task-type-schema) and weak models still dump it. The scaffold has RIGID
// structure — known header lines, at the message head — so code, not the model,
// detects and strips it. Red line: never delete real reply text. When the
// boundary between scaffold and reply is unclear the original is kept
// (fail-open); only a message that is ENTIRELY scaffold is replaced by a note.

// Both known handoff templates, bare ("Work State") or markdown ("## Goal",
// "**Blocked:**") form. Distinctive anchors below; generic section words only
// count toward the scaffold verdict alongside ≥2 anchors.
const ANCHOR_HEADERS = new Set([
  "important details",
  "work state",
  "next move",
  "relevant files",
  "constraints & preferences",
  "critical context",
]);
const GENERIC_HEADERS = new Set([
  "objective",
  "goal",
  "completed",
  "active",
  "blocked",
  "key decisions",
  "next steps",
  "progress",
  "done",
  "in progress",
]);
const SCAFFOLD_HEADERS = new Set([...ANCHOR_HEADERS, ...GENERIC_HEADERS]);
// The last section of every known template; its body is file paths, which are
// mechanically distinguishable from reply prose (the 2026-07-22 salvage case).
const TERMINAL_HEADERS = new Set(["relevant files"]);

const MIN_DISTINCT_HEADERS = 4;
const MIN_ANCHOR_HEADERS = 2;
const HEAD_LINE_LIMIT = 120;
const HEAD_CHAR_LIMIT = 8000;
const STREAM_HOLD_CHAR_LIMIT = 4096;

const NONE_LINE_RE = /^[（(]\s*(?:无|none|n\/a)\s*[)）]$/i;
const PLACEHOLDER_LINE_RE = /^(?:…|\.{3}|-{3,}|\*{3,})$/;
const FILE_LINE_RE = /^(?:[-*•]\s*)?(?:\/|~\/|[A-Za-z]:[\\/]|\S+\.(?:md|markdown|json|js|mjs|cjs|py|ts|tsx|jsx|css|html|txt|gz|zip|tar|yaml|yml|toml|sh|docx|xlsx|pptx|png|jpe?g|webp|svg|mp4|pdf)(?:\s|$|[—:：-]))/i;

function headerOfLine(line) {
  const m = String(line).match(/^\s*(?:#{1,6}\s+)?(.+?)\s*$/);
  if (!m) return null;
  const norm = m[1]
    .replace(/\*\*/g, "")
    .replace(/[:：]\s*$/, "")
    .trim()
    .toLowerCase();
  return SCAFFOLD_HEADERS.has(norm) ? norm : null;
}

function isBlank(line) {
  return !String(line).trim();
}

function isTerminalBodyLine(line) {
  const t = String(line).trim();
  return !t || NONE_LINE_RE.test(t) || PLACEHOLDER_LINE_RE.test(t) || FILE_LINE_RE.test(t);
}

/**
 * Analyze text for a status-report scaffold.
 * @returns {{
 *   isScaffold: boolean,            // ≥4 distinct headers incl. ≥2 anchors in the head
 *   firstLineHeader: boolean,       // first non-blank line is a scaffold header
 *   startsWithScaffold: boolean,    // isScaffold && scaffold sits at the message head
 *   stripIndex: number|null,        // char offset where the real reply begins
 *                                    // (src.length when the message is entirely scaffold;
 *                                    // null when the boundary is ambiguous — fail open)
 *   headers: string[],
 * }}
 */
function analyzeStatusScaffold(text) {
  const src = String(text || "");
  const result = {
    isScaffold: false,
    firstLineHeader: false,
    startsWithScaffold: false,
    stripIndex: null,
    headers: [],
  };
  if (!src.trim()) return result;
  const lines = src.split("\n");
  const offsets = new Array(lines.length);
  let off = 0;
  for (let i = 0; i < lines.length; i += 1) {
    offsets[i] = off;
    off += lines[i].length + 1;
  }
  const headerLines = [];
  let firstNonBlank = -1;
  let scanned = 0;
  const limit = Math.min(lines.length, HEAD_LINE_LIMIT);
  for (let i = 0; i < limit; i += 1) {
    scanned += lines[i].length + 1;
    if (scanned > HEAD_CHAR_LIMIT) break;
    if (firstNonBlank < 0 && !isBlank(lines[i])) firstNonBlank = i;
    const h = headerOfLine(lines[i]);
    if (h) headerLines.push({ idx: i, name: h });
  }
  if (firstNonBlank >= 0) {
    result.firstLineHeader = headerLines.length > 0 && headerLines[0].idx === firstNonBlank;
  }
  const distinct = new Set(headerLines.map((h) => h.name));
  const anchors = [...distinct].filter((h) => ANCHOR_HEADERS.has(h));
  if (distinct.size < MIN_DISTINCT_HEADERS || anchors.length < MIN_ANCHOR_HEADERS) return result;
  result.isScaffold = true;
  result.headers = [...distinct];
  if (!result.firstLineHeader) return result; // scaffold mid-text: caller hides the whole message
  result.startsWithScaffold = true;

  const last = headerLines[headerLines.length - 1];
  let i = last.idx + 1;
  if (TERMINAL_HEADERS.has(last.name)) {
    // Terminal section body = file/none/placeholder lines; the first other line
    // is the real reply even with NO blank separator (the field case).
    while (i < lines.length && isTerminalBodyLine(lines[i])) i += 1;
    result.stripIndex = i >= lines.length ? src.length : offsets[i];
    return result;
  }
  // Non-terminal last header (a truncated dump): the body is arbitrary prose,
  // so the ONLY trustworthy boundary is a blank-line gap.
  while (i < lines.length) {
    if (isBlank(lines[i])) {
      let j = i;
      while (j < lines.length && isBlank(lines[j])) j += 1;
      if (j >= lines.length) {
        result.stripIndex = src.length; // trailing blanks only: entirely scaffold
        return result;
      }
      result.stripIndex = offsets[j];
      return result;
    }
    i += 1;
  }
  // Ran to the end with no blank gap: cannot tell body prose from reply prose.
  return result;
}

/**
 * Strip a leading scaffold, keeping the real reply. Returns
 * { text, stripped, pure, analysis } — `pure` means the message was ENTIRELY
 * scaffold (text is ""). Unstrippable input comes back verbatim.
 */
function stripStatusScaffoldPrefix(text) {
  const src = String(text || "");
  const analysis = analyzeStatusScaffold(src);
  if (!analysis.startsWithScaffold || analysis.stripIndex == null) {
    return { text: src, stripped: false, pure: false, analysis };
  }
  const remainder = src.slice(analysis.stripIndex).replace(/^\s+/, "").replace(/\s+$/, "");
  return { text: remainder, stripped: true, pure: !remainder, analysis };
}

/**
 * Streaming gate for assistant.delta. Feed the turn's ACCUMULATED assistant
 * text; "hold" suppresses emission (possible scaffold), "flush" emits the
 * given text (either the untouched accumulation or the scaffold-stripped
 * remainder). Fail-open: past the hold limit an UNCONFIRMED head streams
 * as-is — but a CONFIRMED scaffold never fails open, it holds for the
 * finalize strip (a false flush would leak exactly what this gate exists
 * to hide).
 */
function scaffoldStreamGate(accumulated) {
  const acc = String(accumulated || "");
  if (!acc) return { action: "hold", text: "" };
  const analysis = analyzeStatusScaffold(acc);
  if (analysis.startsWithScaffold) {
    if (analysis.stripIndex == null) return { action: "hold", text: "" };
    const rest = acc.slice(analysis.stripIndex).replace(/^\s+/, "");
    return rest ? { action: "flush", text: rest } : { action: "hold", text: "" };
  }
  // First line is a header but <4 distinct headers so far: could still grow
  // into a scaffold — keep holding (bounded by the fail-open limit). Anything
  // else can never become one.
  if (analysis.firstLineHeader && acc.length <= STREAM_HOLD_CHAR_LIMIT) {
    return { action: "hold", text: "" };
  }
  return { action: "flush", text: acc };
}

/** Replacement for a message that was ENTIRELY scaffold (no real reply exists). */
function statusScaffoldNote(userText = "") {
  const { answerLanguage } = require("./external-evidence-recovery");
  const language = answerLanguage(userText);
  return {
    zh: "（该轮回复只输出了内部状态摘要、没有实际内容，已隐藏。请重新发送你的问题。）",
    en: "(That reply contained only an internal status summary and no actual answer, so it was hidden. Please resend your question.)",
    ar: "(كان الرد مجرد ملخص حالة داخلية دون إجابة فعلية، لذا أُخفي. يُرجى إعادة إرسال سؤالك.)",
  }[language];
}

module.exports = {
  analyzeStatusScaffold,
  stripStatusScaffoldPrefix,
  scaffoldStreamGate,
  statusScaffoldNote,
  STREAM_HOLD_CHAR_LIMIT,
};
