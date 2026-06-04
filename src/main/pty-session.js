"use strict";

const { EventEmitter } = require("node:events");
const path = require("node:path");
const { buildAgentSpawnEnv } = require("./spawn-env");

/** @type {typeof import("node-pty")} */
let pty;
try {
  pty = require("node-pty");
} catch {
  // node-pty is optional; app falls back gracefully
}

class PtySession extends EventEmitter {
  /**
   * @param {string} sessionId
   * @param {{ cwd?: string, claudeBin?: string, permissionMode?: string }} opts
   */
  constructor(sessionId, opts = {}) {
    super();
    this.sessionId = sessionId;
    this.cwd = opts.cwd || process.cwd();
    this.claudeBin = opts.claudeBin || "claude";
    this.permissionMode = opts.permissionMode || "default";

    /** @type {import("node-pty").IPty | null} */
    this.process = null;
    this.busy = false;
    this.cols = 120;
    this.rows = 40;
  }

  isAlive() {
    return this.process !== null;
  }

  /**
   * Spawn Claude CLI inside a PTY.
   * @param {{ cwd?: string, additionalDirs?: string[] }} [opts]
   */
  spawn(opts = {}) {
    if (!pty) {
      this.emit("error", new Error("node-pty is not available"));
      return false;
    }
    if (this.process) this.kill();

    const cwd = opts.cwd || this.cwd;
    const env = buildAgentSpawnEnv(process.env, {});

    const args = [];
    if (opts.additionalDirs?.length) {
      for (const dir of opts.additionalDirs) {
        args.push("--add-dir", dir);
      }
    }

    try {
      this.process = pty.spawn(this.claudeBin, args, {
        name: "xterm-256color",
        cols: this.cols,
        rows: this.rows,
        cwd,
        env,
      });
    } catch (err) {
      this.emit("error", err);
      return false;
    }

    this.busy = true;

    this.process.onData((data) => {
      this.emit("pty-data", data);
    });

    this.process.onExit(({ exitCode, signal }) => {
      this.busy = false;
      this.process = null;
      this.emit("pty-exit", { exitCode, signal });
    });

    return true;
  }

  /** Write user input to the PTY (keyboard or pasted text). */
  write(data) {
    if (!this.process) return;
    this.process.write(data);
  }

  /** Resize the PTY terminal. */
  resize(cols, rows) {
    if (!this.process) return;
    this.cols = cols;
    this.rows = rows;
    try {
      this.process.resize(cols, rows);
    } catch {
      // ignore resize errors on dead PTY
    }
  }

  /** Kill the PTY process. */
  kill() {
    if (this.process) {
      try {
        this.process.kill();
      } catch {
        // already dead
      }
      this.process = null;
      this.busy = false;
    }
  }
}

module.exports = { PtySession };
