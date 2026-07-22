/**
 * Code-aware segmentation for markdown preprocessing.
 *
 * Pre-parse transforms (math rendering, table repair candidates, etc.) must
 * never touch fenced code blocks or inline code spans — replacing inside them
 * corrupts the source before marked sees it (e.g. `$x$` inside a ``` fence
 * became KaTeX HTML that marked then escaped into garbled text).
 *
 * mapPlainSegments splits the source into plain/code segments, applies the
 * transform to plain segments only, and recombines exactly: the output always
 * equals the input outside plain-segment transform changes.
 */

const FENCE_RE = /^ {0,3}(`{3,}|~{3,})/;

export function mapPlainSegments(source = "", transform) {
  const text = String(source);
  if (!text || typeof transform !== "function") return text;
  return fenceGroups(text)
    .map((group) => (group.code ? group.text : mapInlineAware(group.text, transform)))
    .join("\n");
}

// Group lines by fenced-code state. Joining group texts with "\n" reproduces
// the source exactly.
function fenceGroups(text) {
  const groups = [];
  let fenceChar = "";
  let fenceLen = 0;
  for (const line of text.split("\n")) {
    const m = line.match(FENCE_RE);
    const closes = Boolean(fenceChar) && m && m[1][0] === fenceChar && m[1].length >= fenceLen;
    const opens = !fenceChar && Boolean(m);
    const code = Boolean(fenceChar) || opens;
    const last = groups[groups.length - 1];
    if (last && last.code === code) last.text += "\n" + line;
    else groups.push({ code, text: line });
    if (closes) {
      fenceChar = "";
      fenceLen = 0;
    } else if (opens) {
      fenceChar = m[1][0];
      fenceLen = m[1].length;
    }
  }
  return groups;
}

// Split a plain (non-fenced) region at inline code spans (`...`, ``...`` ...)
// and apply the transform only to the text outside spans. An unclosed backtick
// run is literal text, matching marked's behavior.
function mapInlineAware(text, transform) {
  const parts = [];
  let i = 0;
  let plainStart = 0;
  while (i < text.length) {
    if (text[i] !== "`") {
      i++;
      continue;
    }
    let run = 0;
    while (text[i + run] === "`") run++;
    const close = text.indexOf("`".repeat(run), i + run);
    if (close === -1) {
      i += run;
      continue;
    }
    if (i > plainStart) parts.push(transform(text.slice(plainStart, i)));
    parts.push(text.slice(i, close + run));
    i = close + run;
    plainStart = i;
  }
  if (plainStart < text.length) parts.push(transform(text.slice(plainStart)));
  return parts.join("");
}
