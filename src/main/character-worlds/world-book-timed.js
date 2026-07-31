"use strict";

/**
 * Timed-effect checkpoint computation (§10.4.6) — pure half.
 *
 * All effects are measured in canonical message sequence numbers, never wall
 * time. The resolver only computes the next checkpoint; durable persistence
 * after successful turn finalization is WB-4's concern.
 *
 * Semantics (matching policy v1, documented and pinned):
 *
 * - sticky: an activated entry with stickyMessages = s writes
 *   untilSeq = activationSeq + s. While sequenceNow <= untilSeq the entry
 *   activates WITHOUT a key match. A running sticky is never refreshed by
 *   consequent matches: its untilSeq is carried verbatim.
 * - cooldown: an activated entry with cooldownMessages = c writes
 *   untilSeq = activationSeq + c. While sequenceNow <= untilSeq the entry
 *   cannot activate. Cooldowns of entries that did not activate carry over
 *   until they expire.
 * - delay: a matched entry with delayMessages = d does not activate; it is
 *   recorded as {entryId, matchedSeq}. Once sequenceNow - matchedSeq >= d the
 *   pending match activates (route delay_due), with no fresh key match
 *   required. Consequent matches never refresh matchedSeq. A pending delay
 *   that becomes due but fails activation for a TRANSIENT reason
 *   (probability, group conflict, entry/token budget) is re-pended with its
 *   original matchedSeq; one blocked by a CONTEXTUAL gate (character filter,
 *   generation filter, cooldown) is dropped — the effect is tied to a match
 *   that no longer fits the binding.
 *
 * Checkpoint lists are sorted by entryId and bounded, so the persisted shape
 * is byte-deterministic for identical inputs.
 *
 * - stateful match (§10.4.7, V3 @@keep_activate_after_match /
 *   @@dont_activate_after_match): the `matched` list records entry ids that
 *   activated at least once. A `keep` entry on the list activates on later
 *   turns without a key match (route stateful); a `suppress` entry on the
 *   list can never activate again. The list is carried verbatim across turns
 *   and only rewinds/checkpoint invalidation clear it.
 */

function clampSeq(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function sanitizeEntryList(raw, seqKey, maximum) {
  if (!Array.isArray(raw)) return { list: [], dropped: 0 };
  const normalized = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    if (typeof item.entryId !== "string" || !item.entryId) continue;
    normalized.push({ entryId: item.entryId, [seqKey]: clampSeq(item[seqKey]) });
  }
  // Deterministic intake: sort before dedupe/truncation so the surviving set
  // never depends on the persisted array order.
  normalized.sort((a, b) => (
    a.entryId < b.entryId ? -1 : a.entryId > b.entryId ? 1 : a[seqKey] - b[seqKey]
  ));
  const seen = new Set();
  const list = [];
  for (const item of normalized) {
    if (seen.has(item.entryId)) continue;
    seen.add(item.entryId);
    list.push(item);
  }
  const dropped = Math.max(0, list.length - maximum);
  return { list: list.slice(0, maximum), dropped };
}

// Intake is capped at `maximum` entries per list (same order of magnitude as
// the outgoing checkpoint); oversized intakes are truncated deterministically
// and the dropped count is returned for the trace.
function sanitizeCheckpoint(raw, maximum = 4096) {
  const source = raw && typeof raw === "object" ? raw : {};
  const sticky = sanitizeEntryList(source.sticky, "untilSeq", maximum);
  const cooldown = sanitizeEntryList(source.cooldown, "untilSeq", maximum);
  const delay = sanitizeEntryList(source.delay, "matchedSeq", maximum);
  const matched = sanitizeIdList(source.matched, maximum);
  return {
    checkpoint: {
      sticky: sticky.list, cooldown: cooldown.list, delay: delay.list,
      matched: matched.list,
    },
    dropped: sticky.dropped + cooldown.dropped + delay.dropped + matched.dropped,
  };
}

// Stateful-match ids carry no sequence numbers: dedupe + sort + bound.
function sanitizeIdList(raw, maximum) {
  if (!Array.isArray(raw)) return { list: [], dropped: 0 };
  const ids = new Set();
  for (const item of raw) {
    if (item && typeof item === "object" && typeof item.entryId === "string" && item.entryId) {
      ids.add(item.entryId);
    }
  }
  const sorted = [...ids].sort();
  const dropped = Math.max(0, sorted.length - maximum);
  return { list: sorted.slice(0, maximum).map((entryId) => ({ entryId })), dropped };
}

function sortAndBound(list, maximum) {
  list.sort((a, b) => (a.entryId < b.entryId ? -1 : a.entryId > b.entryId ? 1 : 0));
  return list.slice(0, maximum);
}

/**
 * @param {object} input
 * @param {object} input.previous sanitized previous checkpoint
 * @param {Array}  input.selected final selection: [{entryId, stickyMessages,
 *   cooldownMessages, carriedStickyUntilSeq (number|null), statefulMatch}]
 * @param {Array}  input.pendingDelay delays still pending: [{entryId, matchedSeq}]
 * @param {number} input.sequenceNow current canonical sequence boundary
 * @param {number} input.maxTimedEntries hard cap per list
 */
function computeNextCheckpoint(input) {
  const sequenceNow = clampSeq(input.sequenceNow);
  const maximum = input.maxTimedEntries;
  const selectedById = new Map(input.selected.map((entry) => [entry.entryId, entry]));

  const sticky = [];
  for (const entry of input.selected) {
    if (entry.stickyMessages > 0) {
      sticky.push({
        entryId: entry.entryId,
        // Running effects are never refreshed by consequent matches.
        untilSeq: entry.carriedStickyUntilSeq ?? sequenceNow + entry.stickyMessages,
      });
    }
  }
  // Unexpired sticky for entries filtered out this turn keeps running.
  for (const carried of input.previous.sticky) {
    if (selectedById.has(carried.entryId)) continue;
    if (carried.untilSeq >= sequenceNow) sticky.push(carried);
  }

  const cooldown = [];
  for (const entry of input.selected) {
    if (entry.cooldownMessages > 0) {
      cooldown.push({ entryId: entry.entryId, untilSeq: sequenceNow + entry.cooldownMessages });
    }
  }
  for (const carried of input.previous.cooldown) {
    if (selectedById.has(carried.entryId)) continue;
    if (carried.untilSeq >= sequenceNow) cooldown.push(carried);
  }

  const matched = new Set(input.previous.matched.map((item) => item.entryId));
  for (const entry of input.selected) {
    if (entry.statefulMatch === "keep" || entry.statefulMatch === "suppress") {
      matched.add(entry.entryId);
    }
  }

  return {
    sticky: sortAndBound(sticky, maximum),
    cooldown: sortAndBound(cooldown, maximum),
    delay: sortAndBound(
      input.pendingDelay.map(({ entryId, matchedSeq }) => ({ entryId, matchedSeq })),
      maximum,
    ),
    matched: sortAndBound([...matched].map((entryId) => ({ entryId })), maximum),
  };
}

module.exports = {
  sanitizeCheckpoint,
  computeNextCheckpoint,
};
