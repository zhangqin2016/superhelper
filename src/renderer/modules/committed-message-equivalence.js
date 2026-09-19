// When are two committed messages the SAME message?
//
// Every merge of conversation history — a session switch, an official refresh,
// an older page, a late user.committed — asks this for each incoming message
// against everything already cached. The predicates are deliberately fuzzy
// (the rich Lily copy and the official engine copy of one turn share no key and
// only nearly-identical text), and fuzzy text comparison is expensive: before
// 2026-09-19 each pair re-normalised both texts with three regex passes, so a
// switch into a session with 359 cached messages spent 565 ms of the renderer
// thread in this file (CPU profile) — the "switching sessions is slow" a
// customer reported with a thousand-message conversation.
//
// Two rules keep the cost proportional to the answer, not to the history:
//   1. Text facets are derived once per message object, validated against the
//      fields they were derived from, so a mutated message is never mis-read.
//   2. The cheap gate runs first. Every text match also requires timestamps
//      within 30 minutes, so the window is checked before any text is touched.
// The predicates themselves are unchanged: same inputs, same answers.

const WINDOW_MS = 30 * 60 * 1000;

function normalizeText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function timestampMs(value) {
  const parsed = Date.parse(value || "");
  return Number.isFinite(parsed) ? parsed : null;
}

/** @type {WeakMap<object, ReturnType<typeof deriveFacets>>} */
const facetCache = new WeakMap();

function deriveFacets(message) {
  const content = message.content;
  const text = message.text;
  const assistantText = message.record?.assistantText;
  const normalized = normalizeText(content || text || "");
  const comparable = normalizeText(content || text || assistantText || "");
  return {
    // What the facets were derived from — a message edited in place is re-derived.
    content, text, assistantText, timestamp: message.timestamp, meta: message.meta, record: message.record,
    turnId: message.turnId, role: message.role, id: message.id, steer: message.steer,
    normalized,
    compact: comparable.replace(/\s+/g, ""),
    ts: timestampMs(message.timestamp),
    key: undefined,
    draft: undefined,
  };
}

function facetsOf(message) {
  if (!message || typeof message !== "object") return deriveFacets({});
  const cached = facetCache.get(message);
  if (
    cached
    && cached.content === message.content && cached.text === message.text
    && cached.assistantText === message.record?.assistantText && cached.timestamp === message.timestamp
    && cached.meta === message.meta && cached.record === message.record
    && cached.turnId === message.turnId && cached.role === message.role && cached.id === message.id
    && cached.steer === message.steer
  ) return cached;
  const facets = deriveFacets(message);
  facetCache.set(message, facets);
  return facets;
}

export function normalizedMessageText(message = {}) {
  return facetsOf(message).normalized;
}

export function committedMessageKey(message) {
  return keyOf(message || {}, facetsOf(message));
}

function keyOf(message, facets) {
  if (facets.key === undefined) facets.key = deriveKey(message, facets);
  return facets.key;
}

function deriveKey(message, facets) {
  if (message?.turnId && message?.role) {
    // A steered ("插话") message is a SECOND user message inside the same turn — it
    // must not collide with (and overwrite) the turn's original user bubble, so key
    // it by its per-turn steer sequence. The marker rides top-level (live) or meta
    // (reloaded from the store).
    const isSteer = message.steer || message.meta?.steer;
    if (isSteer) {
      const seq = message.steerSeq ?? message.meta?.steerSeq ?? facets.normalized;
      return `turn:${message.role}:${message.turnId}:steer:${seq}`;
    }
    return `turn:${message.role}:${message.turnId}`;
  }
  if (message?.id) return `id:${message.id}`;
  return ["fallback", message?.role || "", message?.timestamp || "", message?.content || ""].join(":");
}

function draftOf(message, facets) {
  if (facets.draft === undefined) facets.draft = deriveDraftSignature(message || {});
  return facets.draft;
}

function deriveDraftSignature(message) {
  const scheduledDraft = message.meta?.scheduledDraft || message.record?.meta?.scheduledDraft || null;
  if (!scheduledDraft) return null;
  const draft = scheduledDraft.draft && typeof scheduledDraft.draft === "object"
    ? scheduledDraft.draft
    : scheduledDraft;
  const signature = {
    originalText: normalizeText(scheduledDraft.originalText || draft.originalText || ""),
    title: normalizeText(scheduledDraft.prompt || scheduledDraft.title || draft.prompt || draft.title || ""),
    scheduleText: normalizeText(scheduledDraft.scheduleText || scheduledDraft.summary || draft.scheduleText || draft.summary || ""),
    rrule: normalizeText(scheduledDraft.rrule || draft.rrule || ""),
  };
  signature.fingerprint = ["scheduledDraft", signature.originalText, signature.title, signature.scheduleText, signature.rrule].join(":");
  return signature;
}

function scheduledDraftsMatch(left, right) {
  if (!left || !right) return false;
  if (left.originalText && right.originalText && left.originalText !== right.originalText) return false;
  if (!left.title || !right.title || left.title !== right.title) return false;
  if (left.scheduleText && right.scheduleText && left.scheduleText !== right.scheduleText) return false;
  if (left.rrule && right.rrule && left.rrule !== right.rrule) return false;
  return Boolean(left.originalText || right.originalText || left.scheduleText || right.scheduleText || left.rrule || right.rrule);
}

function withinWindow(a, b, windowMs) {
  return Number.isFinite(a.ts) && Number.isFinite(b.ts) && Math.abs(a.ts - b.ts) <= windowMs;
}

function sameContentWithinWindow(a, b, fa, fb, windowMs = WINDOW_MS) {
  if (a.role !== b.role) return false;
  if (!withinWindow(fa, fb, windowMs)) return false;
  return Boolean(fa.normalized && fb.normalized && fa.normalized === fb.normalized);
}

function isProjectionLikeMessage(message = {}) {
  const id = String(message.id || "");
  return Boolean(
    id.startsWith("projection:") ||
      message.meta?.projected ||
      message.record?.meta?.projected ||
      message.meta?.displaySource === "lily-raw-user"
  );
}

function isLikelyProjectionDuplicate(a, b, fa, fb) {
  if (a.role !== "user" || b.role !== "user") return false;
  if (a.steer || a.meta?.steer || b.steer || b.meta?.steer) return false;
  if (!sameContentWithinWindow(a, b, fa, fb)) return false;
  return Boolean(
    isProjectionLikeMessage(a) ||
      isProjectionLikeMessage(b) ||
      Boolean(a.turnId) !== Boolean(b.turnId)
  );
}

// A rich committed turn (loaded local-first) and the official refresh copy of the
// SAME turn rarely have byte-identical text: the rich record keeps its answer in
// record.assistantText, prepends a ✓ step summary / appends report sections, and
// whitespace differs (CJK "问题。 定位" vs "问题。定位"); they share no key. So
// compare with ALL whitespace removed and accept equal, one-contains-the-other,
// OR a long shared prefix (tolerates mid/tail divergence). The length guard keeps
// short, genuinely-different replies from over-merging.
export function assistantTextEquivalent(a, b) {
  const sa = String(a || "").replace(/\s+/g, "");
  const sb = String(b || "").replace(/\s+/g, "");
  return compactTextEquivalent(sa, sb);
}

function compactTextEquivalent(sa, sb) {
  if (!sa || !sb) return false;
  if (sa === sb) return true;
  const shorter = sa.length <= sb.length ? sa : sb;
  const longer = sa.length <= sb.length ? sb : sa;
  if (shorter.length < 80) return false;
  if (longer.includes(shorter)) return true;
  let k = 0;
  while (k < shorter.length && shorter.charCodeAt(k) === longer.charCodeAt(k)) k += 1;
  return k >= 80;
}

function sameAssistantTurnWithinWindow(a, b, fa, fb, windowMs = WINDOW_MS) {
  if (a.role !== "assistant" || b.role !== "assistant") return false;
  if (!withinWindow(fa, fb, windowMs)) return false;
  return compactTextEquivalent(fa.compact, fb.compact);
}

/** Index of the cached message `message` is the same as, or -1. First match wins, in this order. */
export function equivalentCommittedMessageIndex(messages, message) {
  const fm = facetsOf(message);
  const key = keyOf(message || {}, fm);
  const draft = draftOf(message, fm);
  for (let i = 0; i < messages.length; i += 1) {
    const existing = messages[i];
    const fe = facetsOf(existing);
    if (keyOf(existing || {}, fe) === key) return i;
    const existingDraft = draftOf(existing, fe);
    if (scheduledDraftsMatch(existingDraft, draft)) return i;
    if (draft && existingDraft?.fingerprint === draft.fingerprint) return i;
    if (isLikelyProjectionDuplicate(existing || {}, message || {}, fe, fm)) return i;
    if (sameAssistantTurnWithinWindow(existing || {}, message || {}, fe, fm)) return i;
  }
  return -1;
}
