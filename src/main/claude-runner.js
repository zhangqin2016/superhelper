"use strict";

/**
 * Wraps a Claude Code CLI child process.
 *
 * Emits:
 *   chunk(text)   — stdout text fragment (display AND saved to conversation)
 *   stderr(text)  — stderr text fragment (display only, NOT saved)
 *   done(code)    — process exited
 *   error(msg)    — spawn failure or other unrecoverable error
 *   status(state) — "thinking" when process starts
 *
 * Only one run can be active at a time. Call isBusy() to check.
 */

const { EventEmitter } = require("node:events");
const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { DEFAULT_AGENT_COMMAND, userHome, userDataPath } = require("./config");

// ---------------------------------------------------------------------------
// Error message sanitization — never leak internal paths / session IDs to UI
// ---------------------------------------------------------------------------

const ERROR_PATTERNS = [
  {
    test: /Session ID .* already in use/i,
    message: "刚才的请求还在收尾，请稍后再试。",
  },
  {
    test: /command not found|ENOENT/i,
    message: "本地 AI 助手暂时不可用，请确认服务已正确安装。",
  },
];

function sanitizeError(raw) {
  for (const { test, message } of ERROR_PATTERNS) {
    if (test.test(raw)) return message;
  }
  return "处理请求时遇到问题，请稍后再试。";
}

// ---------------------------------------------------------------------------
// Shell helpers
// ---------------------------------------------------------------------------

function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

/**
 * Resolve the absolute path to the agent CLI.
 * Tries well-known locations first, then falls back to `command -v`.
 */
function resolveAgentCommand() {
  if (
    path.isAbsolute(DEFAULT_AGENT_COMMAND) &&
    fs.existsSync(DEFAULT_AGENT_COMMAND)
  ) {
    return DEFAULT_AGENT_COMMAND;
  }

  const home = userHome();
  const candidates = [
    // Offline bundle install dir (first priority)
    path.join(userDataPath("claude-bin"), DEFAULT_AGENT_COMMAND),
    path.join(home, ".local", "bin", DEFAULT_AGENT_COMMAND),
    path.join(home, ".npm-global", "bin", DEFAULT_AGENT_COMMAND),
    `/opt/homebrew/bin/${DEFAULT_AGENT_COMMAND}`,
    `/usr/local/bin/${DEFAULT_AGENT_COMMAND}`,
    `/usr/bin/${DEFAULT_AGENT_COMMAND}`,
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }

  // Last resort: ask the user's login shell
  try {
    const result = spawnSync(
      process.env.SHELL || "/bin/zsh",
      ["-lc", `command -v ${shellQuote(DEFAULT_AGENT_COMMAND)}`],
      { encoding: "utf8" },
    );
    const resolved = result.stdout.trim();
    if (resolved) return resolved;
  } catch {
    // ignore — fall through to raw command name
  }

  return DEFAULT_AGENT_COMMAND;
}

// ---------------------------------------------------------------------------
// ClaudeRunner
// ---------------------------------------------------------------------------

class ClaudeRunner extends EventEmitter {
  constructor() {
    super();
    /** @type {import('child_process').ChildProcess | null} */
    this.activeProcess = null;
  }

  isBusy() {
    return this.activeProcess !== null;
  }

  /**
   * Spawn a Claude CLI invocation.
   *
   * @param {Object}  options
   * @param {string}  options.prompt         Full prompt text (including context).
   * @param {string}  options.cwd            Working directory for the CLI process.
   * @param {string}  options.mcpConfigPath  Path to mcp-active.json.
   * @param {string[]} [options.disallowedTools]  Tool names Claude must not use.
   * @param {string}  [options.stagingDir]   Staging directory for file attachments.
   * @param {Array}   [options.files]        File metadata: [{ id, name, stagedName, type, size, isImage }].
   */
  run({
    prompt,
    cwd,
    mcpConfigPath,
    disallowedTools = [],
    stagingDir,
    files = [],
  }) {
    if (this.isBusy()) {
      this.emit("error", "BUSY");
      return;
    }

    const args = [
      "--session-id",
      crypto.randomUUID(),
      "--permission-mode",
      "bypassPermissions",
      "--mcp-config",
      mcpConfigPath,
    ];

    if (disallowedTools.length > 0) {
      args.push("--disallowed-tools", ...disallowedTools);
    }

    // File attachments: copy to paste dir, add the dir for tool access, and
    // reference paths in the prompt.  --file is for remote resource downloads
    // (file_id:relative_path), NOT local file paths — so we never use it here.
    if (files.length > 0 && stagingDir) {
      args.push("--add-dir", stagingDir);
    }

    args.push("--output-format", "stream-json", "-p", prompt);

    const home = userHome();

    this.activeProcess = spawn(resolveAgentCommand(), args, {
      cwd,
      env: {
        ...process.env,
        PATH: [
          userDataPath("claude-bin"),
          path.join(home, ".local", "bin"),
          path.join(home, ".npm-global", "bin"),
          "/opt/homebrew/bin",
          "/usr/local/bin",
          "/usr/bin",
          "/bin",
          "/usr/sbin",
          "/sbin",
          process.env.PATH || "",
        ].join(":"),
        TERM: "dumb",
        NO_COLOR: "1",
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let collectedOutput = "";
    let processStarted = false;
    let processFailed = false;
    let lineBuf = "";

    this.activeProcess.on("spawn", () => {
      processStarted = true;
      this.emit("status", "thinking");
    });

    this.activeProcess.stdout.on("data", (chunk) => {
      const raw = chunk.toString();
      lineBuf += raw;

      // Extract complete lines
      const lines = lineBuf.split("\n");
      lineBuf = lines.pop(); // keep incomplete line in buffer

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        try {
          const ev = JSON.parse(trimmed);
          if (!ev || !ev.type) continue;

          switch (ev.type) {
            case "assistant":
            case "content_block_delta_text_delta": {
              // Extract text content from assistant messages
              let text = "";
              if (ev.message?.content) {
                for (const block of ev.message.content) {
                  if (block.type === "text") text += block.text;
                }
              }
              if (text) {
                collectedOutput += text;
                this.emit("chunk", text);
              }
              break;
            }
            case "tool_use": {
              const toolName = ev.name || ev.tool || "unknown";
              const toolInput = ev.input || {};
              this.emit("tool-using", {
                name: toolName,
                input: toolInput,
                id: ev.id || ev.tool_use_id || "",
              });
              break;
            }
            case "tool_result": {
              this.emit("tool-done", {
                name: ev.name || ev.tool || "",
                id: ev.tool_use_id || ev.id || "",
                status: ev.is_error ? "failed" : "done",
              });
              break;
            }
            case "result": {
              // Final result — text may be in ev.result
              if (typeof ev.result === "string" && ev.result) {
                // Only collect result text that isn't already emitted via assistant events
                // The stream-json format may duplicate assistant text in the final result
              }
              break;
            }
            // system, user, etc. are ignored for display
          }
        } catch {
          // Non-JSON line — forward as plain text (legacy fallback)
          collectedOutput += trimmed + "\n";
          this.emit("chunk", trimmed + "\n");
        }
      }
    });

    // stderr is forwarded for display only — NOT appended to collectedOutput.
    this.activeProcess.stderr.on("data", (chunk) => {
      this.emit("stderr", sanitizeError(chunk.toString()));
    });

    this.activeProcess.on("error", (error) => {
      processFailed = true;
      this.emit("error", sanitizeError(error.message));
      this.activeProcess = null;
    });

    this.activeProcess.on("close", (code) => {
      // Flush any remaining text in the line buffer
      if (lineBuf.trim()) {
        try {
          const ev = JSON.parse(lineBuf.trim());
          if (ev?.type === "assistant" && ev.message?.content) {
            let text = "";
            for (const block of ev.message.content) {
              if (block.type === "text") text += block.text;
            }
            if (text) {
              collectedOutput += text;
              this.emit("chunk", text);
            }
          }
        } catch {}
      }
      if (!processFailed && processStarted) {
        this.emit("done", { code, output: collectedOutput.trim() });
      }
      this.activeProcess = null;
    });
  }

  /** Send SIGINT to the running process (user clicked "Stop"). */
  interrupt() {
    if (this.activeProcess) {
      this.activeProcess.kill("SIGINT");
      this.activeProcess = null;
    }
  }

  /** Send SIGTERM and reset (user clicked "New Session"). */
  terminate() {
    if (this.activeProcess) {
      this.activeProcess.kill("SIGTERM");
      this.activeProcess = null;
    }
  }
}

module.exports = { ClaudeRunner, sanitizeError };
