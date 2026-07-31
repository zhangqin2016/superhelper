"use strict";

/**
 * Bounded world-book scan corpus (§10.4.1).
 *
 * Builds the immutable matching corpus for one turn from the admitted
 * canonical message snapshot plus explicitly enabled matching sources
 * (description / personality / scenario / creatorNotes).
 *
 * Determinism and bounding rules (matching policy v1):
 *
 * - Only the newest `scanDepthMessages` canonical messages form the primary
 *   window; when `minActivations > 0` up to `maxDepthMessages` are admitted
 *   and the older ones are flagged `extended` so the resolver can sweep them
 *   progressively. Both windows are hard-capped by limits.maxWindowMessages.
 * - Each message is scanned as an isolated unit, so no pattern can ever match
 *   across a message boundary. When participant names are enabled the
 *   matching copy is prefixed with a stable separator `⟦role:name⟧ ` so name
 *   keys match the participant, never accidental cross-message text.
 * - Every unit carries two matching copies: NFC (case-sensitive class) and
 *   NFC + case-folded (insensitive class). The original text is preserved
 *   untouched on `text`.
 * - Matching-source units are matchable only (insertable === false): they may
 *   produce activation candidates but are NEVER inserted into any prompt.
 * - Everything is bounded by the resolved activation limits; the char budget
 *   keeps the newest messages first and truncation is reported in stats.
 */

const { matchingCopy, resolveActivationLimits } = require("./world-book-matching");

const MATCHING_SOURCE_NAMES = ["description", "personality", "scenario", "creatorNotes"];
const DEFAULT_SCAN_DEPTH_MESSAGES = 8;

function clampInt(value, fallback, maximum) {
  if (!Number.isFinite(Number(value))) return fallback;
  return Math.max(0, Math.min(Math.floor(Number(value)), maximum));
}

/**
 * Messages admitted to the scan window for this policy (§10.4.1). This is
 * also the bounded canonical-message fetch size callers should use when
 * building the corpus — never fetch maxWindowMessages unconditionally.
 */
function resolveScanWindowMessages(scanPolicy, limits) {
  const resolved = resolveActivationLimits(limits);
  const policy = scanPolicy && typeof scanPolicy === "object" ? scanPolicy : {};
  const scanDepth = clampInt(
    policy.scanDepthMessages, DEFAULT_SCAN_DEPTH_MESSAGES, resolved.maxWindowMessages,
  );
  const minActivations = clampInt(policy.minActivations, 0, Number.MAX_SAFE_INTEGER);
  const maxDepth = clampInt(policy.maxDepthMessages, 0, resolved.maxWindowMessages);
  return minActivations > 0
    ? Math.min(Math.max(scanDepth, maxDepth), resolved.maxWindowMessages)
    : scanDepth;
}

// Participant names ride inside the matching frame ⟦role:name⟧ — strip the
// frame characters plus separator/control/format codepoints so a hostile
// name can never forge a message boundary, and bound its length.
const PARTICIPANT_NAME_STRIP = /[\u27e6\u27e7\u001f\p{Cc}\p{Cf}]/gu;
const MAX_PARTICIPANT_NAME_POINTS = 64;

function sanitizeParticipantName(name) {
  const cleaned = String(name).replace(PARTICIPANT_NAME_STRIP, "").trim();
  return [...cleaned].slice(0, MAX_PARTICIPANT_NAME_POINTS).join("");
}

function participantPrefix(role, speakerName, includeNames) {
  const name = includeNames && speakerName ? sanitizeParticipantName(speakerName) : "";
  return name ? `⟦${role}:${name}⟧ ` : `⟦${role}⟧ `;
}

function makeUnit({ kind, scope, seq, insertable, extended, text, prefix }) {
  const matchBase = `${prefix}${text}`;
  return {
    kind,
    scope,
    seq,
    insertable,
    extended,
    text,
    matchTextCs: matchingCopy(matchBase, true),
    matchTextCi: matchingCopy(matchBase, false),
  };
}

/**
 * @param {object} input
 * @param {Array} input.messages canonical messages: {seq, role, speakerName, text}
 * @param {object} input.matchingSources opt-in sources: {description?, personality?, scenario?, creatorNotes?}
 * @param {object} input.scanPolicy normalized (or partial) §7.4 scanPolicy
 * @param {object} input.limits caller budget overrides (only tighten hard limits)
 */
function buildScanCorpus(input = {}) {
  const limits = resolveActivationLimits(input.limits);
  const policy = input.scanPolicy && typeof input.scanPolicy === "object" ? input.scanPolicy : {};
  const scanDepth = clampInt(policy.scanDepthMessages, DEFAULT_SCAN_DEPTH_MESSAGES, limits.maxWindowMessages);
  const includeNames = policy.includeParticipantNames !== false;

  const rawMessages = Array.isArray(input.messages) ? input.messages : [];
  const messages = [];
  let sequenceNow = 0;
  for (const raw of rawMessages) {
    if (!raw || typeof raw !== "object") continue;
    const seq = Number(raw.seq);
    if (!Number.isSafeInteger(seq) || seq < 0) continue;
    const text = typeof raw.text === "string" ? raw.text : "";
    const role = typeof raw.role === "string" && raw.role ? raw.role : "user";
    const speakerName = typeof raw.speakerName === "string" ? raw.speakerName : role;
    messages.push({ seq, role, speakerName, text });
    if (seq > sequenceNow) sequenceNow = seq;
  }
  // Canonical order is ascending sequence; sort defensively (stable) so a
  // misordered caller cannot change the scan window.
  messages.sort((a, b) => a.seq - b.seq);

  const windowSize = resolveScanWindowMessages(policy, input.limits);
  const primaryStart = Math.max(0, messages.length - scanDepth);
  const windowStart = Math.max(0, messages.length - windowSize);

  const units = [];
  let corpusChars = 0;
  let truncated = false;
  // Newest-first char budgeting: older messages lose the budget race.
  const admitted = new Set();
  for (let index = messages.length - 1; index >= windowStart; index -= 1) {
    const message = messages[index];
    const prefix = participantPrefix(message.role, message.speakerName, includeNames);
    const chars = [...prefix].length + [...message.text].length;
    if (corpusChars + chars > limits.maxCorpusChars) {
      truncated = true;
      continue;
    }
    corpusChars += chars;
    admitted.add(index);
  }
  if (windowStart > 0) truncated = true;

  for (let index = windowStart; index < messages.length; index += 1) {
    if (!admitted.has(index)) continue;
    const message = messages[index];
    units.push(makeUnit({
      kind: "message",
      scope: "chat",
      seq: message.seq,
      insertable: true,
      extended: index < primaryStart,
      text: message.text,
      prefix: participantPrefix(message.role, message.speakerName, includeNames),
    }));
  }
  const primaryUnitCount = units.filter((unit) => !unit.extended).length;

  const sources = input.matchingSources && typeof input.matchingSources === "object"
    ? input.matchingSources
    : {};
  const sourceUnits = [];
  for (const name of MATCHING_SOURCE_NAMES) {
    const value = sources[name];
    if (typeof value !== "string" || !value) continue;
    let text = value;
    if ([...text].length > limits.maxSourceChars) {
      text = [...text].slice(0, limits.maxSourceChars).join("");
      truncated = true;
    }
    const chars = [...text].length;
    if (corpusChars + chars > limits.maxCorpusChars) {
      truncated = true;
      continue;
    }
    corpusChars += chars;
    sourceUnits.push(makeUnit({
      kind: "source",
      scope: name,
      seq: null,
      insertable: false,
      extended: false,
      text,
      prefix: "",
    }));
  }

  return {
    units: [...units, ...sourceUnits],
    // Index (into units) of the first primary-window message unit; message
    // units before it are extended sweep-only units. Source units always
    // belong to the primary scan.
    primaryMessageStart: units.length - primaryUnitCount,
    messageUnitCount: units.length,
    stats: {
      messagesProvided: messages.length,
      messagesIncluded: units.length,
      primaryMessages: primaryUnitCount,
      extendedMessages: units.length - primaryUnitCount,
      sourcesIncluded: sourceUnits.length,
      corpusChars,
      truncated,
      sequenceNow,
    },
  };
}

module.exports = {
  buildScanCorpus,
  resolveScanWindowMessages,
  sanitizeParticipantName,
  MATCHING_SOURCE_NAMES,
};
