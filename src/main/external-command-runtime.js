"use strict";

const { decideExternalCommandAdmission, admissionResponse } = require("./external-command-admission");
const { createExternalCommandLedgerStore } = require("./external-command-ledger-store");
const { userDataPath } = require("./config");
const { mergeDisplayFileMetadata } = require("./ipc-utils");
const { getLogger } = require("./logger");

const log = getLogger("external-command-runtime");

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

  function ledgerFor(sessionId) {
    let ledger = externalLedgers.get(sessionId);
    if (!ledger) {
      ledger = new Map();
      externalLedgers.set(sessionId, ledger);
    }
    return ledger;
  }

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
      const ledger = ledgerFor(sessionId);
      const existingRecord = envelope?.commandId ? ledger.get(envelope.commandId) || null : null;
      const decision = decideExternalCommandAdmission({
        envelope,
        existingRecord,
        sessionExists,
        sessionOwned,
      });

      if (["invalid", "payload_conflict", "session_absent", "ownership_mismatch"].includes(decision.outcome)) {
        return { ok: false, code: decision.code };
      }
      if (decision.outcome === "idempotent_hit") return decision.response;

      const state = stateFor(sessionId);
      const item = {
        id: typeof createQueueId === "function" ? createQueueId() : `queue_mobile_${Date.now()}`,
        text: String(envelope.text || ""),
        files: Array.isArray(envelope.files) ? envelope.files : [],
        displayFiles: mergeDisplayFileMetadata(envelope.files || [], envelope.displayFiles),
        options: buildQueueOptions({
          queueOrigin: "mobile_command",
          queueVisibility: "composer",
          externalCommand: {
            commandId: decision.record.commandId,
            idempotencyKey: decision.record.idempotencyKey,
            payloadHash: decision.record.payloadHash,
            requestedMode: decision.record.requestedMode,
            effectiveMode: decision.record.effectiveMode,
            downgradeReason: decision.record.downgradeReason,
            mobileDeviceId: decision.record.mobileDeviceId,
            remoteSessionId: decision.record.remoteSessionId,
          },
        }),
      };
      decision.record.queueItemId = item.id;
      ledger.set(decision.record.commandId, decision.record);
      persist();
      state.queue.push(item);
      emitQueue(sessionId);
      void dispatchNext(sessionId);
      return admissionResponse(decision.record);
    } catch (err) {
      log.warn("admitExternalCommand failed open: %s", err?.message || err);
      return { ok: false, code: "COMMAND_ADMISSION_ERROR" };
    }
  }

  return { admit, ledgers: externalLedgers };
}

module.exports = {
  createExternalCommandRuntime,
  loadLedgers,
};
