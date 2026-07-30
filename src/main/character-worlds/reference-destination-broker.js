"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { fork } = require("node:child_process");
const {
  DESTINATION_BROKER_PROTOCOL,
} = require("./destination-broker-protocol");
const {
  identity,
  importError,
  sameFilesystemObject,
} = require("./file-authority-shared");
const {
  ReferenceDestinationReservation,
} = require("./reference-destination-reservation");
const {
  beginCommitRequest,
  failCommitRequest,
  settleCommitResponse,
} = require("./reference-commit-request");
const {
  helperEnvironment,
} = require("./reference-destination-support");

const DEFAULT_REQUEST_TIMEOUT_MS = 5000;
const MAX_REQUEST_TIMEOUT_MS = 30_000;
const MAX_FILE_NAME_BYTES = 255;
const WINDOWS_RESERVED_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;

// This broker is created by Electron main from a save-dialog-approved parent.
// Its helper process binds that directory as cwd before any reservation exists;
// renderer input is limited to a portable basename. Same-privilege local
// processes remain outside the renderer threat boundary.
function stableBrokerError(error, fallbackCode = "EXPORT_BROKER_FAILURE") {
  if (typeof error?.code === "string" && error.code.startsWith("EXPORT_")) {
    return importError(error.code, "Destination broker operation failed");
  }
  return importError(fallbackCode, "Destination broker operation failed");
}

function validFileName(fileName) {
  return typeof fileName === "string"
    && fileName.length > 0
    && Buffer.byteLength(fileName, "utf8") <= MAX_FILE_NAME_BYTES
    && fileName !== "."
    && fileName !== ".."
    && !fileName.startsWith(".")
    && !/[\/\\:\u0000-\u001f\u007f]/.test(fileName)
    && !/[ .]$/.test(fileName)
    && !WINDOWS_RESERVED_NAME.test(fileName);
}

function signalError() {
  return importError("EXPORT_WRITE_CANCELLED", "Character export was cancelled");
}

class ReferenceDestinationBroker {
  constructor({
    approvedParent,
    beforeSpawn,
    requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
    forkProcess = fork,
    testReserveDelayMs = 0,
    testCommitDelayMs = 0,
    testCommitNeverRespond = false,
  } = {}) {
    if (typeof approvedParent !== "string" || approvedParent.length === 0) {
      throw new TypeError("approvedParent is required");
    }
    if (typeof forkProcess !== "function") {
      throw new TypeError("forkProcess must be a function");
    }
    this.protocol = DESTINATION_BROKER_PROTOCOL;
    this.requestTimeoutMs = Math.max(10, Math.min(
      Number.isSafeInteger(requestTimeoutMs)
        ? requestTimeoutMs
        : DEFAULT_REQUEST_TIMEOUT_MS,
      MAX_REQUEST_TIMEOUT_MS,
    ));
    this.auth = crypto.randomBytes(32).toString("hex");
    this.pending = new Map();
    this.controlRequests = new Map();
    this.cancelledRequests = new Map();
    this.reservations = new Set();
    this.sequence = 0;
    this.closed = false;
    this.closing = false;
    this.closePromise = null;
    this.child = null;
    this.readyError = null;
    let startupError = null;

    let canonicalParent;
    let expectedIdentity;
    try {
      canonicalParent = fs.realpathSync(approvedParent);
      const parentStat = fs.statSync(canonicalParent, { bigint: true });
      if (!parentStat.isDirectory()) throw new Error("not a directory");
      expectedIdentity = identity(parentStat);
    } catch {
      startupError = importError(
        "EXPORT_DESTINATION_UNAUTHORIZED",
        "Export destination is not authorized",
      );
    }

    let settleReady;
    let rejectReady;
    this.readyPromise = new Promise((resolve, reject) => {
      settleReady = resolve;
      rejectReady = reject;
    });
    void this.readyPromise.catch(() => {});
    this._settleReady = settleReady;
    this._rejectReady = rejectReady;

    if (startupError) {
      queueMicrotask(() => this._failReady(startupError));
      return;
    }

    try {
      beforeSpawn?.();
      const helperEnv = helperEnvironment(
        process.env,
        this.auth,
        Math.max(0, Math.min(Number(testReserveDelayMs) || 0, 1000)),
        Math.max(0, Math.min(Number(testCommitDelayMs) || 0, 1000)),
        testCommitNeverRespond === true,
      );
      const helperPath = path.join(__dirname, "destination-broker-helper.js");
      this.child = forkProcess(helperPath, [], {
        cwd: canonicalParent,
        env: helperEnv,
        serialization: "advanced",
        stdio: ["ignore", "ignore", "ignore", "ipc"],
      });
      this.child.on("message", (message) => this._onMessage(message, expectedIdentity));
      this.child.once("error", () => this._failProcess());
      this.child.once("exit", () => this._failProcess());
      this.readyTimer = setTimeout(() => {
        this._failReady(importError(
          "EXPORT_BROKER_TIMEOUT",
          "Destination broker startup timed out",
        ));
        this._terminate();
      }, this.requestTimeoutMs);
      this.readyTimer.unref?.();
    } catch {
      this._failReady(importError(
        "EXPORT_DESTINATION_CHANGED",
        "Export destination changed during approval",
      ));
    }
  }

  _failReady(error) {
    if (this.readyError) return;
    this.readyError = error;
    if (this.readyTimer) clearTimeout(this.readyTimer);
    this.readyTimer = null;
    this._rejectReady(error);
  }

  _takePending(id) {
    const pending = this.pending.get(id);
    if (!pending) return null;
    this.pending.delete(id);
    clearTimeout(pending.timer);
    if (pending.signal && pending.abortListener) {
      pending.signal.removeEventListener("abort", pending.abortListener);
    }
    return pending;
  }

  _forgetCancelled(id) {
    const cancelled = this.cancelledRequests.get(id);
    if (!cancelled) return;
    clearTimeout(cancelled.timer);
    this.cancelledRequests.delete(id);
  }

  _failProcess() {
    if (!this.readyError && !this.closed) {
      this._failReady(importError(
        "EXPORT_BROKER_FAILURE",
        "Destination broker failed",
      ));
    }
    for (const [id] of this.pending) {
      const pending = this._takePending(id);
      if (pending.type === "commit") {
        failCommitRequest(pending);
      } else {
        pending.reject(importError(
          this.closed ? "EXPORT_DESTINATION_CLOSED" : "EXPORT_BROKER_FAILURE",
          "Destination broker stopped",
        ));
      }
    }
    this.pending.clear();
    for (const control of this.controlRequests.values()) clearTimeout(control.timer);
    this.controlRequests.clear();
    for (const id of this.cancelledRequests.keys()) this._forgetCancelled(id);
  }

  _onMessage(message, expectedIdentity) {
    if (!message || message.auth !== this.auth) return;
    if (message.kind === "hello") {
      if (
        message.version !== DESTINATION_BROKER_PROTOCOL.version
        || !sameFilesystemObject(expectedIdentity, message.identity || {})
      ) {
        this._failReady(importError(
          "EXPORT_DESTINATION_CHANGED",
          "Export destination changed during approval",
        ));
        this._terminate();
        return;
      }
      if (this.readyTimer) clearTimeout(this.readyTimer);
      this.readyTimer = null;
      this._settleReady();
      return;
    }
    if (typeof message.id !== "string") return;
    const control = this.controlRequests.get(message.id);
    if (control) {
      this.controlRequests.delete(message.id);
      clearTimeout(control.timer);
      if (message.ok !== true) {
        this._terminate();
      } else if (control.type !== "cancelRequest") {
        this._forgetCancelled(control.requestId);
      } else if (message.result?.cancelled === true) {
        this._forgetCancelled(control.requestId);
      } else {
        const cancelled = this.cancelledRequests.get(control.requestId);
        if (cancelled) {
          cancelled.cancelPending = false;
          if (cancelled.reservationId) {
            this._sendControl("release", {
              reservationId: cancelled.reservationId,
            }, control.requestId);
          }
        }
      }
      return;
    }
    const pending = this._takePending(message.id);
    if (!pending) {
      const cancelled = this.cancelledRequests.get(message.id);
      if (cancelled?.type === "reserve") {
        if (
          message.ok === true
          && typeof message.result?.reservationId === "string"
        ) {
          cancelled.reservationId = message.result.reservationId;
          if (!cancelled.cancelPending) {
            this._sendControl("release", {
              reservationId: message.result.reservationId,
            }, message.id);
          }
        } else {
          this._forgetCancelled(message.id);
          if (message.ok !== false) this._terminate();
        }
      }
      return;
    }
    if (pending.type === "commit") {
      settleCommitResponse(pending, message, stableBrokerError);
      return;
    }
    if (message.ok === true) {
      pending.resolve(message.result);
    } else {
      pending.reject(stableBrokerError(message.error));
    }
  }

  _sendControl(type, payload, requestId) {
    if (!this.child?.connected) {
      this._terminate();
      return;
    }
    const id = `${this.auth.slice(0, 16)}-control-${++this.sequence}`;
    const timer = setTimeout(() => {
      this.controlRequests.delete(id);
      this._terminate();
    }, this.requestTimeoutMs);
    timer.unref?.();
    this.controlRequests.set(id, { type, requestId, timer });
    this.child.send({ auth: this.auth, id, type, payload }, (error) => {
      if (!error) return;
      const control = this.controlRequests.get(id);
      if (!control) return;
      this.controlRequests.delete(id);
      clearTimeout(control.timer);
      this._terminate();
    });
  }

  _compensateReserve(id) {
    const timer = setTimeout(() => {
      this._forgetCancelled(id);
      this._terminate();
    }, this.requestTimeoutMs);
    timer.unref?.();
    this.cancelledRequests.set(id, {
      type: "reserve",
      timer,
      cancelPending: true,
      reservationId: null,
    });
    this._sendControl("cancelRequest", { requestId: id }, id);
  }

  _terminate() {
    if (!this.child) return;
    this.child.removeAllListeners("message");
    this.child.kill();
  }

  _forget(reservation) {
    this.reservations.delete(reservation);
  }

  async ready() {
    return this.readyPromise;
  }

  _beginCommit(payload, options) {
    if (this.closed || this.closing) {
      throw importError("EXPORT_DESTINATION_CLOSED", "Destination broker is closed");
    }
    return beginCommitRequest(this, payload, options, stableBrokerError);
  }

  async _request(type, payload, { signal, deadline, allowClosed = false } = {}) {
    await this.ready();
    if (this.closed && !allowClosed) {
      throw importError("EXPORT_DESTINATION_CLOSED", "Destination broker is closed");
    }
    if (signal?.aborted) throw signalError();
    const now = Date.now();
    const requestedDeadline = Number.isFinite(deadline)
      ? Math.trunc(deadline)
      : now + this.requestTimeoutMs;
    const expiresAt = Math.min(requestedDeadline, now + this.requestTimeoutMs);
    if (expiresAt <= now) {
      throw importError("EXPORT_BROKER_TIMEOUT", "Destination broker request timed out");
    }
    const id = `${this.auth.slice(0, 16)}-${++this.sequence}`;
    return new Promise((resolve, reject) => {
      let sent = false;
      const abortListener = () => {
        const pending = this._takePending(id);
        if (!pending) return;
        if (sent && type === "reserve") this._compensateReserve(id);
        pending.reject(signalError());
      };
      const timer = setTimeout(() => {
        const pending = this._takePending(id);
        if (!pending) return;
        pending.reject(importError(
          "EXPORT_BROKER_TIMEOUT",
          "Destination broker request timed out",
        ));
        this._terminate();
      }, expiresAt - now);
      timer.unref?.();
      this.pending.set(id, {
        resolve,
        reject,
        timer,
        signal: signal || null,
        abortListener,
      });
      if (signal) signal.addEventListener("abort", abortListener, { once: true });
      if (signal?.aborted) {
        abortListener();
        return;
      }
      sent = true;
      this.child.send({ auth: this.auth, id, type, payload }, (error) => {
        if (!error) return;
        const pending = this._takePending(id);
        if (!pending) return;
        pending.reject(stableBrokerError(error));
      });
    });
  }

  async reserve(request, { overwrite = false, signal, deadline } = {}) {
    if (this.closed || this.closing) {
      throw importError("EXPORT_DESTINATION_CLOSED", "Destination broker is closed");
    }
    if (overwrite) {
      throw importError(
        "EXPORT_OVERWRITE_UNSUPPORTED",
        "Character export does not overwrite existing files",
      );
    }
    const fileName = request?.fileName;
    if (!validFileName(fileName) || Object.keys(request || {}).length !== 1) {
      throw importError("EXPORT_DESTINATION_INVALID", "Export destination is invalid");
    }
    if (signal?.aborted) throw signalError();
    const result = await this._request("reserve", { fileName }, { signal, deadline });
    const reservation = new ReferenceDestinationReservation(
      this,
      result?.reservationId,
      result?.fileName,
    );
    this.reservations.add(reservation);
    if (signal?.aborted) {
      await reservation.release({ deadline });
      throw signalError();
    }
    return reservation;
  }

  stats() {
    return {
      reservations: this.reservations.size,
      closed: this.closed,
    };
  }

  _commitAdmissionError() {
    const active = [...this.reservations]
      .filter((reservation) => reservation.commitOperation);
    const pending = [...this.pending.values()]
      .some((request) => request.type === "commit");
    if (active.length === 0 && !pending) return null;
    const unknown = active.some((reservation) => reservation.outcomeUnknown)
      || active.length === 0;
    return importError(
      unknown ? "EXPORT_COMMIT_OUTCOME_UNKNOWN" : "EXPORT_COMMIT_IN_PROGRESS",
      "Export commit prevents destination broker cleanup",
    );
  }

  async close({ deadline } = {}) {
    if (this.closed) return;
    if (this.closePromise) return this.closePromise;
    const commitError = this._commitAdmissionError();
    if (commitError) throw commitError;
    this.closing = true;
    const attempt = (async () => {
      try {
        if (!this.readyError) {
          await this._request("close", {}, {
            deadline: Number.isFinite(deadline)
              ? deadline
              : Date.now() + this.requestTimeoutMs,
            allowClosed: true,
          });
        }
        for (const reservation of this.reservations) reservation.released = true;
        this.reservations.clear();
        this.closed = true;
        this.closing = false;
        this._terminate();
      } catch (error) {
        throw stableBrokerError(error, "EXPORT_CLOSE_FAILED");
      }
    })().finally(() => {
      if (!this.closed) {
        this.closing = false;
        this.closePromise = null;
      }
    });
    this.closePromise = attempt;
    return attempt;
  }
}

function createReferenceDestinationBroker(options) {
  return new ReferenceDestinationBroker(options);
}

module.exports = {
  ReferenceDestinationBroker,
  createReferenceDestinationBroker,
};
