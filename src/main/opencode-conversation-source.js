"use strict";

const { extractUserOriginalRequest, hasLayeredEngineText } = require("./engine-message-layers");
const { isInternalRecoveryPromptText } = require("./turn-recovery-context");
function metadataKey(message = {}) {
  return message.engineMessageId || message.record?.engineMessageId || message.id || "";
}

const USER_TIME_MATCH_WINDOW_MS = 10 * 60 * 1000;
const PROJECTION_TIME_MATCH_WINDOW_MS = 30 * 60 * 1000;
const INJECTED_USER_PROMPT_MARKERS = [
  "# 智能工作台全局说明",
  "## 身份问答（必读）",
  "不要自称 Claude、Claude Code 或 Anthropic 产品",
  "[Session Resume Notice]",
  "[Task Contract]",
  "LILY_TASK_CONTRACT",
];

const INTERNAL_ONLY_USER_PROMPTS = new Set([
  "continue if you have next steps, or stop and ask for clarification if you are unsure how to proceed.",
]);
function timestampMs(value) {
  const parsed = Date.parse(value || "");
  return Number.isFinite(parsed) ? parsed : null;
}

// After an AUTO compaction, opencode injects a synthetic user turn ("Continue if
// you have next steps, or stop and ask…") and the model answers it — a junk turn
// (a status-report scaffold / "task done, anything else?"). We already HIDE that
// internal user prompt, but its assistant answer was left orphaned in the
// conversation. Drop the whole internal-continue turn: the internal user prompt
// PLUS the assistant response(s) that follow it before the next real user turn.
// (Disabling autocontinue stops NEW ones; this also cleans the ones already
// persisted in a session's history.)
// The internal state-tracking / handoff SCAFFOLD ("Objective / Work State /
// Completed / Active / Blocked / Next Move / Relevant Files" etc.). The model is
// told never to emit it as an answer, but weak models sometimes dump it verbatim
// on a resume/rehydrate — it is internal tracking, never a user-facing reply. We
// require several distinct headers to co-occur so a normal answer that happens to
// use one of these words is never hidden.
const SCAFFOLD_HEADERS = [
  "objective", "important details", "work state", "completed", "active",
  "blocked", "next move", "relevant files", "key decisions", "next steps",
];
function looksLikeStatusReportScaffolding(text) {
  const t = normalizedText(text).toLowerCase();
  if (!t) return false;
  let hits = 0;
  for (const h of SCAFFOLD_HEADERS) {
    if (t.includes(h) && (hits += 1) >= 4) return true;
  }
  return false;
}

function stripInternalContinuationTurns(conversation = []) {
  const list = Array.isArray(conversation) ? conversation.slice() : [];
  list.sort((a, b) => (timestampMs(a?.timestamp) ?? 0) - (timestampMs(b?.timestamp) ?? 0));
  const drop = new Set();
  for (let i = 0; i < list.length; i += 1) {
    const m = list[i];
    // (a) an assistant turn whose content IS the internal status-report scaffold
    // — never a valid answer, hide it whatever triggered it (resume rehydrate,
    // auto-continue, etc.).
    if (m?.role === "assistant" && looksLikeStatusReportScaffolding(messageText(m))) {
      drop.add(m);
      continue;
    }
    // (b) the internal auto-continue turn: the "Continue if you have next steps…"
    // prompt PLUS the assistant response(s) before the next real user turn.
    if (m?.role !== "user" || !isInternalOnlyUserPromptText(messageText(m))) continue;
    drop.add(m);
    const turnId = m.turnId || "";
    for (let j = i + 1; j < list.length; j += 1) {
      const n = list[j];
      if (n?.role === "user") break; // the next real turn starts here
      if (n?.role === "assistant" && (!turnId || !n.turnId || n.turnId === turnId)) drop.add(n);
    }
  }
  if (!drop.size) return Array.isArray(conversation) ? conversation : [];
  return (Array.isArray(conversation) ? conversation : []).filter((m) => !drop.has(m));
}

function messageText(message = {}) {
  // Fall back to the record's assistant text: a rich assistant turn can carry an
  // empty top-level `content` while its answer lives in `record.assistantText`.
  // Without this, such a turn fails to dedup against the official OpenCode copy
  // (which has the plain text in `content`) and shows up twice on reopen.
  return String(message.content || message.text || message.record?.assistantText || "");
}

function normalizedText(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim();
}

function isInternalOnlyUserPromptText(text) {
  return INTERNAL_ONLY_USER_PROMPTS.has(normalizedText(text).toLowerCase());
}

function timeDistanceMs(a, b) {
  const at = timestampMs(a);
  const bt = timestampMs(b);
  if (!Number.isFinite(at) || !Number.isFinite(bt)) return Infinity;
  return Math.abs(at - bt);
}

function isInjectedUserPromptText(text) {
  const value = String(text || "");
  if (!value.trim()) return false;
  if (isInternalOnlyUserPromptText(value)) return true;
  if (hasLayeredEngineText(value)) return true;
  return INJECTED_USER_PROMPT_MARKERS.some((marker) => value.includes(marker));
}

function normalizeVisibleUserMessage(message) {
  if (!message || message.role !== "user") return null;
  const text = messageText(message).trim();
  if (!text) return null;
  if (isInternalRecoveryPromptText(text)) return null;
  if (isInternalOnlyUserPromptText(text)) return null;
  if (!isInjectedUserPromptText(text)) return message;

  const original = extractUserOriginalRequest(text);
  if (!original) return null;
  return {
    ...message,
    content: original,
    meta: {
      ...(message.meta || {}),
      displaySource: "engine-user-original-layer",
      opencodeEnginePromptHidden: true,
    },
  };
}

function localUserDisplayMessages(messages = []) {
  return (messages || [])
    .filter((message) => message?.role === "user")
    .map((message) => normalizeVisibleUserMessage(message))
    .filter(Boolean);
}

function buildMetadataIndex(messages = []) {
  const byEngineMessage = new Map();
  for (const message of messages || []) {
    const key = metadataKey(message);
    if (!key) continue;
    if (message.record || message.meta || message.failed || message.turnId) {
      byEngineMessage.set(key, message);
    }
  }
  return byEngineMessage;
}

function mergeMetadata(opencodeMessage, metadataMessage) {
  if (!metadataMessage) return opencodeMessage;
  if (opencodeMessage.role === "assistant" && metadataMessage.meta?.superseded === true) return null;
  const merged = { ...opencodeMessage };
  const guardedAssistant = metadataMessage.record?.meta?.evidenceGate ? messageText(metadataMessage).trim() : "";
  if (guardedAssistant) merged.content = guardedAssistant;
  if (metadataMessage.turnId && !merged.turnId) merged.turnId = metadataMessage.turnId;
  if (metadataMessage.failed) merged.failed = true;
  if (metadataMessage.meta) {
    merged.meta = {
      ...(opencodeMessage.meta || {}),
      ...metadataMessage.meta,
    };
  }
  if (metadataMessage.record && opencodeMessage.role === "assistant") {
    merged.record = {
      ...metadataMessage.record,
      ...(opencodeMessage.record || {}),
      assistantText: guardedAssistant || opencodeMessage.record?.assistantText || metadataMessage.record.assistantText || "",
      artifacts: metadataMessage.record.artifacts || opencodeMessage.record?.artifacts || [],
      fileChanges: metadataMessage.record.fileChanges || opencodeMessage.record?.fileChanges || [],
      resultBlocks: metadataMessage.record.resultBlocks || opencodeMessage.record?.resultBlocks || [],
      timeline: metadataMessage.record.timeline || opencodeMessage.record?.timeline || [],
      notices: metadataMessage.record.notices || opencodeMessage.record?.notices || [],
      processEvents: metadataMessage.record.processEvents || opencodeMessage.record?.processEvents || [],
      meta: {
        ...(opencodeMessage.record?.meta || {}),
        ...(metadataMessage.record.meta || {}),
        opencode: opencodeMessage.record?.meta?.opencode || metadataMessage.record.meta?.opencode || null,
      },
    };
  }
  return merged;
}

function findLocalUserForOfficial(officialMessage, localUsers, usedIndexes, fallbackIndexRef) {
  const officialText = messageText(officialMessage);
  if (isInternalOnlyUserPromptText(officialText)) return null;

  const officialTs = timestampMs(officialMessage?.timestamp);
  if (Number.isFinite(officialTs)) {
    let bestIndex = -1;
    let bestDistance = Infinity;
    for (let i = 0; i < localUsers.length; i += 1) {
      if (usedIndexes.has(i)) continue;
      const candidateTs = timestampMs(localUsers[i]?.timestamp);
      if (!Number.isFinite(candidateTs)) continue;
      const distance = Math.abs(candidateTs - officialTs);
      if (distance <= USER_TIME_MATCH_WINDOW_MS && distance < bestDistance) {
        bestIndex = i;
        bestDistance = distance;
      }
    }
    if (bestIndex >= 0) {
      usedIndexes.add(bestIndex);
      return localUsers[bestIndex];
    }
  }

  if (!isInjectedUserPromptText(officialText)) return null;

  while (fallbackIndexRef.index < localUsers.length && usedIndexes.has(fallbackIndexRef.index)) {
    fallbackIndexRef.index += 1;
  }
  if (fallbackIndexRef.index >= localUsers.length) return null;
  const index = fallbackIndexRef.index;
  fallbackIndexRef.index += 1;
  usedIndexes.add(index);
  return localUsers[index];
}

function mergeUserDisplayText(opencodeMessages = [], localMessages = []) {
  const localUsers = localUserDisplayMessages(localMessages);
  const usedIndexes = new Set();
  const fallbackIndexRef = { index: Math.max(0, localUsers.length - opencodeMessages.filter((m) => m?.role === "user").length) };
  return (opencodeMessages || []).map((message) => {
    if (message?.role !== "user") return message;
    const local = localUsers.length ? findLocalUserForOfficial(message, localUsers, usedIndexes, fallbackIndexRef) : null;
    if (!local) {
      return normalizeVisibleUserMessage(message);
    }
    return {
      ...message,
      content: messageText(local),
      files: local.files,
      turnId: local.turnId || message.turnId,
      meta: {
        ...(message.meta || {}),
        displaySource: "lily-raw-user",
        opencodeEnginePromptHidden: isInjectedUserPromptText(messageText(message)),
      },
    };
  }).filter(Boolean);
}

function normalizeVisibleConversationMessages(messages = []) {
  return (Array.isArray(messages) ? messages : [])
    .map((message) => (message?.role === "user" ? normalizeVisibleUserMessage(message) : message))
    .filter((message) => Boolean(message) && !(message.role === "assistant" && message.meta?.superseded === true));
}

function isSteerMessage(message = {}) {
  return Boolean(message.steer || message.meta?.steer);
}

function messageKey(message = {}) {
  if (message.turnId && message.role) {
    if (isSteerMessage(message)) {
      const seq = message.steerSeq ?? message.meta?.steerSeq ?? normalizedText(messageText(message));
      return `turn:${message.role}:${message.turnId}:steer:${seq}`;
    }
    return `turn:${message.role}:${message.turnId}`;
  }
  if (message.id) return `id:${message.id}`;
  return `${message.role || ""}:${message.timestamp || ""}:${message.content || ""}`;
}

function scheduledDraftFingerprint(message = {}) {
  const signature = scheduledDraftSignature(message);
  if (!signature) return "";
  return [
    "scheduledDraft",
    signature.originalText,
    signature.title,
    signature.scheduleText,
    signature.rrule,
  ].join(":");
}

function scheduledDraftSignature(message = {}) {
  const scheduledDraft = message.meta?.scheduledDraft || message.record?.meta?.scheduledDraft || null;
  if (!scheduledDraft) return null;
  const draft = scheduledDraft.draft && typeof scheduledDraft.draft === "object"
    ? scheduledDraft.draft
    : scheduledDraft;
  return {
    originalText: normalizedText(scheduledDraft.originalText || draft.originalText || ""),
    title: normalizedText(scheduledDraft.prompt || scheduledDraft.title || draft.prompt || draft.title || ""),
    scheduleText: normalizedText(scheduledDraft.scheduleText || scheduledDraft.summary || draft.scheduleText || draft.summary || ""),
    rrule: normalizedText(scheduledDraft.rrule || draft.rrule || ""),
  };
}

function scheduledDraftsMatch(a = {}, b = {}) {
  const left = scheduledDraftSignature(a);
  const right = scheduledDraftSignature(b);
  if (!left || !right) return false;
  if (left.originalText && right.originalText && left.originalText !== right.originalText) return false;
  if (!left.title || !right.title || left.title !== right.title) return false;
  if (left.scheduleText && right.scheduleText && left.scheduleText !== right.scheduleText) return false;
  if (left.rrule && right.rrule && left.rrule !== right.rrule) return false;
  return Boolean(left.originalText || right.originalText || left.scheduleText || right.scheduleText || left.rrule || right.rrule);
}

function roleTurnKey(message = {}) {
  if (isSteerMessage(message)) return "";
  return message.turnId && message.role ? `${message.role}:${message.turnId}` : "";
}

function countArray(value) {
  return Array.isArray(value) ? value.length : 0;
}

function recordRichness(record = null) {
  if (!record || typeof record !== "object") return 0;
  let score = 1;
  score += countArray(record.resultBlocks) * 5;
  score += countArray(record.artifacts) * 4;
  score += countArray(record.contentBlocks) * 4;
  score += countArray(record.timeline) * 2;
  score += countArray(record.processEvents) * 2;
  score += countArray(record.notices);
  score += countArray(record.tools);
  if (record.assistantText) score += 1;
  if (record.engineMessageId) score += 1;
  if (record.persistenceCompact) score -= 4;
  return score;
}

function mergeAssistantRecords(existingRecord = null, incomingRecord = null) {
  if (!existingRecord) return incomingRecord || null;
  if (!incomingRecord) return existingRecord;
  const existingRichness = recordRichness(existingRecord);
  const incomingRichness = recordRichness(incomingRecord);
  const base = incomingRichness > existingRichness ? incomingRecord : existingRecord;
  const other = base === incomingRecord ? existingRecord : incomingRecord;
  return {
    ...base,
    meta: {
      ...(other.meta || {}),
      ...(base.meta || {}),
    },
  };
}

function isSameUserMessage(a = {}, b = {}) {
  if (a.role !== "user" || b.role !== "user") return false;
  const aText = normalizedText(messageText(a));
  const bText = normalizedText(messageText(b));
  if (!aText || !bText || aText !== bText) return false;
  return timeDistanceMs(a.timestamp, b.timestamp) <= PROJECTION_TIME_MATCH_WINDOW_MS;
}

// A rich local assistant record and the official engine copy of the SAME turn
// often carry text that is NOT byte-identical: the rich record can prepend a
// step summary / ✓ checklist or append report sections, so one is a superset of
// the other. Requiring exact equality then misses the match and the turn is
// appended twice on reopen (the reopen-duplicate). Treat them as the same turn
// when the texts are equal OR — for substantial text — one contains the other.
// The length guard keeps short, genuinely-different replies from over-merging.
function assistantTextEquivalent(a, b) {
  // Compare with ALL whitespace removed (insignificant for CJK) and accept equal,
  // one-contains-the-other, OR a long shared prefix — the official engine copy
  // and the Lily copy of the same turn differ only by whitespace/length and share
  // no key, so exact/plain-includes misses them.
  const sa = String(a || "").replace(/\s+/g, "");
  const sb = String(b || "").replace(/\s+/g, "");
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

function findEquivalentProjectionIndex(out, projected) {
  const directKey = messageKey(projected);
  for (let i = 0; i < out.length; i += 1) {
    const existing = out[i];
    if (messageKey(existing) === directKey) return i;
    const existingTurn = roleTurnKey(existing);
    const projectedTurn = roleTurnKey(projected);
    if (existingTurn && projectedTurn && existingTurn === projectedTurn) return i;
    if (
      projected.role === "user" &&
      !isSteerMessage(existing) &&
      !isSteerMessage(projected) &&
      isSameUserMessage(existing, projected)
    ) return i;
    if (projected.role === "assistant") {
      if (scheduledDraftsMatch(existing, projected)) return i;
      const projectedText = normalizedText(messageText(projected));
      const existingText = normalizedText(messageText(existing));
      if (
        existing.role === "assistant" &&
        timeDistanceMs(existing.timestamp, projected.timestamp) <= PROJECTION_TIME_MATCH_WINDOW_MS &&
        assistantTextEquivalent(existingText, projectedText)
      ) {
        return i;
      }
    }
  }
  return -1;
}

function mergeProjectionConversation(messages = [], projections = []) {
  const out = normalizeVisibleConversationMessages(messages);
  const byKey = new Map();
  for (let i = 0; i < out.length; i += 1) {
    byKey.set(messageKey(out[i]), i);
  }

  for (const projected of normalizeVisibleConversationMessages(projections)) {
    if (!projected?.role || !projected?.turnId) continue;
    const key = messageKey(projected);
    const existingIndex = byKey.get(key) ?? findEquivalentProjectionIndex(out, projected);
    if (existingIndex < 0) {
      byKey.set(key, out.length);
      out.push(projected);
      continue;
    }
    const existing = out[existingIndex];
    if (projected.role !== "assistant") continue;
    out[existingIndex] = {
      ...existing,
      content: existing.content || projected.content || "",
      record: mergeAssistantRecords(existing.record, projected.record),
      failed: Boolean(existing.failed || projected.failed),
      meta: {
        ...(projected.meta || {}),
        ...(existing.meta || {}),
      },
    };
  }

  return out.sort((a, b) => {
    const at = timestampMs(a.timestamp) ?? 0;
    const bt = timestampMs(b.timestamp) ?? 0;
    if (at !== bt) return at - bt;
    if (a.turnId && b.turnId && a.turnId === b.turnId) {
      if (a.role === b.role) return 0;
      return a.role === "user" ? -1 : 1;
    }
    return 0;
  });
}

function projectedConversationFor(ctx, sessionId, opts = {}) {
  if (opts.before != null) return [];
  try {
    return ctx.sessionManager.getProjectedConversation?.(sessionId, {
      limit: Number.isInteger(opts.limit) ? Math.max(opts.limit, 100) : 100,
      includeOpen: opts.includeOpen !== false,
    }) || [];
  } catch {
    return [];
  }
}

async function getConversationPageFromSource(ctx, sessionId, opts = {}) {
  const session = sessionId ? ctx.sessionManager.findById(sessionId) : ctx.sessionManager.getActive();
  if (!session) {
    return {
      ok: false,
      error: "NOT_FOUND",
      sessionId: sessionId || null,
      conversation: [],
      hasMore: false,
      before: null,
      nextBefore: null,
      total: 0,
    };
  }

  const fallback = () => {
    const page = ctx.sessionManager.getConversationPage(session.id, opts);
    if (page && Array.isArray(page.conversation)) {
      page.conversation = stripInternalContinuationTurns(page.conversation);
    }
    const projections = projectedConversationFor(ctx, session.id, {
      ...opts,
      includeOpen: true,
    });
    if (!projections.length) {
      return {
        ...page,
        conversation: normalizeVisibleConversationMessages(page.conversation || []),
      };
    }
    return {
      ...page,
      conversation: mergeProjectionConversation(page.conversation || [], projections),
      source: page.source || "lily",
      projectionSource: "lily-projection",
    };
  };
  let runner = ctx.runnerPool?.get?.(session.id);
  // Passive reads (session switch / history refresh) must NOT pay to boot the
  // engine: spawning + resuming opencode serve stalls the main loop for
  // seconds (the "切换会话卡几秒"). Only spawn when the caller opts in — a
  // message send does (turn-orchestrator ensures the runner anyway, which
  // reconciles official history for free); a plain switch passes
  // allowEngineSpawn:false / preferLocal and reads the local store now.
  // Kill-switch: LILY_SESSION_SWITCH_EAGER_RESUME=1 restores eager boot.
  const allowEngineSpawn =
    opts.allowEngineSpawn !== false || process.env.LILY_SESSION_SWITCH_EAGER_RESUME === "1";
  const runnerAlive = Boolean(runner?.getConversationPage && runner?.isAlive?.());
  if (!runnerAlive && opts.before == null && (opts.preferLocal || !allowEngineSpawn)) {
    return {
      ...fallback(),
      source: "lily-local-first",
      // Only recommend a follow-up official refresh when a spawn is actually
      // permitted; otherwise the refresh would just no-op and re-render.
      officialRefreshRecommended: allowEngineSpawn && Boolean(session.agentResumeId),
    };
  }
  if (allowEngineSpawn && !runnerAlive && session.agentResumeId) {
    const spawnStartedAt = Date.now();
    try {
      const ensureConversationRunner =
        ctx.ensureConversationRunner ||
        ((targetCtx, targetSessionId) => require("./ipc-utils").ensureSessionRunner(targetCtx, targetSessionId, { spawn: true }));
      const ensured = await ensureConversationRunner(ctx, session.id);
      if (ensured?.runner) runner = ensured.runner;
    } catch {
      // Official OpenCode history is best-effort here. If the engine cannot be
      // started for a passive read, Lily's metadata/legacy store remains the
      // offline fallback.
    }
    const spawnMs = Date.now() - spawnStartedAt;
    if (spawnMs > 500) {
      console.info("[session] engine resume for history read took %dms (session=%s)", spawnMs, session.id);
    }
  }
  if (!runner?.getConversationPage || !runner?.isAlive?.()) return fallback();

  try {
    const page = await runner.getConversationPage(opts);
    const localConversation = stripInternalContinuationTurns(ctx.sessionManager.getConversation(session.id));
    const metadata = buildMetadataIndex(localConversation);
    const mergedOfficial = mergeUserDisplayText(stripInternalContinuationTurns(page.conversation || []), localConversation).map((message) => {
      const key = metadataKey(message);
      return mergeMetadata(message, key ? metadata.get(key) : null);
    });
    const projections = projectedConversationFor(ctx, session.id, {
      ...opts,
      includeOpen: true,
    });
    const withProjections = mergeProjectionConversation(mergedOfficial, projections);
    const conversation = mergeProjectionConversation(withProjections, localConversation);
    return {
      ...page,
      projectId: session.projectId,
      conversation,
      projectionSource: projections.length ? "lily-projection" : undefined,
    };
  } catch (err) {
    return {
      ...fallback(),
      source: "lily-fallback",
      warning: "OPENCODE_MESSAGES_UNAVAILABLE",
      detail: String(err?.message || err),
    };
  }
}

module.exports = {
  buildMetadataIndex,
  isInjectedUserPromptText,
  isInternalOnlyUserPromptText,
  mergeMetadata,
  mergeProjectionConversation,
  mergeUserDisplayText,
  stripInternalContinuationTurns,
  getConversationPageFromSource,
};
