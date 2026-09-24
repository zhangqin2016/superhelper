/**
 * A turn record keeps every tool call twice: once in `record.tools`, once
 * inside the matching `record.timeline` entry. Measured 2026-09-24 over 200
 * real records: 5,265 of 5,272 timeline tool entries carried an input, and
 * 5,264 a result, identical to their `record.tools` twin — 67% of all timeline
 * bytes. That duplication is why the timeline was capped at its last 100
 * entries, and the cap is why a long turn reopened without its first steps
 * (29% of records with a timeline had hit it).
 *
 * Stored and sent, a timeline tool entry refers to its tool instead of copying
 * it; read, it is whole again. Lossless by construction: a field is dropped
 * only when it is exactly equal to the tool's own, and the entry names which
 * fields it dropped. An entry whose data differs — or whose tool is missing —
 * is kept as it is.
 *
 * ESM so the renderer can `import` it; the main process `require()`s it.
 */

const HEAVY_FIELDS = Object.freeze(["input", "result", "metadata"]);
const REF_KEY = "toolRef";

function same(a, b) {
  if (a === b) return true;
  if (a === undefined || b === undefined) return false;
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}

function toolsById(record) {
  const map = new Map();
  for (const tool of Array.isArray(record?.tools) ? record.tools : []) {
    if (tool && typeof tool === "object" && tool.id != null) map.set(String(tool.id), tool);
  }
  return map;
}

/** A copy of `record` whose timeline tool entries refer to `record.tools`. */
export function dehydrateTimelineTools(record) {
  if (!record || typeof record !== "object" || !Array.isArray(record.timeline) || !record.timeline.length) return record;
  const tools = toolsById(record);
  if (!tools.size) return record;
  let changed = false;
  const timeline = record.timeline.map((entry) => {
    if (entry?.kind !== "tool" || entry[REF_KEY] || entry.id == null) return entry;
    const tool = tools.get(String(entry.id));
    if (!tool) return entry;
    const dropped = HEAVY_FIELDS.filter((field) => field in entry && same(entry[field], tool[field]));
    if (!dropped.length) return entry;
    changed = true;
    const next = { ...entry, [REF_KEY]: dropped };
    for (const field of dropped) delete next[field];
    return next;
  });
  return changed ? { ...record, timeline } : record;
}

/** A copy of `record` whose timeline tool entries carry their tool's data again. */
export function rehydrateTimelineTools(record) {
  if (!record || typeof record !== "object" || !Array.isArray(record.timeline)) return record;
  if (!record.timeline.some((entry) => Array.isArray(entry?.[REF_KEY]))) return record;
  const tools = toolsById(record);
  const timeline = record.timeline.map((entry) => {
    const dropped = entry?.[REF_KEY];
    if (!Array.isArray(dropped)) return entry;
    const tool = tools.get(String(entry.id));
    const next = { ...entry };
    delete next[REF_KEY];
    if (tool) for (const field of dropped) if (field in tool) next[field] = tool[field];
    return next;
  });
  return { ...record, timeline };
}

/** The same, for a stored/sent message envelope. */
export function dehydrateMessage(message) {
  if (!message?.record) return message;
  const record = dehydrateTimelineTools(message.record);
  return record === message.record ? message : { ...message, record };
}

export function rehydrateMessage(message) {
  if (!message?.record) return message;
  const record = rehydrateTimelineTools(message.record);
  return record === message.record ? message : { ...message, record };
}
