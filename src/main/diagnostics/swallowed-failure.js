"use strict";

/**
 * One place to record a failure that was handled rather than raised.
 *
 * Lily degrades open by design: when a capability cannot run, the turn proceeds
 * without it instead of dying. That is the right behaviour and it is not
 * negotiable. What is not right is doing it silently — a capability that
 * quietly stops working looks exactly like one that was never needed, so the
 * conversation is simply worse and nothing anywhere says why.
 *
 * Measured 2026-09-23: the objective-coverage judge failed on every turn of a
 * session behind `catch { return unknown("judge_unavailable_or_invalid") }`,
 * a bare catch that discarded the cause. Whether that was a timeout, a bad
 * verdict, a dead endpoint or a parse error was unknowable from outside.
 *
 * This is deliberately NOT a rule that every catch must log. Most catches
 * handle a predictable condition — a file that is absent, JSON that may not be
 * JSON, a feature that is off — and narrating those would bury the failures
 * that matter under thousands of lines a day, which is the problem the bounded
 * log sink was just built to end. This is for the other kind: a catch that
 * erases the reason something the user would have wanted did not happen.
 *
 * Deduplicated and bounded by construction, so wiring it in can never become
 * the next flood: the same site and the same cause collapse into one line with
 * a count, and a site that keeps failing goes quiet after a handful of reports
 * rather than narrating every turn.
 */

const { getLogger } = require("../logger");

const log = getLogger("degraded");

// Enough to see a pattern; few enough that a permanently broken capability
// costs a handful of lines rather than one per turn forever.
const MAX_REPORTS_PER_CAUSE = 5;
// Distinct site+cause pairs tracked. A bound here means a caller that varies
// its message cannot grow this map without limit.
const MAX_TRACKED_CAUSES = 500;
const MAX_DETAIL_CHARS = 300;

const seen = new Map();

function causeOf(error) {
  if (!error) return "unknown";
  if (typeof error === "string") return error;
  const message = error.message || String(error);
  const code = error.code ? `${error.code}: ` : "";
  return `${code}${message}`;
}

function contextText(context) {
  if (!context || typeof context !== "object") return "";
  const parts = [];
  for (const [key, value] of Object.entries(context)) {
    if (value === undefined || value === null || value === "") continue;
    parts.push(`${key}=${String(value).slice(0, 80)}`);
  }
  return parts.length ? ` ${parts.join(" ")}` : "";
}

/**
 * Report that `site` could not do its job, and carried on without it.
 *
 * @param {string} site    what stopped working, in the user's terms
 * @param {unknown} error  the cause being handled; a string is taken as-is
 * @param {object} [context] session/turn ids and anything else that makes this
 *                           attributable. Never secrets — this reaches a log.
 * @returns {{ site: string, cause: string, count: number, reported: boolean }}
 */
function recordSwallowedFailure(site, error, context = {}) {
  const name = String(site || "unknown");
  const cause = causeOf(error).slice(0, MAX_DETAIL_CHARS);
  const key = `${name}::${cause}`;
  try {
    if (!seen.has(key) && seen.size >= MAX_TRACKED_CAUSES) {
      return { site: name, cause, count: 0, reported: false };
    }
    const count = (seen.get(key) || 0) + 1;
    seen.set(key, count);
    if (count > MAX_REPORTS_PER_CAUSE) return { site: name, cause, count, reported: false };
    const tail = count === MAX_REPORTS_PER_CAUSE ? " (further occurrences of this cause are not repeated)" : "";
    log.warn(`${name} unavailable, continuing without it: ${cause}${contextText(context)}${tail}`);
    return { site: name, cause, count, reported: true };
  } catch {
    // Reporting a degradation must never itself degrade anything.
    return { site: name, cause, count: 0, reported: false };
  }
}

/** What has been degrading, for a diagnostic to name it. Most frequent first. */
function degradedCapabilities({ limit = 20 } = {}) {
  return [...seen.entries()]
    .map(([key, count]) => {
      const at = key.indexOf("::");
      return { site: key.slice(0, at), cause: key.slice(at + 2), count };
    })
    .sort((a, b) => b.count - a.count)
    .slice(0, Math.max(1, Math.min(Number(limit) || 20, 100)));
}

function resetSwallowedFailuresForTests() {
  seen.clear();
}

module.exports = {
  MAX_REPORTS_PER_CAUSE,
  MAX_TRACKED_CAUSES,
  degradedCapabilities,
  recordSwallowedFailure,
  resetSwallowedFailuresForTests,
};
