"use strict";

/**
 * The diagnostic that looks BACKWARD.
 *
 * Every other support check probes the machine as it is right now, which says
 * nothing about the intermittent failure a user is actually reporting — by the
 * time they open the dialog, the model answers, the network is up, and every
 * check is green. The reason each turn ended is recorded per turn; grouping the
 * recent ones turns "it keeps going wrong" into a named, countable cause, which
 * is the difference between a ticket someone can act on and one that can only
 * be guessed at.
 *
 * Reports codes and counts, never conversations: no user text, no file paths,
 * no model output. A code and a count are enough to route a ticket, and this
 * report leaves the machine.
 */

const fs = require("node:fs");

function safeCall(fn, fallback = null) {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

function check(status, id, label, detail = "", action = "") {
  return { id, status, label, detail, action };
}

const ID = "turns.recentFailures";
const LABEL = "近期失败";
// One occurrence is weather; the same code this many times is a defect that
// deserves someone's attention.
const RECURRENCE_THRESHOLD = 3;
const MAX_GROUPS_REPORTED = 8;

function recentFailuresCheck(options = {}) {
  // Opened straight from the file rather than through the full store, which
  // would re-run migrations — a read-only diagnostic must not mutate anything.
  const dbPath = options.messageDbPath || safeCall(() => require("./config").messageDbPath(), "");
  if (!dbPath || !fs.existsSync(dbPath)) {
    return check("ok", ID, LABEL, "本机还没有回合记录，跳过。");
  }
  let groups = [];
  let db = null;
  try {
    db = require("./store/sqlite-db").openMessageDatabase(dbPath);
    groups = require("./store/turn-failure-history").recentFailureCodes(db, { limit: MAX_GROUPS_REPORTED });
  } catch (err) {
    // A diagnostic must never be the thing that breaks the report it belongs to.
    return check("ok", ID, LABEL, `回合记录暂时读不到（${err?.message || err}），不影响其它检查。`);
  } finally {
    safeCall(() => db?.close?.(), null);
  }
  if (!groups.length) return check("ok", ID, LABEL, "最近 7 天没有失败的回合。");
  const total = groups.reduce((sum, group) => sum + group.count, 0);
  const summary = groups.map((group) => `${group.code}×${group.count}`).join("、");
  const status = groups[0].count >= RECURRENCE_THRESHOLD ? "warning" : "ok";
  return check(status, ID, LABEL, `最近 7 天有 ${total} 次失败：${summary}。`);
}

/**
 * Capabilities that stopped working without stopping the turn.
 *
 * A failed turn is visible; a capability that quietly declined is not. The turn
 * still answers, only worse, and nothing in the report said so — which is the
 * harder half of "why is it dumber than it was".
 */
function degradedCapabilitiesCheck(options = {}) {
  const id = "capabilities.degraded";
  const label = "静默降级";
  const groups = options.degraded
    || safeCall(() => require("./diagnostics/swallowed-failure").degradedCapabilities({ limit: 8 }), [])
    || [];
  if (!groups.length) return check("ok", id, label, "本次运行没有能力降级。");
  const summary = groups.map((group) => `${group.site}×${group.count}（${group.cause}）`).join("；");
  return check("warning", id, label, `本次运行有能力降级但回合仍照常完成：${summary}。`);
}

module.exports = { RECURRENCE_THRESHOLD, degradedCapabilitiesCheck, recentFailuresCheck };
