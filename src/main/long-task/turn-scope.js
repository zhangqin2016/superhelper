"use strict";

const { issueScopeToken, verifyScopeToken } = require("./scope-token");

const PROCESS_JOB_OPERATIONS = Object.freeze(["start", "status", "logs", "stop", "list"]);

const PROCESS_JOB_SCOPE_TTL_MS = 72 * 60 * 60_000;

/** The per-turn capability every lily_process_jobs call must carry. */
function issueProcessJobScopeToken({ secret, scope, now = Date.now } = {}) {
  return issueScopeToken({ secret, scope, operations: PROCESS_JOB_OPERATIONS, ttlMs: PROCESS_JOB_SCOPE_TTL_MS, now });
}

/**
 * True when the engine attaches the scope itself, so the prompt need not carry
 * it. The runtime-identity plugin fills `scopeToken` on every process-job call
 * from the host's per-turn grant (opencode-runtime-identity.js); the model
 * never handles the token. Copying a 576-character token by hand is what a
 * model gets wrong: 2026-09-25, `turnId` came back as `turnuId`, one project
 * id had one digit changed, one token was cut at 198 characters — each an
 * INVALID_SCOPE_TOKEN, and the turn fell back to reading job files with bash.
 * LILY_PROCESS_JOB_SCOPE_INJECT=0 restores the prompt-carried token.
 */
function processJobScopeInjected() {
  return process.env.LILY_RUNTIME_IDENTITY_V1 !== "0" && process.env.LILY_PROCESS_JOB_SCOPE_INJECT !== "0";
}

function buildProcessJobTurnGuidance({ secret, scope, now = Date.now, tokenDelivery = "prompt" } = {}) {
  const lines = [
    "## Process Job Scope",
    "For long deterministic batches, use a durable job whose worker owns the full authorized queue, stable item IDs and committed checkpoints. A completed batch is not completion of the whole request.",
    "Choose replayPolicy=inspect when a finite job should wake this conversation to inspect its outcome; never means no automatic wake, not an instruction to keep polling. Job wakeups do not authorize replay.",
    "Checkpoint each committed batch, resume only pending items, bound retries and stop on cancellation or repeated failure. Unknown writes must be reconciled before retrying. Report processed/remaining/failed counts; final success requires the original acceptance criteria, not merely exit code 0.",
  ];
  if (tokenDelivery === "host") {
    lines.push("The host attaches this turn's scope to every lily_process_jobs call itself; omit scopeToken.");
    return lines.join("\n");
  }
  const token = issueProcessJobScopeToken({ secret, scope, now });
  lines.push(
    "For every lily_process_jobs call in this turn, pass the following opaque value as scopeToken.",
    "Never print, quote, summarize, or place this token in user-visible content.",
    `scopeToken: \`${token}\``,
  );
  return lines.join("\n");
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

module.exports = { PROCESS_JOB_OPERATIONS, buildProcessJobTurnGuidance, issueProcessJobScopeToken, processJobScopeInjected, verifyProcessJobScope };
