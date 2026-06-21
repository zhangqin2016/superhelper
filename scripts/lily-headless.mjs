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
import { spawnSync } from "node:child_process";

const require = createRequire(import.meta.url);
const { buildOpencodeConfig } = require("../src/main/runtime/opencode-config-builder.js");
const { findBundledOpencodeBinary } = require("../src/main/bundle-locator.js");

const argv = process.argv.slice(2);
const valFlag = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : null; };
const boolFlag = (name) => argv.includes(name);

const cwd = valFlag("--cwd") || process.cwd();
const asJson = boolFlag("--json");
const model = valFlag("--model");
const command = valFlag("--command");
const dbPath = valFlag("--db");

// Positional prompt = everything not consumed by a flag.
const consumed = new Set();
for (const f of ["--cwd", "--model", "--command", "--db"]) {
  const i = argv.indexOf(f);
  if (i >= 0) { consumed.add(i); consumed.add(i + 1); }
}
{ const i = argv.indexOf("--json"); if (i >= 0) consumed.add(i); }
const prompt = argv.filter((_, i) => !consumed.has(i)).join(" ").trim();

function die(code, msg) { console.error(`[lily-headless] ${msg}`); process.exit(code); }

if (!prompt && !command) {
  die(2, 'usage: lily-headless [--cwd DIR] [--json] [--model P/M] [--command NAME] "prompt"');
}

const bin = findBundledOpencodeBinary();
if (!bin) die(3, "no bundled opencode engine found — run: npm run engine:opencode");

const cfg = buildOpencodeConfig({ lilyEnv: process.env, permissionMode: "full" });
if (!cfg.ok) die(4, `engine config failed: ${cfg.reason || "no model configured"} — set the model gateway env vars the app uses`);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lily-headless-"));
const cfgPath = path.join(tmp, "opencode-config.json");
fs.writeFileSync(cfgPath, cfg.configContent);
const env = {
  ...process.env,
  OPENCODE_CONFIG: cfgPath,
  OPENCODE_DB: dbPath || path.join(tmp, "headless.db"),
};

const args = ["run"];
if (asJson) args.push("--format", "json");
if (model) args.push("--model", model);
if (command) args.push("--command", command);
if (prompt) args.push(prompt);

const result = spawnSync(bin, args, { cwd, env, stdio: "inherit" });
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
process.exit(result.status == null ? 1 : result.status);
