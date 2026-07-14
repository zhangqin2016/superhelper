#!/usr/bin/env node
// External command admission decision (MC-SPEC-008 §3.3). Security/correctness
// critical: a wrong branch means a mobile command executes twice, overwrites a
// prior command, reaches a session it doesn't own, or silently becomes a steer.
// Pure logic, every branch driven with no orchestrator/engine/disk.

import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import assert from "node:assert/strict";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const {
  decideExternalCommandAdmission,
  validateEnvelope,
  STEER_DOWNGRADE_REASON,
} = require(path.join(ROOT, "src/main/external-command-admission.js"));

const base = {
  commandId: "cmd_1",
  idempotencyKey: "idem_1",
  payloadHash: "hash_abc",
  lilySessionId: "sess_1",
  mobileDeviceId: "dmob",
  desktopDeviceId: "dtop",
  remoteSessionId: "rs_1",
  correlationId: "corr_1",
  text: "帮我整理今天的会议纪要",
  mode: "queue",
  sourceSequence: 7,
};

// --- envelope validation -----------------------------------------------------
assert(validateEnvelope(base).ok, "a complete envelope validates");
assert(!validateEnvelope({ ...base, commandId: "" }).ok, "missing commandId rejected");
assert(!validateEnvelope({ ...base, payloadHash: "" }).ok, "missing payloadHash rejected");
assert.equal(validateEnvelope({ ...base, text: "", attachments: [] }).code, "COMMAND_EMPTY", "no text and no files rejected");
assert(validateEnvelope({ ...base, text: "", attachments: [{ ref: "a" }] }).ok, "attachment-only command is valid");

// --- fresh admission: queue --------------------------------------------------
{
  const d = decideExternalCommandAdmission({ envelope: base, existingRecord: null, sessionExists: true, sessionOwned: true });
  assert.equal(d.outcome, "admit");
  assert.equal(d.record.state, "admitted");
  assert.equal(d.record.requestedMode, "queue");
  assert.equal(d.record.effectiveMode, "queue");
  assert.equal(d.record.downgradeReason, null);
  assert.equal(d.record.commandId, "cmd_1");
  assert.equal(d.record.correlationId, "corr_1", "correlation id is retained for diagnostics");
  assert.equal(d.record.payloadHash, "hash_abc");
  assert.equal(d.response.state, "admitted");
  assert.equal(d.response.correlationId, "corr_1", "mobile receives the correlation id");
  assert(d.record.retainUntil > d.record.createdAt, "retainUntil is in the future");
}

// --- fresh admission: steer downgrades to queue ------------------------------
{
  const d = decideExternalCommandAdmission({ envelope: { ...base, mode: "steer" }, existingRecord: null, sessionExists: true, sessionOwned: true });
  assert.equal(d.outcome, "admit");
  assert.equal(d.record.requestedMode, "steer", "requested mode is preserved");
  assert.equal(d.record.effectiveMode, "queue", "steer is admitted as queue under today's engine");
  assert.equal(d.record.downgradeReason, STEER_DOWNGRADE_REASON);
  assert.equal(d.response.downgradeReason, STEER_DOWNGRADE_REASON, "mobile is told about the downgrade");
}

// --- idempotent replay: same key+payload returns existing, no re-admit -------
{
  const first = decideExternalCommandAdmission({ envelope: base, existingRecord: null, sessionExists: true, sessionOwned: true });
  const replay = decideExternalCommandAdmission({ envelope: base, existingRecord: first.record, sessionExists: true, sessionOwned: true });
  assert.equal(replay.outcome, "idempotent_hit", "a replay is not a second admission");
  assert.equal(replay.record, first.record, "the original ledger record is returned");
  // Idempotency wins even if the session later vanished — the original stands.
  const replayGone = decideExternalCommandAdmission({ envelope: base, existingRecord: first.record, sessionExists: false, sessionOwned: true });
  assert.equal(replayGone.outcome, "idempotent_hit", "idempotency is checked before session existence");
}

// --- payload conflict: same key, different payload is rejected ----------------
{
  const first = decideExternalCommandAdmission({ envelope: base, existingRecord: null, sessionExists: true, sessionOwned: true });
  const conflict = decideExternalCommandAdmission({ envelope: { ...base, payloadHash: "hash_DIFFERENT" }, existingRecord: first.record, sessionExists: true, sessionOwned: true });
  assert.equal(conflict.outcome, "payload_conflict");
  assert.equal(conflict.code, "COMMAND_PAYLOAD_CONFLICT", "a reused key with a new payload never overwrites the original");
}

// --- session absent / ownership mismatch are non-admissions ------------------
{
  const absent = decideExternalCommandAdmission({ envelope: base, existingRecord: null, sessionExists: false, sessionOwned: true });
  assert.equal(absent.outcome, "session_absent");
  assert.equal(absent.code, "SESSION_ABSENT");
  const misowned = decideExternalCommandAdmission({ envelope: base, existingRecord: null, sessionExists: true, sessionOwned: false });
  assert.equal(misowned.outcome, "ownership_mismatch");
  assert.equal(misowned.code, "SESSION_OWNERSHIP_MISMATCH", "a device cannot inject into a session it does not own");
}

// --- invalid envelope short-circuits before any session work -----------------
{
  const bad = decideExternalCommandAdmission({ envelope: { ...base, idempotencyKey: "" }, existingRecord: null, sessionExists: true, sessionOwned: true });
  assert.equal(bad.outcome, "invalid");
}

console.log("external-command-admission: ok");
