"use strict";

const AUTHORING_REFRESH_TIMEOUT_MS = 15_000;

async function ensureCharacterAuthoringAvailable(deps = {}) {
  const resolvePolicy = typeof deps.resolvePolicy === "function" ? deps.resolvePolicy : () => null;
  const refresh = typeof deps.refresh === "function" ? deps.refresh : null;
  const policy = () => {
    try { return resolvePolicy(); } catch { return null; }
  };
  const current = policy();
  if (current?.enabled === true) return { ok: true, refreshed: false };

  let refreshed = null;
  if (refresh) {
    try {
      refreshed = await refresh({
        force: true,
        timeoutMs: AUTHORING_REFRESH_TIMEOUT_MS,
        repairManagedService: true,
        reason: "character_worlds_authoring",
      });
    } catch (err) {
      refreshed = { ok: false, error: err?.message || String(err) };
    }
  }

  const next = policy();
  if (next?.enabled === true) return { ok: true, refreshed: true };
  return {
    ok: false,
    error: "CHARACTER_WORLDS_UNAVAILABLE",
    reason: String(next?.reason || current?.reason || "remote_disabled"),
    ...(refreshed?.ok === false ? { refreshError: String(refreshed.error || "REFRESH_FAILED") } : {}),
  };
}

module.exports = { AUTHORING_REFRESH_TIMEOUT_MS, ensureCharacterAuthoringAvailable };
