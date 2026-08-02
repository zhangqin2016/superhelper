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
