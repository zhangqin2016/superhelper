/**
 * How a turn's streamed output becomes content blocks — the ONE model, for
 * both processes.
 *
 * The main process (which archives the turn) and the renderer (which draws it
 * live) each kept an identical copy of these rules, and every consumer that
 * needed "which block is the answer" wrote its own scan — three of them, one
 * commented "mirrors lastTimelineText in the renderer". Copies that must agree
 * are copies that eventually do not, and a turn then archives one shape and
 * renders another.
 *
 * Two rules live here, and nowhere else:
 *
 *   1. A text block begins at its first visible character. Between tool calls
 *      the model emits bare line breaks; with no block open they are the
 *      separator between blocks, not content. Measured 2026-09-23 on a
 *      396-tool turn: 28 of its 35 stored text blocks were nothing but "\n",
 *      each one a sealed entry occupying the bounded archive window and
 *      displacing real tool history from it. Whitespace INSIDE an open block is
 *      the model's own formatting and is kept byte-for-byte.
 *
 *   2. The answer is the last block with visible text. A blank trailing block
 *      used to be taken as the answer, which showed the real answer a second
 *      time among the narration and archived an empty answer for reload.
 *
 * ESM so the renderer can `import` it; the main process `require()`s it
 * (Node ≥ 22.12 loads ESM from CommonJS).
 */

export function ensureTimeline(target) {
  if (!Array.isArray(target.timeline)) target.timeline = [];
  return target.timeline;
}

export function hasVisibleText(text) {
  return /\S/.test(String(text || ""));
}

function lastThinkingEntry(timeline) {
  for (let index = timeline.length - 1; index >= 0; index -= 1) {
    if (timeline[index]?.kind === "thinking") return timeline[index];
  }
  return null;
}

// Seals are monotone: blocks only stream at the tail, so walking backward we
// can stop at the first already-sealed thinking/text entry. This keeps the
// per-delta cost O(1) instead of O(timeline) (caught by bench-replay).
export function closeStreamingBlocks(target, ts = Date.now(), kinds = ["thinking", "text"]) {
  if (!Array.isArray(target?.timeline)) return;
  for (let index = target.timeline.length - 1; index >= 0; index -= 1) {
    const entry = target.timeline[index];
    if (entry?.kind !== "thinking" && entry?.kind !== "text") continue;
    if (entry.status !== "streaming") return;
    if (kinds.includes(entry.kind)) {
      entry.status = "done";
      entry.ts = ts;
    }
  }
}

export function closeOpenThinkingBlocks(target, ts = Date.now()) {
  closeStreamingBlocks(target, ts, ["thinking"]);
}

// Thinking blocks interleave with tool blocks (think → act → think again).
// Deltas append to the latest still-streaming thinking block; tool entries and
// explicit closes seal it so the next delta starts a new block. Notices do not
// split a block — they are out-of-band, not content blocks.
export function upsertTimelineThinking(target, text, ts = Date.now()) {
  const piece = String(text || "");
  if (!piece) return;
  closeStreamingBlocks(target, ts, ["text"]);
  const timeline = ensureTimeline(target);
  const existing = lastThinkingEntry(timeline);
  if (existing && existing.status === "streaming") {
    existing.text = `${existing.text || ""}${piece}`;
    existing.ts = ts;
    return;
  }
  const count = timeline.filter((entry) => entry.kind === "thinking").length;
  timeline.push({
    kind: "thinking",
    id: `think_${count + 1}`,
    ts,
    startTs: ts,
    text: piece,
    collapsed: true,
    status: "streaming",
  });
}

// Assistant prose is a content block like any other: a text delta seals the
// open thinking block, and a later thinking/tool block seals the text block,
// so the timeline keeps the think → act → answer order.
export function appendTimelineText(target, text, ts = Date.now()) {
  const piece = String(text || "");
  if (!piece) return;
  const timeline = ensureTimeline(target);
  const last = timeline[timeline.length - 1];
  if (last?.kind === "text" && last.status === "streaming") {
    last.text = `${last.text || ""}${piece}`;
    last.ts = ts;
    return;
  }
  // Rule 1: no block is open, so this starts one — at its first visible
  // character. A separator alone starts nothing, and seals nothing either:
  // a line break between two thoughts does not end the thinking.
  const opening = piece.replace(/^\s+/, "");
  if (!opening) return;
  closeStreamingBlocks(target, ts, ["thinking"]);
  const count = timeline.filter((entry) => entry.kind === "text").length;
  timeline.push({
    kind: "text",
    id: `text_${count + 1}`,
    ts,
    text: opening,
    status: "streaming",
  });
}

/** Rule 2: index of the answer block — the last text block with visible
 *  text — or -1 when the turn has none. */
export function answerBlockIndex(timeline) {
  const entries = Array.isArray(timeline) ? timeline : [];
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry?.kind === "text" && hasVisibleText(entry.text)) return index;
  }
  return -1;
}

/** The answer block's text, trimmed, or null when the turn has none. */
export function answerBlockText(timeline) {
  const index = answerBlockIndex(timeline);
  return index < 0 ? null : String(timeline[index].text || "").trim();
}
