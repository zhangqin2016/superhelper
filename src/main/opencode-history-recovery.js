"use strict";

const { assistantTextFromOpenCodeMessageItem } = require("./runtime/opencode-conversation-adapter");
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

  async function latestAssistant(opts = {}) {
    const server = getServer();
    const turnStartedAt = Number(getTurnStartedAt() || 0);
    if (!server?.messages || !turnStartedAt) return null;
    const raw = await server.messages({ limit: 16 });
    const items = Array.isArray(raw?.data) ? raw.data : Array.isArray(raw) ? raw : [];
    const requireCurrentPrompt = Boolean(opts.requireCurrentPrompt);
    let currentUser = null;

    if (requireCurrentPrompt) {
      const expectedText = typeof server.lastPromptText === "string"
        ? server.lastPromptText
        : String(getPendingPromptPayload()?.text || "");
      if (!expectedText.trim()) return null;
      for (const item of items) {
        const info = item?.info || {};
        if (info.role !== "user") continue;
        const createdAt = createdMs(info);
        if (!createdAt || createdAt < turnStartedAt || messageText(item) !== expectedText) continue;
        if (!currentUser || createdAt >= currentUser.rank) {
          currentUser = { createdAt, rank: createdAt };
        }
      }
      if (!currentUser) return null;
    }

    const minCreatedAt = requireCurrentPrompt ? currentUser.createdAt : turnStartedAt - 10_000;
    let best = null;
    for (const item of items) {
      const info = item?.info || {};
      if (info.role !== "assistant") continue;
      const createdAt = createdMs(info);
      if (createdAt && createdAt < minCreatedAt) continue;
      const output = assistantTextFromOpenCodeMessageItem(item);
      if (!output) continue;
      const completedAt = completedMs(info);
      const rank = completedAt || createdAt || 0;
      if (requireCurrentPrompt && rank < currentUser.rank) continue;
      if (!best || rank >= best.rank) {
        best = {
          output,
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
    const timeoutMs = getSyncTimeoutMs();
    const latest = await withTimeout(latestAssistant({ requireCurrentPrompt: true }), timeoutMs, null);
    if (!String(latest?.output || "").trim()) return null;
    if (latest.completed) return latest;
    const status = await withTimeout(getSessionStatus(), timeoutMs, "unknown");
    return status === "idle" ? latest : null;
  }

  async function syncFinalOutput(payload) {
    const current = String(payload?.output || "").trim();
    let latest = null;
    try {
      latest = await latestAssistant({ requireCurrentPrompt: true });
    } catch (err) {
      log.warn("opencode final history sync failed: %s", err?.message || String(err));
      return payload;
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
