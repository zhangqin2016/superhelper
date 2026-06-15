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
const { CliEventAdapter } = require("../src/main/runtime/adapters/claude-cli-adapter.js");
const {
  buildControlResponse,
  buildHookContinueResponse,
  buildHookPreToolUseResponse,
  buildHookStopResponse,
  parseCanUseToolRequest,
} = require("../src/main/control-protocol.js");

const CLAUDE = process.env.CLAUDE_BIN || "claude";
const TIMEOUT_MS = Number(process.env.CLAUDE_PROBE_TIMEOUT_MS || 60_000);
const MAX_BUDGET = process.env.CLAUDE_PROBE_MAX_BUDGET_USD || "0.05";
const OUT_DIR = process.env.CLAUDE_PROBE_OUT_DIR || "";
const adapter = new CliEventAdapter();

function controlResponseForEvent(ev) {
  const requestId = ev?.request_id || ev?.request?.request_id || "";
  if (!requestId) return null;

  const canUse = parseCanUseToolRequest(ev);
  if (canUse) {
    return buildControlResponse(requestId, { behavior: "allow" });
  }

  if ((ev?.request?.subtype || ev?.subtype) !== "hook_callback") return null;
  const hook = ev?.request?.hook_event?.hook || "";
  if (hook === "PreToolUse") return buildHookPreToolUseResponse(requestId, { allow: true });
  if (hook === "Stop" || hook === "SubagentStop") return buildHookStopResponse(requestId, { allow: true });
  return buildHookContinueResponse(requestId);
}

function writeJsonLine(child, value) {
  if (!value || child.stdin.destroyed || child.stdin.writableEnded) return false;
  child.stdin.write(`${JSON.stringify(value)}\n`);
  return true;
}

function run(
  cmd,
  args,
  {
    inputLines = [],
    cwd = process.cwd(),
    autoRespondControls = false,
    keepStdinOpen = false,
    interruptAfterMs = 0,
  } = {},
) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, stdio: ["pipe", "pipe", "pipe"] });
    const events = [];
    const normalized = [];
    const controlResponses = [];
    let stdout = "";
    let rawStdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, TIMEOUT_MS);
    const interruptTimer = interruptAfterMs > 0
      ? setTimeout(() => {
          child.kill("SIGINT");
        }, interruptAfterMs)
      : null;

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
          if (autoRespondControls) {
            const response = controlResponseForEvent(ev);
            if (response && writeJsonLine(child, response)) controlResponses.push(response);
          }
          if (ev?.type === "result" && keepStdinOpen && !child.stdin.writableEnded) {
            child.stdin.end();
          }
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
      if (interruptTimer) clearTimeout(interruptTimer);
      resolve({ code, timedOut, events, normalized, controlResponses, stderr, rawStdout });
    });

    for (const line of inputLines) writeJsonLine(child, line);
    if (!keepStdinOpen) child.stdin.end();
  });
}

function eventKey(ev) {
  return [
    ev.type || "",
    ev.subtype || "",
    ev.event?.type || "",
    ev.event?.content_block?.type || "",
    ev.event?.delta?.type || "",
    ev.request?.subtype || "",
    ev.request?.tool_name || "",
    ev.request?.hook_event?.hook || "",
    ev.request?.hook_event?.tool_name || "",
  ].join(":").replace(/:+$/, "");
}

function countBy(items, fn) {
  const counts = new Map();
  for (const item of items) {
    const key = fn(item);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return Object.fromEntries([...counts.entries()].sort(([a], [b]) => a.localeCompare(b)));
}

function eventShape(ev) {
  return {
    key: eventKey(ev),
    type: ev?.type || "",
    subtype: ev?.subtype || "",
    eventType: ev?.event?.type || "",
    contentBlockType: ev?.event?.content_block?.type || "",
    deltaType: ev?.event?.delta?.type || "",
    requestSubtype: ev?.request?.subtype || "",
    toolName: ev?.request?.tool_name || ev?.request?.toolName || "",
    hook: ev?.request?.hook_event?.hook || "",
    keys: Object.keys(ev || {}).sort(),
    eventKeys: ev?.event && typeof ev.event === "object" ? Object.keys(ev.event).sort() : [],
    requestKeys: ev?.request && typeof ev.request === "object" ? Object.keys(ev.request).sort() : [],
  };
}

function mergeCatalog(catalog, events) {
  for (const ev of events) {
    const shape = eventShape(ev);
    const existing = catalog.get(shape.key);
    if (!existing) {
      catalog.set(shape.key, { ...shape, count: 1 });
      continue;
    }
    existing.count += 1;
    existing.keys = [...new Set([...existing.keys, ...shape.keys])].sort();
    existing.eventKeys = [...new Set([...existing.eventKeys, ...shape.eventKeys])].sort();
    existing.requestKeys = [...new Set([...existing.requestKeys, ...shape.requestKeys])].sort();
  }
}

async function main() {
  const version = await run(CLAUDE, ["--version"], {});
  const gameProbeDir = path.join(os.tmpdir(), "lily-claude-probe-game");
  const ioProbeDir = path.join(os.tmpdir(), "lily-claude-probe-io");
  const interruptProbeDir = path.join(os.tmpdir(), "lily-claude-probe-interrupt");
  fs.rmSync(gameProbeDir, { recursive: true, force: true });
  fs.rmSync(ioProbeDir, { recursive: true, force: true });
  fs.rmSync(interruptProbeDir, { recursive: true, force: true });
  fs.mkdirSync(gameProbeDir, { recursive: true });
  fs.mkdirSync(ioProbeDir, { recursive: true });
  fs.mkdirSync(interruptProbeDir, { recursive: true });
  fs.writeFileSync(path.join(ioProbeDir, "notes.txt"), "alpha\nbeta\ngamma\n", "utf8");
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
      name: "read-bash",
      args: [
        "-p",
        "读取 notes.txt，运行 wc -l notes.txt，然后用一句话说明行数。",
        "--verbose",
        "--output-format",
        "stream-json",
        "--include-partial-messages",
        "--permission-mode",
        "bypassPermissions",
        "--dangerously-skip-permissions",
        "--max-budget-usd",
        process.env.CLAUDE_PROBE_IO_BUDGET_USD || MAX_BUDGET,
      ],
      cwd: ioProbeDir,
    },
    {
      name: "permission-stdio",
      args: [
        "-p",
        "运行 pwd 并回复当前目录名。",
        "--verbose",
        "--output-format",
        "stream-json",
        "--include-partial-messages",
        "--permission-prompt-tool",
        "stdio",
        "--max-budget-usd",
        process.env.CLAUDE_PROBE_PERMISSION_BUDGET_USD || MAX_BUDGET,
      ],
      cwd: ioProbeDir,
      autoRespondControls: true,
      keepStdinOpen: true,
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
    {
      name: "interrupt",
      args: [
        "-p",
        "连续思考并写一段较长的项目分析，直到我中断。",
        "--verbose",
        "--output-format",
        "stream-json",
        "--include-partial-messages",
        "--permission-mode",
        "dontAsk",
        "--max-budget-usd",
        process.env.CLAUDE_PROBE_INTERRUPT_BUDGET_USD || MAX_BUDGET,
      ],
      cwd: interruptProbeDir,
      interruptAfterMs: Number(process.env.CLAUDE_PROBE_INTERRUPT_AFTER_MS || 2500),
    },
  ];

  const results = [];
  const catalog = new Map();
  if (OUT_DIR) fs.mkdirSync(OUT_DIR, { recursive: true });
  for (const probe of cases) {
    const result = await run(CLAUDE, probe.args, {
      inputLines: probe.inputLines || [],
      cwd: probe.cwd || process.cwd(),
      autoRespondControls: Boolean(probe.autoRespondControls),
      keepStdinOpen: Boolean(probe.keepStdinOpen),
      interruptAfterMs: Number(probe.interruptAfterMs || 0),
    });
    mergeCatalog(catalog, result.events);
    if (OUT_DIR) {
      const rawPath = path.join(OUT_DIR, `${probe.name}.jsonl`);
      fs.writeFileSync(rawPath, `${result.events.map((event) => JSON.stringify(event)).join("\n")}\n`, "utf8");
    }
    const warnings = result.normalized.filter((item) =>
      ["unknown_runtime_event", "protocol_warning", "unknown_control_request"].includes(item.kind),
    );
    results.push({
      name: probe.name,
      exitCode: result.code,
      timedOut: result.timedOut,
      controlResponses: result.controlResponses.length,
      rawEventTypes: countBy(result.events, eventKey),
      normalizedKinds: countBy(result.normalized, (item) => item.kind),
      warningKinds: countBy(warnings, (item) => `${item.kind}:${item.notice?.type || ""}:${item.notice?.subtype || ""}`),
      stderr: result.stderr.slice(0, 500),
    });
  }
  const eventCatalog = [...catalog.values()].sort((a, b) => a.key.localeCompare(b.key));
  if (OUT_DIR) {
    fs.writeFileSync(path.join(OUT_DIR, "event-catalog.json"), `${JSON.stringify(eventCatalog, null, 2)}\n`, "utf8");
    fs.writeFileSync(path.join(OUT_DIR, "summary.json"), `${JSON.stringify({
      claude: CLAUDE,
      versionText: version.rawStdout.trim(),
      cases: results,
      eventCatalog,
    }, null, 2)}\n`, "utf8");
  }

  console.log(JSON.stringify({
    claude: CLAUDE,
    versionText: version.rawStdout.trim(),
    outDir: OUT_DIR || null,
    eventCatalog,
    cases: results,
  }, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
