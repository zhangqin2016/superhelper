"use strict";

const crypto = require("node:crypto");
const path = require("node:path");
const { Worker } = require("node:worker_threads");
const v8 = require("node:v8");
const {
  MAX_CHARACTER_SOURCE_BYTES,
  MAX_CHARACTER_WORKER_RESULT_BYTES,
} = require("./constants");
const { importError } = require("./import-file-authority");

const FORMATS = new Set(["v1_json", "v2_json", "v3_json"]);
const CONTAINERS = new Set(["png", "apng"]);
const MAX_QUEUED_IMPORT_BYTES = 64 * 1024 * 1024;
const DEFAULT_TERMINATION_TIMEOUT_MS = 5000;
const MAX_TERMINATION_TIMEOUT_MS = 30_000;

function plainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function validCompatibility(value) {
  if (!plainObject(value)) return false;
  const arrays = [
    "supported",
    "migrated",
    "preservedInert",
    "ignoredInvalid",
    "rejectedExecutable",
    "warnings",
  ];
  return arrays.every((key) => Array.isArray(value[key]));
}

function validateParsed(value) {
  if (
    plainObject(value)
    && value.ok === false
    && value.kind === "ordinaryAttachment"
    && value.code === "NOT_A_CHARACTER_CARD"
    && Object.keys(value).length === 3
  ) {
    return value;
  }
  if (
    !plainObject(value)
    || value.ok !== true
    || !FORMATS.has(value.format)
    || !plainObject(value.canonical)
    || typeof value.canonical.name !== "string"
    || value.canonical.name.length === 0
    || !plainObject(value.preserved)
    || value.preserved.schemaVersion !== 1
    || !validCompatibility(value.compatibility)
    || (value.container !== undefined && !CONTAINERS.has(value.container))
  ) {
    throw importError("IMPORT_WORKER_PROTOCOL", "Character import worker returned invalid data");
  }
  return value;
}

function workerError(error) {
  const allowed = {};
  for (const key of ["limit", "maximum", "actual", "limitKind", "limitsVersion", "entryId"]) {
    const value = error?.[key];
    // Bounded enums/numbers only — never paths or messages.
    if (Number.isFinite(value)) allowed[key] = value;
    else if (typeof value === "string" && value.length <= 1024) allowed[key] = value;
  }
  const candidate = typeof error?.code === "string" ? error.code : "";
  const code = /^(?:CARD|PNG|WORLD_BOOK)_[A-Z0-9_]{1,70}$/.test(candidate)
    || candidate === "IMPORT_PARSE_FAILED"
    || candidate === "IMPORT_WORKER_RESULT_TOO_LARGE"
    ? candidate
    : "IMPORT_WORKER_PROTOCOL";
  return Object.assign(new Error("Character card could not be parsed"), { code, ...allowed });
}

class CharacterImportWorkerPool {
  constructor({
    workerFile = path.join(__dirname, "import-worker.js"),
    timeoutMs = 35_000,
    maxConcurrency = 2,
    maxQueue = 8,
    maxQueuedBytes = MAX_QUEUED_IMPORT_BYTES,
    terminationTimeoutMs = DEFAULT_TERMINATION_TIMEOUT_MS,
    createWorker,
  } = {}) {
    this.workerFile = path.resolve(workerFile);
    this.timeoutMs = Math.max(10, Math.min(Number(timeoutMs) || 35_000, 60_000));
    this.maxConcurrency = Math.max(
      1,
      Math.min(Math.floor(Number(maxConcurrency) || 2), 4),
    );
    this.maxQueue = Math.max(0, Math.min(Math.floor(Number(maxQueue) || 0), 32));
    this.maxQueuedBytes = Math.max(1, Math.min(
      Math.floor(Number(maxQueuedBytes) || MAX_QUEUED_IMPORT_BYTES),
      MAX_QUEUED_IMPORT_BYTES,
    ));
    this.terminationTimeoutMs = Math.max(10, Math.min(
      Number(terminationTimeoutMs) || DEFAULT_TERMINATION_TIMEOUT_MS,
      MAX_TERMINATION_TIMEOUT_MS,
    ));
    this.createWorker = typeof createWorker === "function"
      ? createWorker
      : (workerFile, options) => new Worker(workerFile, options);
    this.queue = [];
    this.queuedBytes = 0;
    this.active = new Map();
    this.closed = false;
    this.closePromise = null;
  }

  stats() {
    return Object.freeze({ active: this.active.size, queued: this.queue.length });
  }

  parse(input, { signal } = {}) {
    if (this.closed) {
      return Promise.reject(importError("IMPORT_WORKER_CLOSED", "Import worker is closed"));
    }
    if (!Buffer.isBuffer(input) && !(input instanceof Uint8Array)) {
      return Promise.reject(importError("IMPORT_SOURCE_INVALID", "Import source must be bytes"));
    }
    if (input.byteLength > MAX_CHARACTER_SOURCE_BYTES) {
      return Promise.reject(
        importError("IMPORT_SOURCE_TOO_LARGE", "Import source exceeds the size limit"),
      );
    }
    if (signal?.aborted) {
      return Promise.reject(
        importError("IMPORT_PARSE_CANCELLED", "Character import was cancelled"),
      );
    }
    const mustQueue = this.active.size >= this.maxConcurrency;
    if (mustQueue && (
      this.queue.length >= this.maxQueue
      || this.queuedBytes + input.byteLength > this.maxQueuedBytes
    )) {
      return Promise.reject(importError("IMPORT_PARSE_BUSY", "Character import worker is busy"));
    }

    return new Promise((resolve, reject) => {
      const job = {
        id: crypto.randomUUID(),
        bytes: Buffer.from(input),
        signal,
        resolve,
        reject,
        abortListener: null,
        queued: false,
      };
      if (signal) {
        job.abortListener = () => this._cancel(job);
        signal.addEventListener("abort", job.abortListener, { once: true });
      }
      if (this.active.size < this.maxConcurrency) this._start(job);
      else {
        job.queued = true;
        this.queuedBytes += job.bytes.length;
        this.queue.push(job);
      }
    });
  }

  _cancel(job) {
    const queuedIndex = this.queue.indexOf(job);
    if (queuedIndex >= 0) {
      this.queue.splice(queuedIndex, 1);
      this.queuedBytes = Math.max(0, this.queuedBytes - job.bytes.length);
      job.queued = false;
      this._detachAbort(job);
      job.reject(importError("IMPORT_PARSE_CANCELLED", "Character import was cancelled"));
      return;
    }
    const active = this.active.get(job.id);
    if (active) {
      active.finish(
        importError("IMPORT_PARSE_CANCELLED", "Character import was cancelled"),
      );
    }
  }

  _detachAbort(job) {
    if (job.signal && job.abortListener) {
      job.signal.removeEventListener("abort", job.abortListener);
    }
  }

  _start(job) {
    if (job.queued) {
      this.queuedBytes = Math.max(0, this.queuedBytes - job.bytes.length);
      job.queued = false;
    }
    if (this.closed || job.signal?.aborted) {
      this._detachAbort(job);
      job.reject(importError(
        this.closed ? "IMPORT_WORKER_CLOSED" : "IMPORT_PARSE_CANCELLED",
        this.closed ? "Import worker is closed" : "Character import was cancelled",
      ));
      this._drain();
      return;
    }
    let worker;
    try {
      worker = this.createWorker(this.workerFile, {
        resourceLimits: {
          maxOldGenerationSizeMb: 128,
          maxYoungGenerationSizeMb: 32,
          stackSizeMb: 4,
        },
      });
    } catch {
      this._detachAbort(job);
      job.reject(importError("IMPORT_WORKER_CRASH", "Character import worker failed"));
      this._drain();
      return;
    }

    const active = {
      job,
      worker,
      resultSettled: false,
      exited: false,
      exitPromise: null,
      resolveExit: null,
      terminateInvocation: null,
      terminationError: null,
      finish: null,
    };
    active.exitPromise = new Promise((resolve) => {
      active.resolveExit = resolve;
    });
    const finalizeExit = () => {
      if (!this.active.has(job.id)) return;
      clearTimeout(timer);
      worker.removeListener("message", onMessage);
      worker.removeListener("error", onError);
      worker.removeListener("exit", onExit);
      this.active.delete(job.id);
      active.resolveExit();
      this._drain();
    };
    const terminate = () => {
      if (active.terminateInvocation) return active.exitPromise;
      active.terminateInvocation = Promise.resolve()
        .then(() => {
          if (!active.exited) return worker.terminate();
          return undefined;
        })
        .catch((error) => {
          active.terminationError = error;
        });
      return active.exitPromise;
    };
    const finish = (error, value, { workerExited = false } = {}) => {
      if (active.resultSettled) return active.exitPromise;
      active.resultSettled = true;
      clearTimeout(timer);
      this._detachAbort(job);
      worker.removeListener("message", onMessage);
      if (error) job.reject(error);
      else job.resolve(value);
      if (workerExited) {
        finalizeExit();
        return active.exitPromise;
      }
      return terminate();
    };
    active.finish = finish;
    const timer = setTimeout(() => {
      finish(importError("IMPORT_PARSE_TIMEOUT", "Character import parsing timed out"));
    }, this.timeoutMs);
    timer.unref?.();
    this.active.set(job.id, active);
    const onMessage = (message) => {
      if (
        !plainObject(message)
        || message.jobId !== job.id
        || typeof message.ok !== "boolean"
      ) {
        finish(importError(
          "IMPORT_WORKER_PROTOCOL",
          "Character import worker returned an invalid message",
        ));
        return;
      }
      if (!message.ok) {
        if (!plainObject(message.error)) {
          finish(importError(
            "IMPORT_WORKER_PROTOCOL",
            "Character import worker returned an invalid error",
          ));
          return;
        }
        finish(workerError(message.error));
        return;
      }
      try {
        if (
          !(message.payload instanceof ArrayBuffer)
          || message.payload.byteLength > MAX_CHARACTER_WORKER_RESULT_BYTES
        ) {
          throw importError(
            "IMPORT_WORKER_PROTOCOL",
            "Character import worker returned an invalid payload",
          );
        }
        const parsed = v8.deserialize(Buffer.from(message.payload));
        finish(null, validateParsed(parsed));
      } catch (error) {
        finish(error?.code === "IMPORT_WORKER_PROTOCOL"
          ? error
          : importError(
              "IMPORT_WORKER_PROTOCOL",
              "Character import worker returned an invalid payload",
            ));
      }
    };
    const onError = () => {
      finish(importError("IMPORT_WORKER_CRASH", "Character import worker failed"));
    };
    const onExit = () => {
      if (active.exited) return;
      active.exited = true;
      if (!active.resultSettled) {
        finish(
          importError("IMPORT_WORKER_CRASH", "Character import worker exited early"),
          undefined,
          { workerExited: true },
        );
        return;
      }
      finalizeExit();
    };
    worker.once("message", onMessage);
    worker.once("error", onError);
    worker.once("exit", onExit);
    const transferred = Uint8Array.from(job.bytes).buffer;
    job.bytes = null;
    try {
      worker.postMessage({ jobId: job.id, bytes: transferred }, [transferred]);
    } catch {
      finish(importError("IMPORT_WORKER_CRASH", "Character import worker failed"));
    }
  }

  _drain() {
    while (!this.closed && this.active.size < this.maxConcurrency && this.queue.length > 0) {
      this._start(this.queue.shift());
    }
  }

  async close() {
    if (this.closePromise) return this.closePromise;
    if (!this.closed) {
      this.closed = true;
      for (const job of this.queue.splice(0)) {
        this.queuedBytes = Math.max(0, this.queuedBytes - job.bytes.length);
        job.queued = false;
        this._detachAbort(job);
        job.reject(importError("IMPORT_WORKER_CLOSED", "Import worker is closed"));
      }
      this.queuedBytes = 0;
      for (const active of [...this.active.values()]) {
        active.finish(importError("IMPORT_WORKER_CLOSED", "Import worker is closed"));
      }
    }
    const exits = Promise.all(
      [...this.active.values()].map((active) => active.exitPromise),
    );
    let timeout;
    const deadline = new Promise((_, reject) => {
      timeout = setTimeout(() => {
        reject(importError(
          "IMPORT_WORKER_TERMINATION_FAILED",
          "Import worker termination was not confirmed",
        ));
      }, this.terminationTimeoutMs);
    });
    const attempt = Promise.race([exits, deadline])
      .finally(() => {
        clearTimeout(timeout);
        if (this.active.size > 0) this.closePromise = null;
      });
    this.closePromise = attempt;
    return attempt;
  }
}

module.exports = {
  CharacterImportWorkerPool,
};
