"use strict";

const path = require("node:path");
const { Worker } = require("node:worker_threads");

// Only one request is in flight: concurrent UI refreshes cannot multiply the
// inflated history working set. Failures are visible, never retried synchronously.
class MessageReadWorker {
  constructor(filePath) {
    this.filePath = filePath;
    this.queue = [];
    this.active = null;
    this.sequence = 0;
    this.closed = false;
  }
  page(sessionId, opts = {}) {
    return this._request("page", sessionId, opts);
  }
  assistantForTurn(sessionId, turnId) {
    return this._request("assistantForTurn", sessionId, { turnId });
  }
  userRevisionsForTurn(sessionId, turnId) {
    return this._request("userRevisionsForTurn", sessionId, { turnId });
  }
  _request(operation, sessionId, opts) {
    if (this.closed) return Promise.reject(new Error("MESSAGE_READER_CLOSED"));
    return new Promise((resolve, reject) => {
      this.queue.push({ id: ++this.sequence, operation, sessionId, opts: { before: opts.before, limit: opts.limit, workspacePath: opts.workspacePath, turnId: opts.turnId }, resolve, reject });
      this._pump();
    });
  }
  _pump() {
    if (this.closed || this.active || !this.queue.length) return;
    try {
      this._dispatch();
    } catch (error) {
      const worker = this.worker;
      this.worker = null;
      this._rejectAll(error);
      worker?.terminate().catch(() => {});
    }
  }
  _dispatch() {
    if (!this.worker) {
      const worker = new Worker(path.join(__dirname, "message-read-worker.js"), { workerData: { filePath: this.filePath } });
      this.worker = worker;
      worker.on("message", ({ id, value, error }) => {
        if (this.worker !== worker || this.active?.id !== id) return;
        const request = this.active;
        this.active = null;
        if (error) request.reject(Object.assign(new Error(error.message), { code: error.code }));
        else request.resolve(value);
        worker.unref();
        this._pump();
      });
      const fail = error => {
        if (this.worker !== worker) return;
        this.worker = null;
        this._rejectAll(error);
      };
      worker.on("error", fail);
      worker.on("exit", code => fail(new Error(`MESSAGE_READER_EXITED: ${code}`)));
    }
    this.active = this.queue.shift();
    this.worker.ref();
    const { id, operation, sessionId, opts } = this.active;
    this.worker.postMessage({ id, operation, sessionId, opts });
  }
  _rejectAll(error) {
    this.active?.reject(error);
    this.active = null;
    for (const request of this.queue.splice(0)) request.reject(error);
  }
  async close() {
    this.closed = true;
    this._rejectAll(new Error("MESSAGE_READER_CLOSED"));
    const worker = this.worker;
    this.worker = null;
    if (worker) this.closing = worker.terminate();
    await this.closing;
  }
}
module.exports = { MessageReadWorker };
