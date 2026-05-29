"use strict";

const { EventEmitter } = require("node:events");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const { appendTextSegment, sanitizeError } = require("./agent-runner");
const { buildAgentSpawnEnv } = require("./spawn-env");
const { sameSpawnOptions } = require("./runner-spawn-options");

/**
 * One long-lived engine process per app session (`stream-json` protocol).
 * Multi-turn: each user message is one JSON line on stdin.
 */
class AgentSession extends EventEmitter {
  /**
   * @param {string} sessionId App session id (not the engine resume id).
   */
  constructor(sessionId) {
    super();
    this.sessionId = sessionId;
    /** @type {import('child_process').ChildProcess | null} */
    this.process = null;
    this.cwd = null;
    this.lineBuf = "";
    this.busy = false;
    this.collectedOutput = "";
    this.agentResumeId = null;
    this.spawnOptions = null;
    /** @type {boolean} True after done/error emitted for the current turn. */
    this._turnSettled = true;
  }

  isBusy() {
    return this.busy;
  }

  isAlive() {
    return this.process != null && !this.process.killed;
  }

  /**
   * @param {string} cwd
   * @param {{ agentCommand: string, permissionMode: string, disallowedTools?: string[], stagingDir?: string, resumeSessionId?: string | null }} options
   */
  ensureProcess(cwd, options) {
    if (!cwd || !options?.agentCommand) {
      throw new Error("RUNNER_MISSING_ARGS");
    }
    if (!fs.existsSync(cwd)) {
      throw new Error(`工作目录不存在：${cwd}`);
    }
    if (!fs.existsSync(options.agentCommand)) {
      throw new Error(`找不到助手引擎：${options.agentCommand}`);
    }

    if (options.resumeSessionId && !this.agentResumeId) {
      this.agentResumeId = options.resumeSessionId;
    }

    const spawnOpts = {
      agentCommand: options.agentCommand,
      permissionMode: options.permissionMode,
      disallowedTools: options.disallowedTools,
      stagingDir: options.stagingDir,
    };

    const same =
      this.isAlive() &&
      this.cwd === cwd &&
      this.spawnOptions &&
      sameSpawnOptions(this.spawnOptions, spawnOpts);

    if (same) return;

    this.terminate();
    this.cwd = cwd;
    this.spawnOptions = spawnOpts;
    this._spawn();
  }

  _spawn() {
    const opts = this.spawnOptions;
    const args = [
      "-p",
      "--verbose",
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--permission-mode",
      opts.permissionMode || "default",
    ];

    if (opts.disallowedTools?.length) {
      args.push("--disallowed-tools", ...opts.disallowedTools);
    }
    if (opts.stagingDir && fs.existsSync(opts.stagingDir)) {
      args.push("--add-dir", opts.stagingDir);
    }
    if (this.agentResumeId) {
      args.push("--resume", this.agentResumeId);
    }

    this.process = spawn(opts.agentCommand, args, {
      cwd: this.cwd,
      env: buildAgentSpawnEnv(),
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.lineBuf = "";
    this.collectedOutput = "";
    this._turnSettled = true;

    this.process.stdout.on("data", (chunk) => this._onStdout(chunk));
    this.process.stderr.on("data", (chunk) => {
      this.emit("stderr", sanitizeError(chunk.toString()));
    });

    this.process.on("error", (err) => {
      if (this.busy && !this._turnSettled) {
        this._failTurn(sanitizeError(err.message));
      } else {
        this.busy = false;
        this.process = null;
      }
    });

    this.process.on("close", (code) => {
      if (this.busy && !this._turnSettled) {
        this._flushLineBuffer();
        this._completeTurn({
          code,
          output: this.collectedOutput.trim(),
        });
      } else {
        this.busy = false;
      }
      this.process = null;
    });
  }

  _ensureAliveForSend() {
    if (this.isAlive()) return;
    if (this.cwd && this.spawnOptions) {
      this._spawn();
      return;
    }
    throw new Error("RUNNER_NOT_READY");
  }

  /**
   * @param {string} text User message (may include file paths).
   */
  sendUserMessage(text) {
    if (this.busy) {
      this.emit("error", "BUSY");
      return false;
    }

    const trimmed = String(text || "").trim();
    if (!trimmed) return false;

    try {
      this._ensureAliveForSend();
    } catch (err) {
      this.emit("error", sanitizeError(err.message));
      return false;
    }

    this.busy = true;
    this._turnSettled = false;
    this.collectedOutput = "";
    this.emit("status", "thinking");

    const payload = {
      type: "user",
      message: {
        role: "user",
        content: [{ type: "text", text: trimmed }],
      },
    };

    const line = `${JSON.stringify(payload)}\n`;
    const stdin = this.process.stdin;
    if (!stdin || stdin.destroyed) {
      this._failTurn("助手连接已断开，请重试。");
      return false;
    }

    const wrote = stdin.write(line, (err) => {
      if (err) this._failTurn(sanitizeError(err.message));
    });
    if (!wrote) {
      stdin.once("drain", () => {});
    }
    return true;
  }

  interrupt() {
    if (!this.process) return;
    try {
      this.process.kill("SIGINT");
    } catch {
      // ignore
    }
    if (this.busy && !this._turnSettled) {
      this._completeTurn({
        code: null,
        output: this.collectedOutput.trim(),
        interrupted: true,
      });
    }
    this.process = null;
  }

  terminate() {
    if (!this.process) {
      this.cwd = null;
      this.spawnOptions = null;
      this.lineBuf = "";
      this.collectedOutput = "";
      this.busy = false;
      this._turnSettled = true;
      return;
    }
    try {
      this.process.kill("SIGTERM");
    } catch {
      // ignore
    }
    this.busy = false;
    this._turnSettled = true;
    this.process = null;
    this.cwd = null;
    this.spawnOptions = null;
    this.lineBuf = "";
    this.collectedOutput = "";
    // agentResumeId intentionally kept for --resume on next spawn
  }

  _completeTurn(payload) {
    if (this._turnSettled) return;
    this._turnSettled = true;
    this.busy = false;
    this.emit("done", payload);
  }

  _failTurn(message) {
    if (this._turnSettled) return;
    this._turnSettled = true;
    this.busy = false;
    this.emit("error", message);
  }

  _onStdout(chunk) {
    this.lineBuf += chunk.toString();
    const lines = this.lineBuf.split("\n");
    this.lineBuf = lines.pop() || "";
    for (const line of lines) {
      this._handleLine(line);
    }
  }

  _flushLineBuffer() {
    const trimmed = this.lineBuf.trim();
    this.lineBuf = "";
    if (trimmed) this._handleLine(trimmed);
  }

  _handleLine(line) {
    const trimmed = line.trim();
    if (!trimmed) return;

    let ev;
    try {
      ev = JSON.parse(trimmed);
    } catch {
      this.collectedOutput += `${trimmed}\n`;
      this.emit("chunk", `${trimmed}\n`);
      return;
    }

    if (!ev?.type) return;

    switch (ev.type) {
      case "system":
        if (ev.subtype === "init" && ev.session_id) {
          if (this.agentResumeId !== ev.session_id) {
            this.agentResumeId = ev.session_id;
            this.emit("agent-resume-id", ev.session_id);
          }
        }
        break;

      case "assistant": {
        const blocks = ev.message?.content;
        if (!blocks) break;
        for (const block of blocks) {
          switch (block.type) {
            case "text": {
              const piece = block.text || "";
              if (!piece) break;
              this.collectedOutput = appendTextSegment(this.collectedOutput, piece);
              this.emit("chunk", piece);
              break;
            }
            case "tool_use":
              this.emit("tool-using", {
                name: block.name || "unknown",
                input: block.input || {},
                id: block.id || "",
              });
              break;
            default:
              break;
          }
        }
        break;
      }

      case "user": {
        const blocks = ev.message?.content;
        if (!blocks) break;
        for (const block of blocks) {
          if (block.type === "tool_result") {
            this.emit("tool-done", {
              id: block.tool_use_id || "",
              status: block.is_error ? "failed" : "done",
            });
          }
        }
        break;
      }

      case "result":
        this._flushLineBuffer();
        if (ev.subtype === "success" && ev.result) {
          const piece = String(ev.result);
          if (piece && !this.collectedOutput.includes(piece)) {
            this.collectedOutput = appendTextSegment(this.collectedOutput, piece);
            this.emit("chunk", piece);
          }
        }
        this._completeTurn({
          code: ev.is_error ? 1 : 0,
          output: this.collectedOutput.trim(),
        });
        break;

      default:
        break;
    }
  }
}

module.exports = { AgentSession };
