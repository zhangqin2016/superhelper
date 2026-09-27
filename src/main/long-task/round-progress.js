"use strict";

/**
 * Did the round that launched a job change the workspace?
 *
 * A job wake inside a continuation chain is admitted only with progress the
 * chain has not seen, and a job's progress used to mean one thing: a
 * successful result. So a round that really fixed something — edited the
 * build script, then relaunched — and whose relaunch failed again earned
 * nothing, and the chain stopped with "no new progress" while the failure
 * went unread (2026-09-27, release 0.1.189 attempt 3).
 *
 * A round's own file writes are that progress: the same edit made twice is the
 * same key, so relaunching an unchanged job — under a new id, with new polling
 * — earns nothing and the loop guard still holds. Only completed writes count,
 * and only tools the shared tool semantics classify as file writes.
 */

const crypto = require("node:crypto");
const { resolveToolSemantics } = require("../tool-semantics");

const PRESENTATION_KEYS = new Set(["description", "title", "timeout", "timeout_ms"]);

function canonical(value, depth = 0) {
  if (depth > 12) return null;
  if (Array.isArray(value)) return value.map((item) => canonical(item, depth + 1));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key], depth + 1)]));
  }
  return value;
}

/** Fingerprints of the completed file writes among a turn's tool events. */
function workspaceProgressKeys(events = []) {
  const started = new Map();
  const keys = new Set();
  for (const event of Array.isArray(events) ? events : []) {
    const payload = event?.payload || {};
    const id = String(payload.id || "");
    if (!id) continue;
    if (event.type === "tool.started") {
      started.set(id, { name: payload.name, input: payload.input });
      continue;
    }
    if (event.type !== "tool.done" || payload.isError === true || (payload.status && payload.status !== "done")) continue;
    const tool = started.get(id);
    if (!tool || resolveToolSemantics({ name: tool.name, input: tool.input }).evidenceKind !== "file_write") continue;
    const input = Object.fromEntries(Object.entries(tool.input || {}).filter(([key]) => !PRESENTATION_KEYS.has(key)));
    const serialized = JSON.stringify(canonical([String(tool.name || "").toLowerCase(), input]));
    keys.add(crypto.createHash("sha256").update(serialized, "utf8").digest("hex"));
  }
  return [...keys].slice(-64);
}

/** The launching round's workspace progress, read from its recorded tool events. */
function launchingRoundProgressKeys(manager, sessionId, turnId) {
  try {
    if (typeof manager?.getTurnToolEvents !== "function") return [];
    return workspaceProgressKeys(manager.getTurnToolEvents(sessionId, turnId));
  } catch (err) {
    console.warn(`[long-task] launching round progress unavailable (job outcomes alone decide): ${err?.message || err}`);
    return [];
  }
}

module.exports = { launchingRoundProgressKeys, workspaceProgressKeys };
