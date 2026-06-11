#!/usr/bin/env node
/**
 * Post-edit verification loop: the hook script must catch real syntax breakage
 * (exit 2 + a message the model can act on), FAIL OPEN on anything it cannot
 * check confidently, and the settings installer must merge idempotently
 * without touching user-configured hooks.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const hookScript = path.join(root, "resources/hooks/verify-edit.cjs");
const { ensureVerificationHooks } = require("../src/main/verification-hooks.js");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "verify-hook-test-"));

function runHook(payload) {
  return spawnSync(process.execPath, [hookScript], {
    input: JSON.stringify(payload),
    encoding: "utf8",
    timeout: 30_000,
  });
}

try {
  // Broken JS edited by the model → exit 2 with the file named in stderr.
  const badJs = path.join(tmp, "broken.js");
  fs.writeFileSync(badJs, "function oops( {\n");
  const badResult = runHook({ tool_name: "Edit", tool_input: { file_path: badJs } });
  if (badResult.status !== 2 || !badResult.stderr.includes("broken.js")) {
    throw new Error(`broken JS must fail with the file named: status=${badResult.status} stderr=${badResult.stderr}`);
  }

  // Valid JS → silent pass.
  const goodJs = path.join(tmp, "good.js");
  fs.writeFileSync(goodJs, "module.exports = 1;\n");
  if (runHook({ tool_name: "Write", tool_input: { file_path: goodJs } }).status !== 0) {
    throw new Error("valid JS must pass");
  }

  // Broken JSON → exit 2.
  const badJson = path.join(tmp, "broken.json");
  fs.writeFileSync(badJson, "{ nope ");
  if (runHook({ tool_name: "Write", tool_input: { file_path: badJson } }).status !== 2) {
    throw new Error("broken JSON must fail");
  }

  // Fail-open cases: unknown extension, missing file, non-edit tool, junk stdin.
  const txt = path.join(tmp, "notes.txt");
  fs.writeFileSync(txt, "anything");
  for (const [label, payload] of [
    ["unknown extension", { tool_name: "Edit", tool_input: { file_path: txt } }],
    ["missing file", { tool_name: "Edit", tool_input: { file_path: path.join(tmp, "ghost.js") } }],
    ["non-edit tool", { tool_name: "Bash", tool_input: { file_path: badJs } }],
  ]) {
    if (runHook(payload).status !== 0) throw new Error(`${label} must fail open`);
  }
  const junk = spawnSync(process.execPath, [hookScript], { input: "not json", encoding: "utf8", timeout: 30_000 });
  if (junk.status !== 0) throw new Error("junk stdin must fail open");

  // Settings merge: installs once, idempotent on repeat, preserves user hooks,
  // and updates in place when the script path moves (app update).
  const settingsPath = path.join(tmp, "settings.json");
  fs.writeFileSync(settingsPath, JSON.stringify({
    env: { KEEP: "me" },
    hooks: { PostToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "echo user-hook" }] }] },
  }));
  const opts = { settingsPath, nodePath: "/usr/bin/node", scriptPath: hookScript };
  if (!ensureVerificationHooks(opts)) throw new Error("first install must write");
  if (ensureVerificationHooks(opts)) throw new Error("second install must be a no-op");
  const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
  if (settings.env.KEEP !== "me") throw new Error("unrelated settings must be preserved");
  if (settings.hooks.PostToolUse.length !== 2) throw new Error("user hook must be preserved alongside ours");
  if (!JSON.stringify(settings.hooks.PostToolUse[1]).includes("verify-edit.cjs")) {
    throw new Error("managed hook entry missing");
  }
  if (!ensureVerificationHooks({ ...opts, nodePath: "/new/node" })) {
    throw new Error("changed node path must update the managed entry");
  }
  const updated = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
  if (updated.hooks.PostToolUse.length !== 2 || !updated.hooks.PostToolUse[1].hooks[0].command.includes("/new/node")) {
    throw new Error("managed entry must update in place, not duplicate");
  }

  console.log("verification-hooks: ok");
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
