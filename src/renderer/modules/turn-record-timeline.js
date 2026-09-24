import { rehydrateTimelineTools } from "../../shared/timeline-tool-refs.mjs";

/**
 * Rebuild just enough timeline for a reloaded turn to look like the live one.
 *
 * Separating "the answer" from "the narration written while working" is a
 * property of the in-memory timeline: the last text block is the answer, every
 * earlier one belongs in the process area. Persistence drops the timeline, so a
 * reloaded turn showed the whole concatenated stream — narration, the blank runs
 * left where tool cards had been, and the answer — as one wall of text in the
 * answer slot. It read as the assistant carrying on talking after it finished.
 *
 * The record now carries the answer text, which is the only boundary needed:
 * everything before it is narration. Two entries reproduce the live layout at
 * the cost of one stored string.
 *
 * [gate: answer-survives-reload]
 */

// Blank runs are an artefact of tool cards being removed from between the text,
// not something the model wrote. They are collapsed in the NARRATION only — the
// answer is passed through byte-identical, because its formatting is the
// model's own and other parts of the renderer depend on that.
const BLANK_RUN = /\n{3,}/g;

export function timelineFromRecord(stored = {}) {
  // Tool entries arrive as references to record.tools; make them whole.
  const record = rehydrateTimelineTools(stored) || {};
  const existing = Array.isArray(record?.timeline) ? record.timeline : [];
  if (existing.length) return existing;

  const answer = String(record?.answerText || "").trim();
  if (!answer) return [];

  const full = String(record?.assistantText || "");
  const boundary = full.lastIndexOf(answer);
  const narration = boundary > 0
    ? full.slice(0, boundary).replace(BLANK_RUN, "\n\n").trim()
    : "";

  const entries = [];
  if (narration) entries.push({ kind: "text", text: narration });
  entries.push({ kind: "text", text: answer });
  return entries;
}
