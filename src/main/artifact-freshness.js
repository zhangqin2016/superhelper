"use strict";

/**
 * Records are displayed at the CURRENT artifact schema, whether or not a
 * migration has run.
 *
 * The stored artifacts used to be the source of truth for display, with a
 * background pass responsible for bringing them up to date after a schema bump.
 * That made a migration load-bearing, and a load-bearing migration is a way to
 * wedge the application: the version is part of a per-session flag key, so one
 * bump invalidated every session at once and the pass had to walk all of
 * history before anything looked right. A customer's launch froze on exactly
 * that.
 *
 * Deriving is not what costs. Measured on a real database, for one 50-record
 * page: 13 ms to re-derive every record in memory, 205 ms to write those
 * records back. So the read path derives, and only persistence is deferred.
 * Stored artifacts become a CACHE — worth keeping warm, never depended upon.
 *
 * The consequence is the point: display correctness no longer depends on a
 * migration having completed, so no schema bump can make the app look wrong or
 * make it work to look right at startup.
 *
 * Fail-open: any error leaves the record exactly as stored, which is the
 * previous behaviour. [gate: resumable-enrichment]
 */

const { backfillMessageArtifacts } = require("./session-artifact-backfill");

/**
 * @param {Array<object>} conversation messages as stored
 * @param {string} workspacePath the session's workspace, needed to judge artifact relevance
 * @returns {{ conversation: Array<object>, upgraded: number }}
 */
function withFreshArtifacts(conversation, workspacePath) {
  if (!Array.isArray(conversation) || !conversation.length) {
    return { conversation: Array.isArray(conversation) ? conversation : [], upgraded: 0 };
  }
  if (!workspacePath) return { conversation, upgraded: 0 }; // relevance is judged against a root
  let upgraded = 0;
  const out = conversation.map((message) => {
    if (!message?.record) return message;
    try {
      // Derive on a copy: the caller is reading, and a read must not mutate the
      // objects the store handed out.
      const copy = { ...message, record: { ...message.record } };
      if (!backfillMessageArtifacts(copy, workspacePath)) return message;
      upgraded += 1;
      return copy;
    } catch {
      return message; // stored artifacts are always a valid answer
    }
  });
  return { conversation: out, upgraded };
}

module.exports = { withFreshArtifacts };
