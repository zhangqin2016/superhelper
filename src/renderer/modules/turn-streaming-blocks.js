function ensureTimeline(target) {
  if (!Array.isArray(target.timeline)) target.timeline = [];
  return target.timeline;
}

function lastThinkingEntry(timeline) {
  for (let index = timeline.length - 1; index >= 0; index -= 1) {
    if (timeline[index]?.kind === "thinking") return timeline[index];
  }
  return null;
}

// Thinking blocks interleave with tool blocks (think -> act -> think again).
// Deltas append to the latest still-streaming thinking block; tool entries and
// explicit closes seal it so the next delta starts a new block. Notices do not
// split a block: they are out-of-band, not content blocks.
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

// Assistant prose is a content block like any other: a text delta seals the
// open thinking block, and a later thinking/tool block seals the text block,
// so the timeline keeps the think -> act -> answer order.
export function appendTimelineText(target, text, ts = Date.now()) {
  const piece = String(text || "");
  if (!piece) return;
  closeStreamingBlocks(target, ts, ["thinking"]);
  const timeline = ensureTimeline(target);
  const last = timeline[timeline.length - 1];
  if (last?.kind === "text" && last.status === "streaming") {
    last.text = `${last.text || ""}${piece}`;
    last.ts = ts;
    return;
  }
  const count = timeline.filter((entry) => entry.kind === "text").length;
  timeline.push({
    kind: "text",
    id: `text_${count + 1}`,
    ts,
    text: piece,
    status: "streaming",
  });
}
