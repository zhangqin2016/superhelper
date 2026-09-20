"use strict";

const { assistantTextFromOpenCodeMessageItem, isCompactionSummaryInfo } = require("./runtime/opencode-conversation-adapter");
const { getLogger } = require("./logger");

const log = getLogger("opencode-history-recovery");

function messageText(item = {}) {
  return (Array.isArray(item?.parts) ? item.parts : [])
    .filter((part) => part?.type === "text" && !part.ignored && typeof part.text === "string")
    .map((part) => part.text)
    .join("");
}

function createdMs(info = {}) {
  const created = Number(info.time?.created || info.created || 0);
  return Number.isFinite(created) && created > 0 ? created : null;
}

function completedMs(info = {}) {
  const completed = Number(info.time?.completed || info.completed || 0);
  return Number.isFinite(completed) && completed > 0 ? completed : null;
}

function withTimeout(promise, timeoutMs, fallback = null) {
  let timer = null;
  return Promise.race([
    promise,
    new Promise((resolve) => {
      timer = setTimeout(() => resolve(fallback), timeoutMs);
      timer.unref?.();
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function createOpencodeHistoryRecovery(options = {}) {
  const getServer = options.getServer || (() => null);
  const getTurnStartedAt = options.getTurnStartedAt || (() => 0);
  const getPendingPromptPayload = options.getPendingPromptPayload || (() => null);
  const getSessionStatus = options.getSessionStatus || (() => Promise.resolve("unknown"));
  const getSyncTimeoutMs = options.getSyncTimeoutMs || (() => 2_500);
  const onSupplementalOutput = options.onSupplementalOutput || (() => {});
  const captureScope = options.captureScope || (() => () => true);

  async function latestAssistant(opts = {}) {
    const isCurrent = captureScope();
    const server = getServer();
    const turnStartedAt = Number(getTurnStartedAt() || 0);
    if (!server?.messages || !turnStartedAt) return null;
    const expectedText = typeof server.lastPromptText === "string"
      ? server.lastPromptText : String(getPendingPromptPayload()?.text || "");
    const raw = await server.messages({ limit: 16 });
    if (!isCurrent()) return null;
    const items = Array.isArray(raw?.data) ? raw.data : Array.isArray(raw) ? raw : [];
    const requireCurrentPrompt = Boolean(opts.requireCurrentPrompt);
    let currentUser = null;

    if (requireCurrentPrompt) {
      if (!expectedText.trim()) return null;
      for (const item of items) {
        const info = item?.info || {};
        if (info.role !== "user") continue;
        const createdAt = createdMs(info);
        if (!createdAt || createdAt < turnStartedAt || messageText(item) !== expectedText) continue;
        if (!currentUser || createdAt >= currentUser.rank) {
          currentUser = { id: info.id, createdAt, rank: createdAt };
        }
      }
      // A long tool run pushes its user message out of the recent page. Resolve
      // the engine's parent identity directly; never guess from timestamps alone.
      if (!currentUser && typeof server.message === "function") {
        const candidates = items.filter((item) => item?.info?.role === "assistant"
          && item.info.parentID && createdMs(item.info) >= turnStartedAt)
          .sort((a, b) => (createdMs(b.info) || 0) - (createdMs(a.info) || 0));
        const parentID = candidates[0]?.info?.parentID;
        if (parentID) {
          const rawParent = await withTimeout(server.message(parentID), getSyncTimeoutMs(), null);
          if (!isCurrent()) return null;
          const parent = rawParent?.data || rawParent;
          const info = parent?.info;
          const createdAt = createdMs(info || {});
          if (info?.id === parentID && info.role === "user" && createdAt >= turnStartedAt
            && (!server.sessionID || info.sessionID === server.sessionID)
            && messageText(parent) === expectedText) {
            currentUser = { id: parentID, createdAt, rank: createdAt };
          }
        }
      }
      if (!currentUser) return null;
    }

    const minCreatedAt = requireCurrentPrompt ? currentUser.createdAt : turnStartedAt - 10_000;
    let best = null;
    for (const item of items) {
      const info = item?.info || {};
      if (info.role !== "assistant") continue;
      if (isCompactionSummaryInfo(info)) continue;
      if (requireCurrentPrompt && info.parentID && info.parentID !== currentUser.id) continue;
      const createdAt = createdMs(info);
      if (createdAt && createdAt < minCreatedAt) continue;
      const output = assistantTextFromOpenCodeMessageItem(item);
      const completedAt = completedMs(info);
      const rank = createdAt || completedAt || 0;
      if (requireCurrentPrompt && rank < currentUser.rank) continue;
      if (!best || rank >= best.rank) {
        best = {
          output,
          ...(info.error ? { error: info.error } : {}),
          ...(info.finish ? { finish: info.finish } : {}),
          engineMessageId: typeof info.id === "string" ? info.id : null,
          completed: Boolean(completedAt),
          completedAt,
          createdAt,
          rank,
        };
      }
    }
    if (!best) return null;
    const { rank, ...result } = best;
    return result;
  }

  async function recoverStalledFinal() {
    const isCurrent = captureScope();
    const timeoutMs = getSyncTimeoutMs();
    const latest = await withTimeout(latestAssistant({ requireCurrentPrompt: true }), timeoutMs, null);
    if (!isCurrent() || latest?.error || latest?.finish === "tool-calls" || !String(latest?.output || "").trim()) return null;
    // A tool-call step has a completion timestamp while the task still runs.
    // Only an authoritative idle session can turn history into terminal output.
    const status = await withTimeout(getSessionStatus(), timeoutMs, "unknown");
    return isCurrent() && status === "idle" ? latest : null;
  }

  async function syncFinalOutput(payload) {
    const isCurrent = captureScope();
    const current = String(payload?.output || "").trim();
    let latest = null;
    try {
      latest = await latestAssistant({ requireCurrentPrompt: true });
    } catch (err) {
      log.warn("opencode final history sync failed: %s", err?.message || String(err));
      return payload;
    }
    if (!isCurrent()) return payload;
    if (latest?.error) {
      const error = latest.error;
      return { ...payload, code: 1, error: String(error.data?.message || error.message || error.name || "Engine history contains a failed response"), engineMessageId: latest.engineMessageId };
    }
    if (latest && (!latest.output?.trim() || latest.finish === "tool-calls")) {
      return { ...payload, stalled: true, engineMessageId: latest.engineMessageId };
    }
    const official = String(latest?.output || "").trim();
    if (!official) return payload;
    if (official !== current) {
      const missing = official.startsWith(current) ? official.slice(current.length) : (!current ? official : "");
      if (missing) onSupplementalOutput({ official, missing });
    }
    return {
      ...payload,
      output: official || current,
      engineMessageId: latest?.engineMessageId || payload?.engineMessageId || null,
      resultFromOfficialHistory: official !== current,
    };
  }

  return { latestAssistant, recoverStalledFinal, syncFinalOutput, withTimeout };
}

module.exports = { createOpencodeHistoryRecovery, withTimeout };
