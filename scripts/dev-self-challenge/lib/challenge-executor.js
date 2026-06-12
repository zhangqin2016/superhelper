"use strict";

const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const ENGINE_CANDIDATES = [
  path.resolve(
    __dirname,
    "..",
    "..",
    "..",
    "..",
    "Library",
    "Application Support",
    "lily-workbench",
    "lily-bin",
    "lily-workbench",
  ),
];

const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000; // 15 minutes
const MAX_OUTPUT_SIZE = 500 * 1024; // 500 KB

class ChallengeExecutor {
  /**
   * @param {object} [opts]
   * @param {number} [opts.timeoutMs] - Max execution time in ms (default 15 min)
   * @param {string} [opts.command] - Override the engine command (for testing)
   */
  constructor(opts = {}) {
    this._timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this._command = opts.command;
  }

  /**
   * Resolve the engine CLI binary path.
   * Checks ENGINE_CANDIDATES paths; falls back to "echo" if none found.
   * @returns {string}
   */
  _resolveCommand() {
    if (this._command) {
      return this._command;
    }

    for (const candidate of ENGINE_CANDIDATES) {
      try {
        fs.accessSync(candidate, fs.constants.X_OK);
        return candidate;
      } catch {
        continue;
      }
    }

    return "echo";
  }

  /**
   * Execute a challenge by spawning the engine as a child process.
   *
   * Writes the prompt to stdin and collects stdout/stderr.
   *
   * @param {object} opts
   * @param {string} opts.prompt - The challenge prompt text
   * @param {string} [opts.cwd] - Working directory (default process.cwd())
   * @returns {Promise<{ok: boolean, output: string, errorOutput: string, durationMs: number, error?: string}>}
   */
  async execute(opts = {}) {
    const prompt = opts.prompt;
    const cwd = opts.cwd || process.cwd();
    const command = this._resolveCommand();
    const startTime = Date.now();

    return new Promise((resolve) => {
      let child;
      try {
        // detached: true creates a new process group so we can kill the whole
        // tree on timeout (critical when the command wraps a child like sh + sleep)
        child = spawn(command, [], {
          cwd,
          env: { ...process.env },
          stdio: ["pipe", "pipe", "pipe"],
          detached: true,
        });
      } catch (err) {
        return resolve({
          ok: false,
          output: "",
          errorOutput: "",
          durationMs: Date.now() - startTime,
          error: err.message,
        });
      }

      let stdout = "";
      let stderr = "";
      let settled = false;

      // Manual timeout — send SIGTERM to the entire process group so that
      // spawned children (e.g. sh + sleep) are killed together; otherwise
      // orphaned children keep the pipe open and "close" never fires.
      const timeoutId = setTimeout(() => {
        if (!settled && child.pid !== undefined) {
          try {
            process.kill(-child.pid, "SIGTERM");
          } catch {
            // process group may already have exited
          }
        }
      }, this._timeoutMs);

      child.stdout.on("data", (chunk) => {
        if (stdout.length < MAX_OUTPUT_SIZE) {
          stdout += chunk.toString();
        }
      });

      child.stderr.on("data", (chunk) => {
        if (stderr.length < MAX_OUTPUT_SIZE) {
          stderr += chunk.toString();
        }
      });

      child.on("error", (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutId);
        resolve({
          ok: false,
          output: stdout,
          errorOutput: stderr,
          durationMs: Date.now() - startTime,
          error: err.message,
        });
      });

      child.on("close", (code, signal) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutId);
        const durationMs = Date.now() - startTime;
        const result = {
          ok: code === 0,
          output: stdout,
          errorOutput: stderr,
          durationMs,
        };
        if (code !== 0) {
          result.error = signal
            ? `Process terminated by ${signal}`
            : `Exited with code ${code}`;
        }
        resolve(result);
      });

      // Write prompt to stdin, then close it
      try {
        if (prompt !== undefined && prompt !== null) {
          child.stdin.write(prompt);
        }
        child.stdin.end();
      } catch {
        // stdin might be destroyed/in error state (e.g. ENOENT)
      }
    });
  }
}

module.exports = { ChallengeExecutor };
