#!/usr/bin/env node
// killProcessTree reaps the engine's WHOLE process tree on shutdown/terminate,
// so closing the app never leaves tool children (node/python/ripgrep) alive
// holding the install-dir lock (the Windows updater's "could not be closed").

import { createRequire } from "node:module";
import assert from "node:assert/strict";
const require = createRequire(import.meta.url);

process.env.SESSION_SECRET ||= "test-session-secret-abcdefghijklmnop";
const { killProcessTree } = require("../src/main/runtime/opencode-shared-server.js");

// --- Windows: taskkill /T /F on the pid (kills descendants) ---
{
  const calls = [];
  killProcessTree({ pid: 4321, kill: () => { throw new Error("must not per-process kill on win"); } }, {
    platform: "win32",
    spawn: (cmd, args) => { calls.push({ cmd, args }); },
  });
  assert.equal(calls.length, 1, "one taskkill spawned");
  assert.equal(calls[0].cmd, "taskkill");
  assert.deepEqual(calls[0].args, ["/pid", "4321", "/T", "/F"], "taskkill targets the pid + tree, forced");
}

// --- POSIX: SIGTERM the process GROUP now, SIGKILL fallback after the delay ---
{
  const kills = [];
  const hard = killProcessTree({ pid: 7000, kill: () => {} }, {
    platform: "linux",
    kill: (target, signal) => kills.push([target, signal]),
    hardKillDelayMs: 5,
  });
  assert.deepEqual(kills, [[-7000, "SIGTERM"]], "signals the whole group (negative pid) with SIGTERM first");
  // wait for the hard-kill fallback
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(kills, [[-7000, "SIGTERM"], [-7000, "SIGKILL"]], "SIGKILLs the group if it didn't exit");
  if (hard) clearTimeout(hard);
}

console.log("kill-process-tree: ok");
