"use strict";

const {
  createQueueRecoveryEnvelope,
} = require("./turn-queue-recovery-envelope");

function systemJsonData(value, fallback) {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return fallback;
  }
}

function queueRecoveryEnvelope(item) {
  const options = item.options || {};
  const recoveryOptions = {
    engineText: typeof options.engineText === "string" ? options.engineText : null,
    recordUser: options.recordUser !== false,
    recovery: options.recovery && typeof options.recovery === "object"
      ? options.recovery
      : null,
    localAssistant: options.localAssistant && typeof options.localAssistant === "object"
      ? options.localAssistant
      : null,
    reloadSkillsBeforeStart: Boolean(options.reloadSkillsBeforeStart),
    spawnEngine: options.spawnEngine === false ? false : null,
    skipPreflight: Boolean(options.skipPreflight),
    skipVision: Boolean(options.skipVision),
    skipDocument: Boolean(options.skipDocument),
    scheduledTaskId: options.scheduledTaskId || null,
    scheduledTaskRunId: options.scheduledTaskRunId || null,
    scheduledTaskTitle: options.scheduledTaskTitle || null,
    nonInteractive: options.nonInteractive === true,
    permissionMode: options.permissionMode || null,
    queueOrigin: options.queueOrigin || "user",
    queueVisibility: options.queueVisibility === "background" ? "background" : "composer",
    expectedArtifactPaths: Array.isArray(options.expectedArtifactPaths)
      ? options.expectedArtifactPaths
      : [],
    documentDeliveryRecovery: Boolean(options.documentDeliveryRecovery),
    externalCommand: options.externalCommand && typeof options.externalCommand === "object"
      ? options.externalCommand
      : null,
    sourceTurnId: typeof options.sourceTurnId === "string" ? options.sourceTurnId : null,
    turnId: typeof options.turnId === "string" ? options.turnId : null,
    durableQueueKey: typeof options.durableQueueKey === "string" ? options.durableQueueKey : null,
  };
  return createQueueRecoveryEnvelope({
    item: {
      id: item.id,
      displayFiles: systemJsonData(
        Array.isArray(item.displayFiles) ? item.displayFiles : [],
        [],
      ),
    },
    options: systemJsonData(recoveryOptions, {}),
  });
}

function admissionFailure(subcode = "UNKNOWN") {
  return {
    ok: false,
    error: "TURN_ADMISSION_FAILED",
    subcode,
  };
}

function durableDuplicateResult(admission, queueLength) {
  const turn = admission?.turn || null;
  const outcomeUnknown = [
    "dispatching",
    "outcome_unknown",
    "promoted",
    "accepted",
  ].includes(turn?.status);
  return {
    ok: true,
    duplicate: true,
    queued: false,
    outcomeUnknown,
    queueLength,
    itemId: turn?.metadata?.queueRecovery?.queueItemId || null,
    turnId: turn?.turnId || null,
    durableStatus: turn?.status || "unknown",
    dispatchAttemptId: turn?.dispatchAttemptId || null,
    dispatchStartedAt: turn?.dispatchStartedAt || null,
    acceptedAt: turn?.acceptedAt || turn?.promotedAt || null,
    terminalAt: turn?.terminalAt || null,
    terminalType: turn?.terminalType || null,
    errorCode: turn?.errorCode || null,
  };
}

function createTurnAdmissionMethods(deps = {}) {
  const {
    log,
    mergeDisplayFileMetadata,
    newQueueId,
    newTurnId,
    queueDispatchOptions,
  } = deps;

  return {
    _durableDuplicateResult(admission, queueLength) {
      return durableDuplicateResult(admission, queueLength);
    },

    _admitTurnInput(session, input = {}) {
      const {
        turnId = newTurnId(),
        delivery = "queue",
        status = "admitted",
        userText = "",
        files = [],
        metadata = {},
        createdAt = Date.now(),
        sourceTurnId,
      } = input;
      const manager = this.ctx.sessionManager;
      const hasSource = Object.hasOwn(input, "sourceTurnId");
      const capability = hasSource
        ? manager?.admitTurnInputFromSource
        : manager?.admitTurnInput;
      if (typeof capability !== "function") {
        // Capability-based legacy compatibility: a lightweight SessionManager
        // (tests, embedders) that never grew the durable admission store keeps
        // today's strong native path as a purely in-memory admission. It can
        // never fabricate a character snapshot, inherit a source snapshot, or
        // satisfy a durable queue/scheduled/external admission (those go
        // through _admitQueuedTurn and stay fail-closed).
        if (!hasSource && ["direct", "local", "queue"].includes(delivery)) {
          log.warn(
            "durable turn admission unavailable; using legacy ephemeral native admission: session=%s turn=%s delivery=%s",
            session?.id,
            turnId,
            delivery,
          );
          return {
            sessionId: session?.id || null,
            admittedSeq: null,
            turnId,
            delivery,
            status,
            userText,
            files,
            metadata,
            createdAt,
            ownerScope: null,
            legacyEphemeral: true,
            admissionMode: "legacy_ephemeral_native",
          };
        }
        const error = new Error(
          `TURN_ADMISSION_FAILED: ${hasSource
            ? "source snapshot inheritance requires durable admission"
            : `delivery "${delivery}" requires durable admission`}`,
        );
        error.code = "TURN_ADMISSION_FAILED";
        log.warn("turn input admission failed: %s", error.message);
        throw error;
      }
      try {
        const admissionInput = {
          turnId,
          delivery,
          status,
          userText,
          files,
          metadata,
          createdAt,
        };
        if (hasSource) {
          const admitted = manager.admitTurnInputFromSource(
            session.id,
            admissionInput,
            sourceTurnId,
          ) || null;
          if (admitted) return admitted;
        } else {
          const admitted = manager.admitTurnInput(
            session.id,
            admissionInput,
          ) || null;
          if (admitted) return admitted;
        }
        const error = new Error("TURN_ADMISSION_FAILED");
        error.code = "TURN_ADMISSION_FAILED";
        throw error;
      } catch (err) {
        log.warn("turn input admission failed: %s", err?.message || err);
        throw err;
      }
    },

    _admitQueuedTurn(session, item, options = {}) {
      if (!session || !item) return admissionFailure("MISSING_QUEUE_ITEM");
      const admissionOptions = {
        turnId: item.admittedTurnInput?.turnId
          || item.options?.turnId
          || item.options?.localAssistant?.turnId
          || newTurnId(),
        delivery: options.delivery || "queue",
        status: "admitted",
        userText: item.text,
        files: item.files || [],
        metadata: options.metadata || {
          fromQueue: true,
          scheduledTaskId: item.options?.scheduledTaskId || null,
          scheduledTaskRunId: item.options?.scheduledTaskRunId || null,
        },
        createdAt: Date.now(),
      };
      if (Object.hasOwn(item.options || {}, "sourceTurnId")) {
        admissionOptions.sourceTurnId = item.options.sourceTurnId;
      }
      let result = null;
      try {
        const recoveryEnvelope = queueRecoveryEnvelope(item);
        item.files = recoveryEnvelope.fileRefs;
        admissionOptions.files = recoveryEnvelope.fileRefs;
        const admitQueued = this.ctx.sessionManager?.admitQueuedTurnInput;
        if (typeof admitQueued !== "function") {
          // Durable queue turns (scheduled, external, recovered) can never fall
          // back to an ephemeral admission — without the durable store there is
          // no linearization point, so this fails closed.
          return admissionFailure("ADMISSION_CAPABILITY_UNAVAILABLE");
        }
        result = admitQueued.call(
          this.ctx.sessionManager,
          session.id,
          admissionOptions,
          recoveryEnvelope,
          Object.hasOwn(item.options || {}, "sourceTurnId")
            ? item.options.sourceTurnId
            : null,
        ) || null;
      } catch (err) {
        log.warn("queued turn input admission failed: %s", err?.message || err);
        return admissionFailure(err?.code || "STORE_ERROR");
      }
      if (!result) return admissionFailure("STORE_REJECTED");
      if (!Object.hasOwn(result, "ok")) {
        result = {
          ok: true,
          inserted: true,
          duplicate: false,
          legacy: true,
          turn: result,
        };
      }
      if (!result.ok || !result.turn) {
        return admissionFailure(result.error || "STORE_REJECTED");
      }
      item.admittedTurnInput = result.turn;
      return result;
    },

    async sendUserMessage(sessionId, text, files = [], opts = {}) {
      const session = this.ctx.sessionManager.findById(sessionId);
      if (!session) return { ok: false, error: "NO_SESSION" };
      const displayText = String(text || "").trim();
      if (!displayText && (!files || files.length === 0)) {
        return { ok: false, error: "EMPTY" };
      }
      const state = this._state(sessionId);
      const scheduledRunId = String(opts.scheduledTaskRunId || "");
      const durableQueueKey = String(opts.durableQueueKey || "");
      if ((scheduledRunId || durableQueueKey) && !opts.fromQueue) {
        const item = {
          id: newQueueId(),
          text: displayText,
          files,
          displayFiles: mergeDisplayFileMetadata(files, opts.displayFiles),
          options: queueDispatchOptions(opts),
        };
        const admission = this._admitQueuedTurn(session, item);
        if (!admission.ok) return admission;
        if (admission.duplicate) {
          return durableDuplicateResult(admission, state.queue.length);
        }
        state.queue.push(item);
        this._emitQueue(sessionId);
        if (state.phase === "idle") void this._dispatchNext(sessionId);
        return {
          ok: true,
          queued: true,
          queueLength: state.queue.length,
          itemId: item.id,
          turnId: admission.turn?.turnId || null,
        };
      }
      if ((state.phase !== "idle" || state.startInFlight) && !opts.fromQueue) {
        if (opts.mode === "steer" && process.env.LILY_ENABLE_STEER !== "0") {
          const steered = await this._trySteer(session, displayText, files, opts);
          if (steered?.ok) return steered;
        }
        const item = {
          id: newQueueId(),
          text: displayText,
          files,
          displayFiles: mergeDisplayFileMetadata(files, opts.displayFiles),
          options: queueDispatchOptions(opts),
        };
        const admission = this._admitQueuedTurn(session, item);
        if (!admission.ok) {
          // Capability-based legacy fallback: a lightweight SessionManager
          // without the durable admission store keeps today's ephemeral user
          // queue (the pre-durable baseline). Scheduled/external/durable
          // paths call _admitQueuedTurn directly and still fail closed.
          if (admission.subcode !== "ADMISSION_CAPABILITY_UNAVAILABLE") {
            return admission;
          }
          state.queue.push(item);
          this._emitQueue(sessionId);
          return {
            ok: true,
            queued: true,
            legacyEphemeral: true,
            queueLength: state.queue.length,
            itemId: item.id,
            ...(opts.mode === "steer" ? { steerFellBack: true } : {}),
          };
        }
        if (admission.duplicate) {
          return durableDuplicateResult(admission, state.queue.length);
        }
        state.queue.push(item);
        this._emitQueue(sessionId);
        return {
          ok: true,
          queued: true,
          queueLength: state.queue.length,
          itemId: item.id,
          ...(opts.mode === "steer" ? { steerFellBack: true } : {}),
        };
      }
      return require("./turn-start-guard").guardTurnStart(
        this,
        session,
        displayText,
        files,
        opts,
      );
    },

    echoUserMessage(sessionId, text, files = [], displayFiles = null) {
      const session = this.ctx.sessionManager.findById(sessionId);
      if (!session) return null;
      const displayText = String(text || "").trim();
      const fileMeta = mergeDisplayFileMetadata(files, displayFiles);
      if (!displayText && !(fileMeta || []).length) return null;
      const turnId = newTurnId();
      this._admitTurnInput(session, {
        turnId,
        delivery: "local",
        status: "admitted",
        userText: displayText,
        files: fileMeta,
        metadata: { echoed: true, localAssistant: true },
        createdAt: Date.now(),
      });
      try {
        this.transcriptStore.commitUserMessage(sessionId, {
          text: displayText,
          files: fileMeta,
          turnId,
        });
      } catch (err) {
        log.warn("echo user message commit failed: %s", err?.message || err);
      }
      this._emit(
        sessionId,
        "user.committed",
        { text: displayText, files: fileMeta && fileMeta.length ? fileMeta : null },
        { turnId },
      );
      return turnId;
    },

    async interruptAndSend(sessionId, text, files = [], opts = {}) {
      const session = this.ctx.sessionManager.findById(sessionId);
      if (!session) return { ok: false, error: "NO_SESSION" };
      const state = this._state(sessionId);
      const item = {
        id: newQueueId(),
        text: String(text || "").trim(),
        files,
        displayFiles: mergeDisplayFileMetadata(files, opts.displayFiles),
        options: queueDispatchOptions(opts),
      };
      const replaced = this._removeQueuedItemsDurably(
        sessionId,
        () => true,
        "QUEUE_REPLACED",
      );
      if (replaced.rejected.length) {
        const outcomeUnknown = replaced.rejected.some(
          ({ result }) => result?.outcomeUnknown,
        );
        return {
          ok: false,
          error: outcomeUnknown
            ? "DISPATCH_OUTCOME_UNKNOWN"
            : "QUEUE_REPLACE_FAILED",
          queueOutcomeUnknown: outcomeUnknown,
          queueLength: state.queue.length,
        };
      }
      const admission = this._admitQueuedTurn(session, item);
      if (!admission.ok) {
        // Same capability-based legacy fallback as sendUserMessage: the
        // ephemeral user queue is the pre-durable baseline for lightweight
        // SessionManager adapters.
        if (admission.subcode !== "ADMISSION_CAPABILITY_UNAVAILABLE") {
          return admission;
        }
        state.queue.push(item);
        this._emitQueue(sessionId);
        require("./turn-start-guard").cancelTurnStart(this, sessionId);
        this.interrupt(sessionId, { clearQueue: false });
        void this._dispatchNext(sessionId);
        return {
          ok: true,
          queued: true,
          priority: true,
          legacyEphemeral: true,
          queueLength: state.queue.length,
          itemId: item.id,
        };
      }
      if (admission.duplicate) {
        return durableDuplicateResult(admission, state.queue.length);
      }
      state.queue.push(item);
      this._emitQueue(sessionId);
      require("./turn-start-guard").cancelTurnStart(this, sessionId);
      this.interrupt(sessionId, { clearQueue: false });
      void this._dispatchNext(sessionId);
      return {
        ok: true,
        queued: true,
        priority: true,
        queueLength: state.queue.length,
        itemId: item.id,
      };
    },
  };
}

module.exports = { createTurnAdmissionMethods };
