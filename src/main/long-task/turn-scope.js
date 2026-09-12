"use strict";

const { issueScopeToken, verifyScopeToken } = require("./scope-token");

const PROCESS_JOB_OPERATIONS = Object.freeze(["start", "status", "logs", "stop", "list"]);

function buildProcessJobTurnGuidance({ secret, scope, now = Date.now } = {}) {
  const token = issueScopeToken({
    secret,
    scope,
    operations: PROCESS_JOB_OPERATIONS,
    ttlMs: 72 * 60 * 60_000,
    now,
  });
  return [
    "## Process Job Scope",
    "For long deterministic batches, use a durable job whose worker owns the full authorized queue, stable item IDs and committed checkpoints. A completed batch is not completion of the whole request.",
    "Choose replayPolicy=inspect when a finite job should wake this conversation to inspect its outcome; never means no automatic wake, not an instruction to keep polling. Job wakeups do not authorize replay.",
    "Checkpoint each committed batch, resume only pending items, bound retries and stop on cancellation or repeated failure. Unknown writes must be reconciled before retrying. Report processed/remaining/failed counts; final success requires the original acceptance criteria, not merely exit code 0.",
    "For every lily_process_jobs call in this turn, pass the following opaque value as scopeToken.",
    "Never print, quote, summarize, or place this token in user-visible content.",
    `scopeToken: \`${token}\``,
  ].join("\n");
}

function sameScope(left, right) {
  return ["ownerScope", "sessionId", "projectId", "turnId"].every((key) => left?.[key] === right?.[key]);
}

function verifyProcessJobScope(input, options = {}) {
  const verified = verifyScopeToken(input?.scopeToken, options);
  if (!verified.ok) return verified;
  if (options.expectedScope && !sameScope(verified.scope, options.expectedScope)) {
    return Object.freeze({ ok: false, error: "SCOPE_MISMATCH" });
  }
  return verified;
}

module.exports = { PROCESS_JOB_OPERATIONS, buildProcessJobTurnGuidance, verifyProcessJobScope };
