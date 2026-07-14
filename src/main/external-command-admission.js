"use strict";

/**
 * External command admission decision (Mobile Command MC-SPEC-008 §3.3).
 *
 * A mobile command must NEVER call sendUserMessage/runner directly. It enters
 * the local Lily session only through TurnOrchestrator.admitExternalCommand,
 * which delegates the decision to this pure function so every branch —
 * idempotent replay, payload conflict, absent/misowned session, steer
 * downgrade — is unit-tested without the orchestrator, engine, or disk.
 *
 * "Admission" here is a local durable-intent decision only; it does NOT claim
 * engine execution. Exactly-once ADMISSION is the caller's job (create the
 * ledger record + enqueue in one atomic session mutation). This module decides
 * WHAT that mutation should be.
 */

const LEDGER_SCHEMA_VERSION = 1;
const STEER_DOWNGRADE_REASON = "STEER_IDEMPOTENCY_UNAVAILABLE";
// Ledger retention floor: kept at least through the remote-session/replay
// window so a late duplicate still resolves idempotently (contract §3.3).
const LEDGER_RETAIN_MS = 24 * 60 * 60 * 1000;

function nonEmpty(value) {
  return typeof value === "string" && value.trim().length > 0;
}

/** Validate the semantic envelope shape before any session work. */
function validateEnvelope(envelope = {}) {
  for (const field of ["commandId", "idempotencyKey", "payloadHash", "lilySessionId", "mobileDeviceId"]) {
    if (!nonEmpty(envelope[field])) return { ok: false, code: "COMMAND_ENVELOPE_INVALID", field };
  }
  const mode = envelope.mode === "steer" ? "steer" : "queue";
  const hasText = nonEmpty(envelope.text);
  const hasFiles = Array.isArray(envelope.attachments) && envelope.attachments.length > 0;
  if (!hasText && !hasFiles) return { ok: false, code: "COMMAND_EMPTY" };
  return { ok: true, mode };
}

/**
 * Decide the admission for one external command.
 *
 * @param {object} args
 * @param {object} args.envelope       - semantic command envelope
 * @param {object|null} args.existingRecord - prior ledger record for this
 *        commandId in this session (or null)
 * @param {boolean} args.sessionExists - target lilySessionId resolves to a real session
 * @param {boolean} args.sessionOwned  - the requesting mobile device is authorized for it
 * @param {Date} [args.now]
 * @returns {{outcome: string, code?: string, record?: object, response?: object}}
 *   outcome ∈ idempotent_hit | payload_conflict | session_absent |
 *            ownership_mismatch | invalid | admit
 */
function decideExternalCommandAdmission({
  envelope,
  existingRecord = null,
  sessionExists,
  sessionOwned,
  now = new Date(),
}) {
  const valid = validateEnvelope(envelope);
  if (!valid.ok) return { outcome: "invalid", code: valid.code };

  // Idempotency FIRST: a retry of an already-admitted command returns its
  // existing ledger state and never enqueues twice — regardless of whether the
  // session still exists (the original admission stands).
  if (existingRecord) {
    if (existingRecord.payloadHash !== envelope.payloadHash) {
      // Same key, different payload: a rejected admission, never a silent
      // overwrite of the original command.
      return { outcome: "payload_conflict", code: "COMMAND_PAYLOAD_CONFLICT", record: existingRecord };
    }
    return { outcome: "idempotent_hit", record: existingRecord, response: admissionResponse(existingRecord) };
  }

  if (!sessionExists) return { outcome: "session_absent", code: "SESSION_ABSENT" };
  if (!sessionOwned) return { outcome: "ownership_mismatch", code: "SESSION_OWNERSHIP_MISMATCH" };

  // New admission. Requested steer downgrades to queue under today's engine
  // (no idempotent steer capability); runner.steer is never invoked.
  const requestedMode = valid.mode;
  const effectiveMode = "queue";
  const downgradeReason = requestedMode === "steer" ? STEER_DOWNGRADE_REASON : null;
  const nowIso = now.toISOString();
  const record = {
    schemaVersion: LEDGER_SCHEMA_VERSION,
    lilySessionId: envelope.lilySessionId,
    commandId: envelope.commandId,
    idempotencyKey: envelope.idempotencyKey,
    correlationId: envelope.correlationId || envelope.commandId,
    payloadHash: envelope.payloadHash,
    desktopDeviceId: envelope.desktopDeviceId || null,
    mobileDeviceId: envelope.mobileDeviceId,
    remoteSessionId: envelope.remoteSessionId || null,
    sourceSequence: Number.isFinite(envelope.sourceSequence) ? envelope.sourceSequence : null,
    requestedMode,
    effectiveMode,
    downgradeReason,
    state: "admitted",
    dispatchAttemptedAt: null,
    engineAcceptedAt: null,
    queueItemId: null,
    turnId: null,
    ownership: { source: "mobile", mobileDeviceId: envelope.mobileDeviceId },
    createdAt: nowIso,
    updatedAt: nowIso,
    terminalType: null,
    terminalError: null,
    retainUntil: new Date(now.getTime() + LEDGER_RETAIN_MS).toISOString(),
  };
  return { outcome: "admit", record, response: admissionResponse(record) };
}

/** The exact response shape mobile consumes (contract §3.3): mode fields under
 *  their canonical names, admission state, destination reference. */
function admissionResponse(record) {
  return {
    ok: true,
    commandId: record.commandId,
    idempotencyKey: record.idempotencyKey,
    correlationId: record.correlationId || record.commandId,
    state: record.state,
    requestedMode: record.requestedMode,
    effectiveMode: record.effectiveMode,
    downgradeReason: record.downgradeReason,
    queueItemId: record.queueItemId || null,
    turnId: record.turnId || null,
  };
}

module.exports = {
  LEDGER_SCHEMA_VERSION,
  STEER_DOWNGRADE_REASON,
  LEDGER_RETAIN_MS,
  validateEnvelope,
  decideExternalCommandAdmission,
  admissionResponse,
};
