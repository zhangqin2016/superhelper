#!/usr/bin/env node
/**
 * Probe the installed Claude CLI stream-json event shapes with low-risk prompts.
 * This is not a correctness test for model content; it detects protocol drift.
 */
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
const { ClaudeCliAdapter } = require("../src/main/runtime/adapters/claude-cli-adapter.js");

const CLAUDE = process.env.CLAUDE_BIN || "claude";
const TIMEOUT_MS = Number(process.env.CLAUDE_PROBE_TIMEOUT_MS || 30_000);
const MAX_BUDGET = process.env.CLAUDE_PROBE_MAX_BUDGET_USD || "0.05";
const adapter = new ClaudeCliAdapter();

function run(cmd, args, { inputLines = [], cwd = process.cwd() } = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, stdio: ["pipe", "pipe", "pipe"] });
    const events = [];
    const normalized = [];
    let stdout = "";
    let rawStdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, TIMEOUT_MS);

    child.stdout.on("data", (chunk) => {
      const text = chunk.toString();
      rawStdout += text;
      stdout += text;
      const lines = stdout.split("\n");
      stdout = lines.pop() || "";
      for (const line of lines) {
        try {
          const ev = JSON.parse(line);
          events.push(ev);
          normalized.push(...adapter.normalizeEvent(ev).actions);
        } catch {
          // Ignore non-JSON noise; stream-json should not emit it, but probes must not crash.
        }
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve({ code, timedOut, events, normalized, stderr, rawStdout });
    });

    for (const line of inputLines) child.stdin.write(`${JSON.stringify(line)}\n`);
    child.stdin.end();
  });
}

function eventKey(ev) {
  return `${ev.type}:${ev.subtype || ev.event?.type || ev.request?.subtype || ""}`;
}

function countBy(items, fn) {
  const counts = new Map();
  for (const item of items) {
    const key = fn(item);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return Object.fromEntries([...counts.entries()].sort(([a], [b]) => a.localeCompare(b)));
}

async function main() {
  const version = await run(CLAUDE, ["--version"], {});
  const gameProbeDir = path.join(os.tmpdir(), "lily-claude-probe-game");
  fs.rmSync(gameProbeDir, { recursive: true, force: true });
  fs.mkdirSync(gameProbeDir, { recursive: true });
  const cases = [
    {
      name: "print-text",
      args: [
        "-p",
        "用一句话回复：协议探测",
        "--verbose",
        "--output-format",
        "stream-json",
        "--permission-mode",
        "dontAsk",
        "--max-budget-usd",
        MAX_BUDGET,
      ],
    },
    {
      name: "stream-json-input",
      args: [
        "-p",
        "--verbose",
        "--input-format",
        "stream-json",
        "--output-format",
        "stream-json",
        "--prompt-suggestions",
        "true",
        "--permission-mode",
        "dontAsk",
        "--permission-prompt-tool",
        "stdio",
        "--max-budget-usd",
        MAX_BUDGET,
      ],
      inputLines: [
        {
          type: "user",
          message: {
            role: "user",
            content: [{ type: "text", text: "用一句话回复：协议探测" }],
          },
        },
      ],
    },
    {
      name: "python-game",
      args: [
        "-p",
        "在当前目录创建一个纯 Python 标准库小游戏 number_game.py：命令行猜数字，包含欢迎语、随机数字、最多 6 次机会、输入校验、胜负提示。创建后用 python3 -m py_compile number_game.py 检查语法，最后简短说明。",
        "--verbose",
        "--output-format",
        "stream-json",
        "--include-partial-messages",
        "--permission-mode",
        "bypassPermissions",
        "--dangerously-skip-permissions",
        "--max-budget-usd",
        process.env.CLAUDE_PROBE_GAME_BUDGET_USD || MAX_BUDGET,
      ],
      cwd: gameProbeDir,
    },
  ];

  const results = [];
  for (const probe of cases) {
    const result = await run(CLAUDE, probe.args, {
      inputLines: probe.inputLines || [],
      cwd: probe.cwd || process.cwd(),
    });
    const warnings = result.normalized.filter((item) =>
      ["unknown_runtime_event", "protocol_warning", "unknown_control_request"].includes(item.kind),
    );
    results.push({
      name: probe.name,
      exitCode: result.code,
      timedOut: result.timedOut,
      rawEventTypes: countBy(result.events, eventKey),
      normalizedKinds: countBy(result.normalized, (item) => item.kind),
      warningKinds: countBy(warnings, (item) => `${item.kind}:${item.notice?.type || ""}:${item.notice?.subtype || ""}`),
      stderr: result.stderr.slice(0, 500),
    });
  }

  console.log(JSON.stringify({
    claude: CLAUDE,
    versionText: version.rawStdout.trim(),
    cases: results,
  }, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
