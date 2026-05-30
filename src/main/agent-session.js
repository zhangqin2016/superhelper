"use strict";

const { EventEmitter } = require("node:events");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const { appendTextSegment, sanitizeError } = require("./agent-runner");
const { buildAgentSpawnEnv } = require("./spawn-env");
const { sameSpawnOptions } = require("./runner-spawn-options");
const { getLogger } = require("./logger");
const log = getLogger("agent-session");

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
    /** @type {ReturnType<typeof setTimeout> | null} */
    this._idleTimer = null;
    /** Tool calls awaiting `tool_result` — idle completion must not fire while these run. */
    this._pendingToolIds = new Set();
    /** Any tool invocation this turn — wait for engine `result`, do not quiesce-complete. */
    this._turnHadToolUse = false;
    /** @type {boolean} True after done/error emitted for the current turn. */
    this._turnSettled = true;
  }

  /** Only for text-only turns missing `result` (not a task timeout). */
  static QUIESCE_MS = 12_000;

  _clearIdleTimer() {
    if (this._idleTimer) {
      clearTimeout(this._idleTimer);
      this._idleTimer = null;
    }
  }

  /** Complete turn when stream goes quiet after text (missing `result` event). */
  _armIdleCompletionTimer() {
    this._clearIdleTimer();
    if (!this.busy || this._turnSettled) return;
    if (this._turnHadToolUse || this._pendingToolIds.size > 0) return;
    if (!this.collectedOutput.trim()) return;
    this._idleTimer = setTimeout(() => {
      if (!this.busy || this._turnSettled) return;
      if (this._turnHadToolUse || this._pendingToolIds.size > 0) return;
      if (!this.collectedOutput.trim()) return;
      this._flushLineBuffer();
      this._completeTurn({
        code: 0,
        output: this.collectedOutput.trim(),
        idle: true,
      });
    }, AgentSession.QUIESCE_MS);
  }

  /**
   * End turn when stream is quiet but engine omitted `result` (text-only turns only).
   */
  settleTurnIfIdle() {
    if (!this.busy || this._turnSettled) return false;
    if (this._turnHadToolUse || this._pendingToolIds.size > 0) return false;
    if (!this.collectedOutput.trim()) return false;
    this._flushLineBuffer();
    this._completeTurn({
      code: 0,
      output: this.collectedOutput.trim(),
      idle: true,
    });
    return true;
  }

  _markStreamActivity() {
    if (!this.busy || this._turnSettled) return;
    this._armIdleCompletionTimer();
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
      configDir: options.configDir,
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
      env: buildAgentSpawnEnv({ configDir: opts.configDir || undefined }),
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.lineBuf = "";
    this.collectedOutput = "";
    this._turnSettled = true;
    this._clearIdleTimer();

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
    this._pendingToolIds.clear();
    this._turnHadToolUse = false;
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
    if (this.process) {
      try {
        this.process.kill("SIGINT");
      } catch {
        log.warn("interrupt kill failed (process already dead)");
      }
      this.process = null;
    }
    if (this.busy && !this._turnSettled) {
      this._completeTurn({
        code: null,
        output: this.collectedOutput.trim(),
        interrupted: true,
      });
    }
  }

  terminate() {
    this._clearIdleTimer();
    this._pendingToolIds.clear();
    this._turnHadToolUse = false;
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
      log.warn("terminate kill failed (process already dead)");
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
    this._clearIdleTimer();
    this._pendingToolIds.clear();
    this._turnHadToolUse = false;
    this._turnSettled = true;
    this.busy = false;
    this.emit("done", payload);
  }

  _failTurn(message) {
    if (this._turnSettled) return;
    this._clearIdleTimer();
    this._pendingToolIds.clear();
    this._turnHadToolUse = false;
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
      this._markStreamActivity();
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
              this._markStreamActivity();
              break;
            }
            case "tool_use": {
              this._turnHadToolUse = true;
              const toolId = block.id || "";
              if (toolId) this._pendingToolIds.add(toolId);
              this.emit("tool-using", {
                name: block.name || "unknown",
                input: block.input || {},
                id: toolId,
              });
              this._clearIdleTimer();
              this._markStreamActivity();
              break;
            }
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
            const toolId = block.tool_use_id || "";
            if (toolId) this._pendingToolIds.delete(toolId);
            this.emit("tool-done", {
              id: toolId,
              status: block.is_error ? "failed" : "done",
            });
            this._markStreamActivity();
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
            this._markStreamActivity();
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
