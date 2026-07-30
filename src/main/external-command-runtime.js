"use strict";

const { decideExternalCommandAdmission, admissionResponse } = require("./external-command-admission");
const {
  DEFAULT_MAX_RECORDS,
  createExternalCommandLedgerStore,
} = require("./external-command-ledger-store");
const { userDataPath } = require("./config");
const { mergeDisplayFileMetadata } = require("./ipc-utils");
const { getLogger } = require("./logger");

const log = getLogger("external-command-runtime");
const TERMINAL_TURN_STATUSES = new Set([
  "completed",
  "failed",
  "interrupted",
  "cancelled",
  "stalled",
]);

function externalIdentity(value = {}) {
  const desktopDeviceId = typeof value.desktopDeviceId === "string"
    ? value.desktopDeviceId
    : "";
  const mobileDeviceId = typeof value.mobileDeviceId === "string"
    ? value.mobileDeviceId
    : "";
  const idempotencyKey = typeof value.idempotencyKey === "string"
    ? value.idempotencyKey
    : "";
  return desktopDeviceId && mobileDeviceId && idempotencyKey
    ? { desktopDeviceId, mobileDeviceId, idempotencyKey }
    : null;
}

// Process-global O(1) idempotency key: the (desktop, mobile, key) triple is
// unique across sessions, so a NUL-joined tuple indexes it directly. Replay
// lookups must never scan the live ledgers.
function identityIndexKey(identity) {
  return identity
    ? `${identity.desktopDeviceId}\u0000${identity.mobileDeviceId}\u0000${identity.idempotencyKey}`
    : null;
}

function recordCreatedMs(record) {
  const value = record?.createdAt;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return Date.parse(value) || 0;
}

// Durable turn rows carry created_at as epoch-ms numbers; the JSON ledger and
// Date.parse-based eviction need an ISO string. Normalize at the boundary.
function createdAtIso(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return new Date(value).toISOString();
  }
  if (typeof value === "string" && Number.isFinite(Date.parse(value))) {
    return value;
  }
  return null;
}

function durableExternalRecord(turn, envelope, inMemoryRecord = null) {
  if (!turn) return inMemoryRecord;
  const persisted = turn.metadata?.queueRecovery?.options?.externalCommand;
  if (persisted && typeof persisted === "object" && !Array.isArray(persisted)) {
    return persisted;
  }
  return {
    schemaVersion: 1,
    lilySessionId: turn.sessionId || envelope.lilySessionId,
    commandId: turn.externalCommandId || inMemoryRecord?.commandId
      || envelope.commandId,
    idempotencyKey: turn.externalIdempotencyKey || envelope.idempotencyKey,
    correlationId: inMemoryRecord?.correlationId || envelope.correlationId
      || turn.externalCommandId || envelope.commandId,
    payloadHash: turn.externalPayloadHash || envelope.payloadHash,
    desktopDeviceId: turn.externalDesktopDeviceId || envelope.desktopDeviceId,
    mobileDeviceId: turn.externalMobileDeviceId || envelope.mobileDeviceId,
    remoteSessionId: inMemoryRecord?.remoteSessionId
      || envelope.remoteSessionId
      || null,
    sourceSequence: inMemoryRecord?.sourceSequence
      ?? (Number.isFinite(envelope.sourceSequence) ? envelope.sourceSequence : null),
    requestedMode: inMemoryRecord?.requestedMode
      || (envelope.mode === "steer" ? "steer" : "queue"),
    effectiveMode: "queue",
    downgradeReason: inMemoryRecord?.downgradeReason
      || (envelope.mode === "steer" ? "STEER_IDEMPOTENCY_UNAVAILABLE" : null),
    state: "admitted",
    turnId: turn.turnId,
    queueItemId: turn.metadata?.queueRecovery?.queueItemId || null,
    // Eviction is oldest-first by createdAt; a reconstructed record must not
    // become the preferred victim just because the durable row lacks one.
    createdAt: inMemoryRecord?.createdAt || createdAtIso(turn?.createdAt)
      || new Date().toISOString(),
    ownership: {
      source: "mobile",
      mobileDeviceId: turn.externalMobileDeviceId || envelope.mobileDeviceId,
    },
  };
}

function externalLedgerState(turn) {
  if (!turn) return null;
  if (turn.status === "dispatching") return "dispatching";
  if (
    turn.status === "outcome_unknown"
    || turn.status === "dispatch_unknown"
  ) return "dispatch_unknown";
  if (turn.status === "promoted" || turn.status === "accepted") {
    return "engine_accepted";
  }
  if (TERMINAL_TURN_STATUSES.has(turn.status)) return "terminal";
  return "admitted";
}

function terminalDetail(turn) {
  if (!turn || !TERMINAL_TURN_STATUSES.has(turn.status)) return null;
  const detail = String(turn.terminalType || "").replace(/^turn\./, "");
  if (turn.status === "failed" && detail === "stalled") return "stalled";
  return turn.status;
}

function reconcileExternalRecord(record, turn) {
  if (!record || !turn) return record;
  const state = externalLedgerState(turn);
  return {
    ...record,
    state,
    createdAt: record.createdAt || createdAtIso(turn?.createdAt) || new Date().toISOString(),
    turnId: turn.turnId || record.turnId || null,
    queueItemId: turn.metadata?.queueRecovery?.queueItemId
      || record.queueItemId
      || null,
    outcomeUnknown: state === "dispatch_unknown",
    dispatchAttemptId: turn.dispatchAttemptId || null,
    dispatchStartedAt: turn.dispatchStartedAt || null,
    engineAcceptedAt: turn.acceptedAt || turn.promotedAt || null,
    terminalAt: turn.terminalAt || null,
    terminalType: terminalDetail(turn),
    terminalError: turn.errorCode || null,
    updatedAt: new Date().toISOString(),
  };
}

function createLedgerStore(injectedStore = null) {
  try {
    if (injectedStore) return injectedStore;
    return createExternalCommandLedgerStore({ filePath: userDataPath("mobile-command-ledger.json") });
  } catch (err) {
    log.warn("external command ledger store unavailable, in-memory only: %s", err?.message || err);
    return null;
  }
}

function loadLedgers(store) {
  if (!store) return { store: null, ledgers: new Map() };
  try {
    const ledgers = store.loadSync();
    return { store, ledgers: ledgers instanceof Map ? ledgers : new Map() };
  } catch (err) {
    log.warn("external command ledger load failed open, in-memory only: %s", err?.message || err);
    return { store: null, ledgers: new Map() };
  }
}

function createExternalCommandRuntime(options = {}) {
  const findSession = options.findSession || (() => null);
  const getState = options.getState;
  const createQueueId = options.createQueueId;
  const buildQueueOptions = options.buildQueueOptions || ((value) => value);
  const admitQueueItem = options.admitQueueItem || (() => null);
  const durableLookupAvailable = (
    typeof options.lookupDurableExternalIdentity === "function"
  );
  const lookupDurableExternalIdentity = (
    options.lookupDurableExternalIdentity || (() => null)
  );
  const emitQueue = options.emitQueue || (() => {});
  const dispatchNext = options.dispatchNext || (() => {});
  const loaded = loadLedgers(createLedgerStore(options.ledgerStore || null));
  const ledgerStore = loaded.store;
  const externalLedgers = loaded.ledgers;

  function stateFor(sessionId) {
    if (typeof getState !== "function") throw new Error("getState adapter is required");
    return getState(sessionId);
  }

  function persist() {
    try {
      ledgerStore?.scheduleFlush(externalLedgers);
    } catch (err) {
      log.warn("external ledger flush schedule failed open: %s", err?.message || err);
    }
  }

  function persistNow() {
    try {
      if (ledgerStore?.flushSync?.(externalLedgers)) return;
    } catch (err) {
      log.warn("external ledger atomic reconcile failed open: %s", err?.message || err);
    }
    persist();
  }

  function ledgerFor(sessionId) {
    let ledger = externalLedgers.get(sessionId);
    if (!ledger) {
      ledger = new Map();
      externalLedgers.set(sessionId, ledger);
    }
    return ledger;
  }

  // Bounded O(1) secondary index over the (desktop, mobile, key) triple. The
  // in-memory ledgers obey the same cap as the durable store; eviction always
  // drops the ledger entry and its index entry together.
  const identityIndex = new Map();
  let liveRecordCount = 0;

  function indexRecord(sessionId, record) {
    const key = identityIndexKey(externalIdentity(record));
    if (!key || !record?.commandId) return;
    identityIndex.set(key, { sessionId, commandId: record.commandId, record });
  }

  function dropRecord(sessionId, commandId) {
    const ledger = externalLedgers.get(sessionId);
    const record = ledger?.get(commandId);
    if (!record) return;
    ledger.delete(commandId);
    if (ledger.size === 0) externalLedgers.delete(sessionId);
    liveRecordCount -= 1;
    const key = identityIndexKey(externalIdentity(record));
    const indexed = key ? identityIndex.get(key) : null;
    if (indexed && indexed.commandId === commandId) identityIndex.delete(key);
  }

  function trimLedgersToCap(maxRecords = DEFAULT_MAX_RECORDS) {
    if (liveRecordCount <= maxRecords) return 0;
    const all = [];
    for (const [sessionId, ledger] of externalLedgers) {
      for (const [commandId, record] of ledger) {
        all.push({ sessionId, commandId, record });
      }
    }
    all.sort((a, b) => recordCreatedMs(b.record) - recordCreatedMs(a.record));
    const dropped = all.slice(maxRecords);
    for (const { sessionId, commandId } of dropped) {
      dropRecord(sessionId, commandId);
    }
    log.warn(
      "external command ledger evicted %d oldest records (cap=%d)",
      dropped.length,
      maxRecords,
    );
    return dropped.length;
  }

  function setLedgerRecord(sessionId, record) {
    if (!sessionId || !record?.commandId) return;
    const ledger = ledgerFor(sessionId);
    if (!ledger.has(record.commandId)) liveRecordCount += 1;
    ledger.set(record.commandId, record);
    indexRecord(sessionId, record);
    trimLedgersToCap();
  }

  for (const [sessionId, ledger] of externalLedgers) {
    for (const record of ledger.values()) {
      liveRecordCount += 1;
      indexRecord(sessionId, record);
    }
  }
  trimLedgersToCap();

  async function admit(envelope = {}, checks = {}) {
    try {
      const sessionId = String(envelope?.lilySessionId || "");
      const session = sessionId ? findSession(sessionId) : null;
      const sessionExists = typeof checks.sessionExists === "boolean"
        ? checks.sessionExists
        : Boolean(session);
      const sessionOwned = typeof checks.sessionOwned === "boolean"
        ? checks.sessionOwned
        : true;
      const identity = externalIdentity(envelope);
      const inMemoryExisting = identity
        ? identityIndex.get(identityIndexKey(identity))?.record || null
        : null;
      const durableExisting = identity
        ? lookupDurableExternalIdentity(sessionId, identity) || null
        : null;
      if (
        durableExisting
        && (
          !durableExisting.externalPayloadHash
          || !durableExisting.externalIdempotencyKey
          || !durableExisting.externalDesktopDeviceId
          || !durableExisting.externalMobileDeviceId
        )
      ) {
        return { ok: false, code: "COMMAND_LEDGER_CORRUPT" };
      }
      if (
        durableExisting
        && durableExisting.externalPayloadHash
        && durableExisting.externalPayloadHash !== envelope.payloadHash
      ) {
        return { ok: false, code: "IDEMPOTENCY_CONFLICT" };
      }
      let existingRecord = durableExisting
        ? durableExternalRecord(
            durableExisting,
            envelope,
            inMemoryExisting,
          )
        : durableLookupAvailable
          ? null
          : inMemoryExisting;
      const decision = decideExternalCommandAdmission({
        envelope,
        existingRecord,
        sessionExists,
        sessionOwned,
      });

      if (["invalid", "payload_conflict", "session_absent", "ownership_mismatch"].includes(decision.outcome)) {
        return { ok: false, code: decision.code };
      }
      if (decision.outcome === "idempotent_hit") {
        existingRecord = reconcileExternalRecord(decision.record, durableExisting);
        setLedgerRecord(existingRecord.lilySessionId || sessionId, existingRecord);
        persistNow();
        return admissionResponse(existingRecord);
      }

      const item = {
        id: typeof createQueueId === "function" ? createQueueId() : `queue_mobile_${Date.now()}`,
        text: String(envelope.text || ""),
        files: Array.isArray(envelope.files) ? envelope.files : [],
        displayFiles: mergeDisplayFileMetadata(envelope.files || [], envelope.displayFiles),
        options: buildQueueOptions({
          queueOrigin: "mobile_command",
          queueVisibility: "composer",
          externalCommand: decision.record,
        }),
      };
      decision.record.queueItemId = item.id;
      const admission = admitQueueItem(session, item);
      if (!admission?.ok) {
        return {
          ok: false,
          code: admission?.subcode === "IDEMPOTENCY_CONFLICT"
            ? "IDEMPOTENCY_CONFLICT"
            : admission?.subcode === "EXTERNAL_IDENTITY_OWNERSHIP_MISMATCH"
              ? "SESSION_OWNERSHIP_MISMATCH"
              : "TURN_ADMISSION_FAILED",
          subcode: admission?.subcode || "STORE_REJECTED",
        };
      }
      if (admission.duplicate) {
        const original = durableExternalRecord(
          admission.turn,
          envelope,
          decision.record,
        );
        const reconciled = reconcileExternalRecord(original, admission.turn);
        setLedgerRecord(reconciled.lilySessionId || sessionId, reconciled);
        persistNow();
        return admissionResponse(reconciled);
      }
      decision.record.turnId = admission.turn?.turnId
        || item.admittedTurnInput?.turnId
        || null;
      setLedgerRecord(sessionId, decision.record);
      persist();
      const state = stateFor(sessionId);
      state.queue.push(item);
      emitQueue(sessionId);
      void dispatchNext(sessionId);
      return admissionResponse(decision.record);
    } catch (err) {
      log.warn("admitExternalCommand failed open: %s", err?.message || err);
      return { ok: false, code: "COMMAND_ADMISSION_ERROR" };
    }
  }

  function restoreRecovered(sessionId, item) {
    const record = item?.options?.externalCommand;
    const commandId = String(record?.commandId || "");
    if (
      !sessionId
      || !commandId
      || typeof record?.idempotencyKey !== "string"
      || typeof record?.payloadHash !== "string"
    ) return false;
    const current = ledgerFor(sessionId).get(commandId) || {
      ...record,
      lilySessionId: sessionId,
      queueItemId: item.id,
      turnId: item.admittedTurnInput?.turnId || record.turnId || null,
      state: record.state || "admitted",
    };
    const durable = item.admittedTurnInput
      || lookupDurableExternalIdentity(
        sessionId,
        externalIdentity(record) || {},
      )
      || null;
    setLedgerRecord(sessionId, reconcileExternalRecord(current, durable));
    persistNow();
    return true;
  }

  /**
   * Synchronously reconcile a durable turn-input row into the in-memory
   * ledger + identity index (terminal projection, dispatch state changes).
   * Lookup is O(1) through the identity triple, falling back to the
   * (sessionId, commandId) primary key. Returns false when no live record
   * matches (nothing to project).
   */
  function reconcileTurnInput(turn = {}) {
    const sessionId = String(turn.sessionId || "");
    const commandId = typeof turn.externalCommandId === "string"
      ? turn.externalCommandId
      : "";
    const identity = externalIdentity({
      desktopDeviceId: turn.externalDesktopDeviceId,
      mobileDeviceId: turn.externalMobileDeviceId,
      idempotencyKey: turn.externalIdempotencyKey,
    });
    const indexed = identity
      ? identityIndex.get(identityIndexKey(identity))
      : null;
    let record = indexed?.record || null;
    let recordSessionId = indexed?.sessionId || sessionId;
    if (!record && sessionId && commandId) {
      record = externalLedgers.get(sessionId)?.get(commandId) || null;
    }
    if (!record) return false;
    recordSessionId = recordSessionId || record.lilySessionId || sessionId;
    setLedgerRecord(recordSessionId, reconcileExternalRecord(record, turn));
    persistNow();
    return true;
  }

  return {
    admit,
    ledgers: externalLedgers,
    identityIndex,
    restoreRecovered,
    reconcileTurnInput,
  };
}

module.exports = {
  createExternalCommandRuntime,
  reconcileExternalRecord,
  loadLedgers,
};
