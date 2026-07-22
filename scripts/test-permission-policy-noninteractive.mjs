#!/usr/bin/env node
//
// decidePermission nonInteractive semantics (2026-07-22 field case): an
// internal delivery re-check turn issued `rm -rf` cleanup, the "ask" verdict
// surfaced a permission card nobody would ever click (internal turns are
// unattended), and the turn sat for exactly the 20-minute tool lease before
// the watchdog aborted it — the user got "没有形成完整最终回答" for a turn
// whose verification work had actually passed. Unattended turns must DENY an
// "ask" verdict (fail-safe) instead of waiting for a human.
// Runs in plain node (no electron).

import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { decidePermission } = require("../src/main/runtime/opencode-permission-policy.js");

const RM_RF = { command: "rm -rf /Users/x/ws/.lily-work/rendered-pages && echo done" };

// Baseline: interactive balanced mode still asks for destructive shell.
assert.equal(decidePermission("ask", "bash", RM_RF, {}), "ask", "interactive ask-mode still asks for rm -rf");
// The fix: the same verdict denies when the turn is unattended.
assert.equal(decidePermission("ask", "bash", RM_RF, { nonInteractive: true }), "deny", "unattended turn denies rm -rf instead of waiting forever");
// Full autonomy is untouched — full means full, interactive or not.
assert.equal(decidePermission("full", "bash", RM_RF, {}), "allow");
assert.equal(decidePermission("full", "bash", RM_RF, { nonInteractive: true }), "allow");
// Catastrophic backstop: interactive still asks; unattended denies (safe direction).
assert.equal(decidePermission("full", "bash", { command: "rm -rf /" }, {}), "ask", "catastrophic always asks interactively");
assert.equal(decidePermission("full", "bash", { command: "rm -rf /" }, { nonInteractive: true }), "deny", "catastrophic denies on unattended turns, never auto-allows");
// Catastrophic matching is precise: root/home wipe in any flag order or segment.
assert.equal(decidePermission("full", "bash", { command: "rm -fr ~" }, {}), "ask", "home wipe asks");
assert.equal(decidePermission("full", "bash", { command: "rm -rf $HOME" }, {}), "ask", "$HOME wipe asks");
assert.equal(decidePermission("full", "bash", { command: "rm -rf / --no-preserve-root" }, {}), "ask", "root wipe with flag asks");
assert.equal(decidePermission("full", "bash", { command: "cd /tmp && rm -rf /" }, {}), "ask", "root wipe in a later segment still asks");
// ...but an absolute-path cleanup is destructive, NOT catastrophic (2026-07-22 field case).
assert.equal(decidePermission("full", "bash", { command: "rm -rf /Users/x/ws/build" }, {}), "allow", "full auto-allows absolute-path rm -rf");
assert.equal(decidePermission("full", "bash", { command: "rm -rf ~/Library/Caches/x" }, {}), "allow", "full auto-allows rm -rf under home subdirs");
// Plan mode denies mutations regardless.
assert.equal(decidePermission("plan", "bash", RM_RF, { nonInteractive: true }), "deny");
// Reads/allows are unaffected by the flag.
assert.equal(decidePermission("ask", "bash", { command: "python3 render_document.py a.pdf out" }, { nonInteractive: true }), "allow");
assert.equal(decidePermission("ask", "edit", { filePath: "src/a.js" }, { nonInteractive: true }), "allow", "in-workspace edits that would allow still allow");

console.log("permission-policy-noninteractive: ok");
