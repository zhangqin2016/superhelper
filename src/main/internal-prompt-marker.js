"use strict";

/**
 * Prompts the platform sends to itself, marked at the point they are written.
 *
 * Some turns are not the user's: a compaction hand-off, a todo-continuity check,
 * a recovery re-ask. They reach the engine as user messages, and the model
 * answers them, so the conversation has to know which ones were never the
 * user's doing.
 *
 * That knowledge used to be a hard-coded English sentence — one entry in a Set.
 * The platform then added a second internal prompt of its own and could not
 * recognise it, so the question AND the model's answer to it both landed in the
 * conversation. Field case 2026-09-17: a finished task was followed by
 * "Task continuity check: the native todo list still has unfinished todo items",
 * and the answer to it read as the assistant carrying on by itself.
 *
 * Matching prose cannot hold: every new internal prompt, every reworded one, and
 * every translation leaks. So the prompt is TAGGED where it is built, and
 * recognised by that tag. The tag travels with the text, which is what makes it
 * work after a reload.
 *
 * The KIND matters as much as the tag, because the two cases want opposite
 * treatment:
 *   self_check — the platform nudging itself. The answer is scaffolding, and the
 *                whole turn is hidden.
 *   recovery   — the platform re-asking for work that was lost. The answer is
 *                the real deliverable: hide the question, KEEP the answer.
 *
 * [gate: internal-prompt-provenance]
 */

const MARKER_RE = /<lily_internal_prompt\s+kind="([a-z_]+)"\s*\/>/;

const INTERNAL_PROMPT_KINDS = Object.freeze({
  SELF_CHECK: "self_check",
  RECOVERY: "recovery",
});

const KIND_VALUES = new Set(Object.values(INTERNAL_PROMPT_KINDS));

/** Tag a prompt the platform is sending to itself. Returns the text to send. */
function markInternalPrompt(text, kind = INTERNAL_PROMPT_KINDS.SELF_CHECK) {
  const body = String(text ?? "");
  const safeKind = KIND_VALUES.has(kind) ? kind : INTERNAL_PROMPT_KINDS.SELF_CHECK;
  if (internalPromptKind(body)) return body;
  return `<lily_internal_prompt kind="${safeKind}"/>\n${body}`;
}

/** The kind this text was tagged with, or "" when it carries no tag. */
function internalPromptKind(text) {
  const match = MARKER_RE.exec(String(text ?? ""));
  if (!match) return "";
  return KIND_VALUES.has(match[1]) ? match[1] : INTERNAL_PROMPT_KINDS.SELF_CHECK;
}

/** True when the platform, not the user, wrote this. */
function isMarkedInternalPrompt(text) {
  return Boolean(internalPromptKind(text));
}

/**
 * True when the whole turn — the prompt AND the answer to it — should stay out
 * of the conversation. Only a self-check qualifies: a recovery answer is the
 * work the user asked for and must survive.
 */
function isSelfCheckPrompt(text) {
  return internalPromptKind(text) === INTERNAL_PROMPT_KINDS.SELF_CHECK;
}

/** The text without its tag, for anything that displays or compares it. */
function stripInternalPromptMarker(text) {
  return String(text ?? "").replace(MARKER_RE, "").replace(/^\n+/, "");
}

// Recognition for turns persisted BEFORE prompts carried a tag. A prefix, not a
// whole sentence, because these prompts embed live counters. New internal
// prompts must NOT be added here — tag them where they are built, or the next
// reworded one leaks again.
const LEGACY_SELF_CHECK_EXACT = new Set([
  "continue if you have next steps, or stop and ask for clarification if you are unsure how to proceed.",
]);

const LEGACY_SELF_CHECK_PREFIXES = [
  "task continuity check: the native todo list still has unfinished todo items.",
];

function normalizedPromptText(value) {
  return String(value || "").replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * A prompt the platform sent to itself whose ANSWER is scaffolding too, so the
 * whole turn stays out of the conversation. The tag is the real test; the legacy
 * rules only reach history written before it existed. A recovery prompt is
 * deliberately excluded — its answer is the work the user asked for.
 */
function isSelfCheckPromptText(text) {
  if (isSelfCheckPrompt(text)) return true;
  const normalized = normalizedPromptText(text);
  if (LEGACY_SELF_CHECK_EXACT.has(normalized)) return true;
  return LEGACY_SELF_CHECK_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

module.exports = {
  INTERNAL_PROMPT_KINDS,
  MARKER_RE,
  internalPromptKind,
  isMarkedInternalPrompt,
  isSelfCheckPrompt,
  isSelfCheckPromptText,
  markInternalPrompt,
  stripInternalPromptMarker,
};
