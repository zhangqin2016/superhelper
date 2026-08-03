#!/usr/bin/env node
/**
 * Headless / CI runner — run ONE prompt through Lily's engine configuration
 * (model gateway + permission policy + MCP) WITHOUT the desktop GUI. For
 * automation, scripting, and CI; the GUI app is unaffected.
 *
 *   node scripts/lily-headless.mjs [options] "your prompt"
 *
 * Options:
 *   --cwd DIR        working directory for the run (default: cwd)
 *   --json           emit raw JSON events (--format json) for machine parsing
 *   --model P/M      override the model (provider/model)
 *   --command NAME   run a slash command (e.g. --command review)
 *   --db FILE        engine session db (default: a temp db, discarded after)
 *
 * The model gateway is read from the SAME env vars the desktop app uses, so set
 * those in CI. Permission is "full" (autonomous) since no one can answer prompts.
 */
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import readline from "node:readline";
import { parseCliArgs } from "./lib/cli-args.mjs";

const require = createRequire(import.meta.url);
const { buildOpencodeConfig } = require("../src/main/runtime/opencode-config-builder.js");
const { findBundledOpencodeBinary } = require("../src/main/bundle-locator.js");

const USAGE = 'lily run [--workspace DIR] [--json|--stream-json] [--session ID|--resume ID] [--after-cursor N] [--fork] [--allowed-tools LIST] [--denied-tools LIST] [--max-turns N] [--timeout MS] "prompt"';
const { values, positionals } = parseCliArgs({
  usage: USAGE,
  options: {
    cwd: { type: "string" },
    workspace: { type: "string" },
    json: { type: "boolean", default: false },
    "stream-json": { type: "boolean", default: false },
    model: { type: "string" },
    command: { type: "string" },
    db: { type: "string" },
    session: { type: "string" },
    resume: { type: "string" },
    "after-cursor": { type: "string" },
    fork: { type: "boolean", default: false },
    timeout: { type: "string" },
    "allowed-tools": { type: "string" },
    "denied-tools": { type: "string" },
    "max-turns": { type: "string" },
  },
});

const cwd = values.workspace || values.cwd || process.cwd();
const asJson = values.json;
const asStreamJson = values["stream-json"];
const model = values.model || null;
const command = values.command || null;
const dbPath = values.db || null;
const resumeSession = values.session || values.resume || null;
const forkSession = values.fork === true;
const timeoutMs = values.timeout == null ? 0 : Number(values.timeout);
const maxTurns = values["max-turns"] == null ? 0 : Number(values["max-turns"]);
const afterCursor = values["after-cursor"] == null ? 0 : Number(values["after-cursor"]);
const allowedTools = String(values["allowed-tools"] || "").split(",").map((value) => value.trim().toLowerCase()).filter(Boolean);
const deniedTools = String(values["denied-tools"] || "").split(",").map((value) => value.trim()).filter(Boolean);
// Positional args form the prompt (quoting optional: "fix the bug" or fix the bug).
const promptParts = positionals[0] === "run" ? positionals.slice(1) : positionals;
const prompt = promptParts.join(" ").trim();

function die(code, msg) { console.error(`[lily-headless] ${msg}`); process.exit(code); }

if (!prompt && !command && !(asStreamJson && resumeSession)) {
  die(2, `usage: ${USAGE}`);
}
if (asJson && asStreamJson) die(2, "--json and --stream-json are mutually exclusive");
if (forkSession && !resumeSession) die(2, "--fork requires --session or --resume");
if (values.timeout != null && (!Number.isFinite(timeoutMs) || timeoutMs < 1)) die(2, "--timeout must be a positive millisecond value");
if (values["max-turns"] != null && (!Number.isInteger(maxTurns) || maxTurns < 1 || maxTurns > 10_000)) die(2, "--max-turns must be an integer from 1 to 10000");
if (values["after-cursor"] != null && (!Number.isInteger(afterCursor) || afterCursor < 0)) die(2, "--after-cursor must be a non-negative integer");

if (asStreamJson && !forkSession && !command && !allowedTools.length && !maxTurns) {
  const { createDesktopRuntimeTransport, createLilyClient } = require("../src/sdk/index.js");
  const desktop = createDesktopRuntimeTransport();
  if (await desktop.available()) {
    try {
      const client = createLilyClient({ transport: desktop });
      const input = {
        prompt,
        workspace: cwd,
        sessionId: resumeSession || undefined,
        resume: !prompt ? resumeSession || undefined : undefined,
        afterCursor,
        deniedTools,
        timeoutMs,
      };
      for await (const event of client.run(input)) process.stdout.write(`${JSON.stringify(event)}\n`);
      process.exit(0);
    } catch (error) {
      console.error(`[lily-headless] desktop runtime failed: ${error?.message || error}`);
      process.exit(Number(error?.exitCode || 30));
    }
  }
}

const bin = findBundledOpencodeBinary();
if (!bin) die(3, "no bundled opencode engine found — run: npm run engine:opencode");

const lilyEnv = { ...process.env };
if (maxTurns) lilyEnv.LILY_OPENCODE_PRIMARY_MAX_STEPS = String(maxTurns);
const cfg = buildOpencodeConfig({ lilyEnv, permissionMode: "full", disallowedTools: deniedTools });
if (!cfg.ok) die(4, `engine config failed: ${cfg.reason || "no model configured"} — set the model gateway env vars the app uses`);
if (allowedTools.length) {
  const restricted = JSON.parse(cfg.configContent);
  restricted.permission = { "*": "deny", skill: "deny" };
  for (const tool of allowedTools) restricted.permission[tool] = "allow";
  for (const tool of deniedTools) restricted.permission[tool.toLowerCase()] = "deny";
  cfg.configContent = JSON.stringify(restricted);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lily-headless-"));
const cfgPath = path.join(tmp, "opencode-config.json");
fs.writeFileSync(cfgPath, cfg.configContent);
const env = {
  ...process.env,
  OPENCODE_CONFIG: cfgPath,
  OPENCODE_DB: dbPath || path.join(tmp, "headless.db"),
};

const args = ["run"];
if (asJson || asStreamJson) args.push("--format", "json");
if (model) args.push("--model", model);
if (command) args.push("--command", command);
if (resumeSession) args.push("--session", resumeSession);
if (forkSession) args.push("--fork");
if (prompt) args.push(prompt);

function cleanup() {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
}

if (!asStreamJson) {
  const result = spawnSync(bin, args, { cwd, env, stdio: "inherit" });
  cleanup();
  process.exit(result.status == null ? 1 : result.status);
}

const child = spawn(bin, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
let cursor = 0;
let timeout = null;
let timedOut = false;
const childExit = new Promise((resolve) => {
  child.once("error", () => resolve(20));
  child.once("close", (code, signal) => resolve(timedOut || signal ? 12 : Number(code ?? 30)));
});
if (timeoutMs > 0) {
  timeout = setTimeout(() => {
    timedOut = true;
    child.kill("SIGINT");
  }, timeoutMs);
  timeout.unref?.();
}
process.once("SIGINT", () => child.kill("SIGINT"));
child.stderr.pipe(process.stderr);
const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
for await (const line of lines) {
  if (!String(line).trim()) continue;
  let raw;
  try { raw = JSON.parse(line); }
  catch { raw = { type: "engine.output", text: String(line) }; }
  cursor += 1;
  const event = {
    protocolVersion: 1,
    cursor,
    type: String(raw.type || "engine.event"),
    sessionId: String(raw.sessionID || raw.sessionId || raw.properties?.sessionID || ""),
    turnId: String(raw.turnId || ""),
    taskRunId: String(raw.taskRunId || ""),
    ts: Date.now(),
    payload: raw,
  };
  process.stdout.write(`${JSON.stringify(event)}\n`);
}
const exit = await childExit;
if (timeout) clearTimeout(timeout);
cleanup();
process.exit(exit);
