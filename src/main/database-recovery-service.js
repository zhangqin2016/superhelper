"use strict";

const path = require("node:path");
const { fork } = require("node:child_process");
const ACTIONS = new Set(["inspect", "prepare", "restore", "backup", "receipt", "ack"]);

/** One worker at a time, including the interval between timeout and process exit.
 * The main process never opens a database on behalf of the repair window.
 */
class DatabaseRecoveryService {
  constructor(dbPath, { forkImpl = fork, timeoutMs = 120_000 } = {}) {
    this.dbPath = dbPath;
    this.forkImpl = forkImpl;
    this.timeoutMs = timeoutMs;
    this.active = null;
    this.closed = false;
    this.lastResult = null;
  }

  async run(action, id) {
    if (this.closed) return { ok: false, reason: "closed" };
    if (!ACTIONS.has(action)) return { ok: false, reason: "invalid_action" };
    if (this.active) return { ok: false, reason: "busy" };
    let child;
    try {
      child = this.forkImpl(path.join(__dirname, "database-recovery-worker.js"), [], {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
        stdio: ["ignore", "ignore", "ignore", "ipc"],
        windowsHide: true,
      });
    } catch { return { ok: false, reason: "worker_unavailable" }; }
    const operation = { child, reason: null };
    this.active = operation;
    const result = await new Promise(resolve => {
      let receipt = null;
      let settled = false;
      const timer = setTimeout(() => {
        operation.reason = "timeout";
        try { child.kill("SIGKILL"); } catch { /* remain fenced until exit */ }
      }, this.timeoutMs);
      const finish = (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.active = null;
        resolve(operation.reason ? { ok: false, reason: operation.reason }
          : code === 0 && receipt ? receipt : { ok: false, reason: "worker_exit" });
      };
      child.on("message", message => {
        if (message?.type === "database-recovery-result") receipt = message.result;
      });
      child.once("exit", finish);
      child.on("error", () => {
        operation.reason ||= "worker_unavailable";
        // Spawn failures have no live process and no exit event.
        if (!child.pid) finish(1);
        else { try { child.kill("SIGKILL"); } catch { /* exit owns release */ } }
      });
      try { child.send({ action, dbPath: this.dbPath, id }); }
      catch { operation.reason = "worker_unavailable"; try { child.kill("SIGKILL"); } catch {} }
    });
    this.lastResult = { action, at: new Date().toISOString(), ...result };
    return result;
  }

  close() {
    this.closed = true;
    if (!this.active) return;
    this.active.reason = "cancelled";
    try { this.active.child.kill("SIGKILL"); } catch { /* no new operations allowed */ }
  }
}

module.exports = { DatabaseRecoveryService };
