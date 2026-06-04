"use strict";

const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const { resolveAgentCommand } = require("./agent-command");
const { buildAgentSpawnEnv } = require("./spawn-env");

/** @type {typeof import("node-pty")} */
let pty;
try {
  pty = require("node-pty");
} catch {
  // node-pty is optional; falls back to stream-json
}

class PtySession extends EventEmitter {
  /**
   * @param {string} sessionId
   * @param {{ cwd?: string, permissionMode?: string, configDir?: string }} opts
   */
  constructor(sessionId, opts = {}) {
    super();
    this.sessionId = sessionId;
    this.cwd = opts.cwd || process.cwd();
    this.permissionMode = opts.permissionMode || "default";
    this.configDir = opts.configDir || null;

    /** @type {import("node-pty").IPty | null} */
    this.process = null;
    this.busy = false;
    this.cols = 120;
    this.rows = 40;
    this.agentCommand = null;
  }

  isAlive() {
    return this.process !== null;
  }

  /**
   * Spawn Claude CLI inside a PTY in interactive terminal mode.
   * @param {{ cwd?: string, additionalDirs?: string[], resumeSessionId?: string }} [opts]
   */
  spawn(opts = {}) {
    if (!pty) {
      this.emit("error", new Error("node-pty is not available"));
      return false;
    }
    if (this.process) this.kill();

    // Resolve CLI binary using the same logic as AgentSession
    const agentCommand = resolveAgentCommand();
    if (!agentCommand || !fs.existsSync(agentCommand)) {
      this.emit("error", new Error(`CLI not found: ${agentCommand || "null"}`));
      return false;
    }
    this.agentCommand = agentCommand;

    const cwd = opts.cwd || this.cwd;

    // Build spawn env — but keep TERM=xterm-256color for full TUI,
    // and remove NO_COLOR so ANSI colors render properly.
    const env = Object.assign(
      {},
      process.env,
      buildAgentSpawnEnv({ configDir: this.configDir || undefined }),
      { TERM: "xterm-256color" },
    );
    delete env.NO_COLOR;

    // CLI args for interactive terminal mode (NO stream-json flags)
    const args = ["-p"];
    if (this.permissionMode && this.permissionMode !== "default") {
      args.push("--permission-mode", this.permissionMode);
    }
    if (opts.additionalDirs?.length) {
      for (const dir of opts.additionalDirs) {
        if (fs.existsSync(dir)) args.push("--add-dir", dir);
      }
    }
    if (opts.resumeSessionId) {
      args.push("--resume", opts.resumeSessionId);
    }

    try {
      this.process = pty.spawn(agentCommand, args, {
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
