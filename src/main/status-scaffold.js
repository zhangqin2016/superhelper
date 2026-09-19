"use strict";

const fileKinds = require("../shared/file-kinds.mjs");

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
// Paths in these sections are usually markdown code spans or quoted
// (`/a/b.js`, "C:\\x"). A quote must not hide that the line is a file path:
// missing it makes the stripper mistake the file list for the real reply and
// publish it as the answer (2026-09-15 field case). The quote form is accepted
// ONLY after a bullet marker, which is how these templates write file lists —
// a bare quoted path at the start of a line is ordinary prose ("`/etc/hosts`
// 里少了一行"), and swallowing it would delete a real reply.
const QUOTE_OPEN = "[`'\"\u201c\u2018\u300c\u300e\uff08(]";
const QUOTE_CLOSE = "[`'\"\u201d\u2019\u300d\u300f\uff09)]";
const PATH_START = "(?:\\/|~\\/|[A-Za-z]:[\\\\/])";
const FILE_EXT = `(?:md|markdown|json|js|mjs|cjs|py|ts|tsx|jsx|css|html|txt|gz|zip|tar|yaml|yml|toml|sh|${fileKinds.alternation(fileKinds.EXTENSIONS.ooxml)}|${fileKinds.alternation(fileKinds.EXTENSIONS.browserImage)}|mp4|pdf)`;
const REL_FILE = (close) => `\\S+\\.${FILE_EXT}(?:\\s|$|${close ? `${QUOTE_CLOSE}|` : ""}[\u2014:\uff1a-])`;
const FILE_LINE_RE = new RegExp(
  "^(?:"
    + `[-*\u2022]\\s*(?:${QUOTE_OPEN}\\s*)?(?:${PATH_START}|${REL_FILE(true)})`
    + `|(?:${PATH_START}|${REL_FILE(false)})`
  + ")",
  "i",
);

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

// True while a not-yet-complete FIRST line could still grow into a scaffold
// header ("#", "## Obje"). Without this the gate decides on a fragment that is
// not yet a header, fails open, and streams the whole scaffold. Normal replies
// are not prefixes of these headers, so they still stream immediately.
function couldBecomeHeader(line) {
  const m = String(line).match(/^\s*(#{0,6}\s*)(.*)$/);
  if (!m) return false;
  const marker = (m[1] || "").trim();
  const body = (m[2] || "").replace(/\*\*/g, "").trim().toLowerCase();
  if (!body) return Boolean(marker);
  return [...SCAFFOLD_HEADERS].some((header) => header.startsWith(body));
}

function isBlank(line) {
  return !String(line).trim();
}

// A half-arrived last line that is still only a bullet and/or an opening quote
// ("- ", "- `") can still become a file path; judging it as prose would put the
// boundary inside the file list. Anything with real content after the marker is
// already decidable, so the gate judges it normally and keeps streaming live.
const PARTIAL_FILE_PREFIX_RE = new RegExp("^[-*\u2022]?\\s*(?:" + QUOTE_OPEN + "\\s*)?$");

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
 *   terminalBoundary: boolean,      // stripIndex came from the template's LAST
 *                                    // section (file-list body), so it cannot move
 *                                    // as more text arrives — the only boundary a
 *                                    // STREAMING caller may trust
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
    terminalBoundary: false,
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
    result.terminalBoundary = true;
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
 *
 * Mid-stream only a TERMINAL-section boundary may be trusted. A boundary found
 * after a non-terminal header is just "the first blank line so far", and the
 * next chunk can turn that gap into another scaffold section — flushing there
 * streams scaffold text to the user (2026-09-15 field case: "## Next Move" and
 * its body were shown live). Holding costs nothing: the finalizer strips the
 * completed message and emits the real reply.
 */
function scaffoldStreamGate(accumulated) {
  const acc = String(accumulated || "");
  if (!acc) return { action: "hold", text: "" };
  // The last line of a live stream may be half-arrived ("- " before its path).
  // While it is still only a bullet/quote marker it could become either a file
  // line or the reply, so it is withheld from the decision and re-judged when
  // more of it lands; once it carries content the gate judges it immediately so
  // a real reply after the scaffold still streams live.
  const lineEnd = acc.lastIndexOf("\n") + 1;
  const tail = acc.slice(lineEnd);
  const complete = lineEnd > 0 && PARTIAL_FILE_PREFIX_RE.test(tail) ? acc.slice(0, lineEnd) : acc;
  const analysis = analyzeStatusScaffold(complete);
  if (analysis.startsWithScaffold) {
    if (analysis.stripIndex == null || !analysis.terminalBoundary) return { action: "hold", text: "" };
    if (analysis.stripIndex >= complete.length) return { action: "hold", text: "" };
    const rest = acc.slice(analysis.stripIndex).replace(/^\s+/, "");
    return rest ? { action: "flush", text: rest } : { action: "hold", text: "" };
  }
  // First line is a header (or is still arriving and could become one) but <4
  // distinct headers so far: it could still grow into a scaffold — keep holding
  // (bounded by the fail-open limit). Anything else can never become one.
  const firstLineIncomplete = !acc.includes("\n");
  if ((analysis.firstLineHeader || (firstLineIncomplete && couldBecomeHeader(acc)))
    && acc.length <= STREAM_HOLD_CHAR_LIMIT) {
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
