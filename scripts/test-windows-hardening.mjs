#!/usr/bin/env node
//
// Windows hardening unit tests (2026-07-21 audit follow-up):
//  - process-tree-kill: taskkill /T /F on win32, POSIX signal fallback,
//    fire-and-forget spawn errors can never crash the main process
//  - fs-transient-retry: transient lock errors retried, persistent ones
//    swallowed (renameSyncWithRetry must NEVER throw — timer-callback path)
//  - skill-registry: remote registry ids are path-joined, so they must pass
//    the same whitelist as local skills (traversal + Windows-illegal chars)
//  - proxy-aware-fetch: outside Electron it falls back to global fetch
// Runs in plain node.

import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { EventEmitter } from "node:events";
import { assert } from "./lib/test-assert.mjs";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// --- process-tree-kill: win32 uses taskkill /T /F, never per-process kill.
const tree = require(path.join(ROOT, "src/main/process-tree-kill.js"));
{
  const calls = [];
  const fakeSpawn = (...args) => {
    calls.push(args);
    return new EventEmitter();
  };
  const mustNotKill = () => { throw new Error("must not per-process kill on win32"); };
  tree.killPidTreeBestEffort(1234, { platform: "win32", spawn: fakeSpawn, kill: mustNotKill });
  assert(calls.length === 1, "win32 issues exactly one taskkill");
  assert(calls[0][0] === "taskkill", "win32 uses taskkill");
  assert(calls[0][1].join(" ") === "/pid 1234 /T /F", "taskkill reaps the whole tree forcefully");

  // A taskkill child that errors asynchronously must be sunk, not thrown.
  const errored = new EventEmitter();
  let fallbackKilled = null;
  tree.killPidTreeBestEffort(55, {
    platform: "win32",
    spawn: () => errored,
    kill: (pid, signal) => { fallbackKilled = `${pid}:${signal}`; },
  });
  errored.emit("error", new Error("spawn failed"));
  assert(fallbackKilled === "55:SIGKILL", "taskkill spawn error falls back to a plain kill");

  // POSIX: plain signal, no taskkill.
  const posixCalls = [];
  tree.killPidTreeBestEffort(77, {
    platform: "darwin",
    spawn: () => { throw new Error("must not taskkill on POSIX"); },
    kill: (pid, signal) => posixCalls.push(`${pid}:${signal}`),
  });
  assert(posixCalls.join(",") === "77:SIGTERM", "POSIX stop is a plain SIGTERM");

  // stopPid: win32 → null error + taskkill; POSIX kill failure → the error.
  const err = tree.stopPid(0x7fffffff, "SIGTERM");
  assert(err === null || err instanceof Error, "stopPid returns null or an Error");
}

// --- fs-transient-retry: transient EPERM retried; persistent swallowed.
const fs = require("node:fs");
const retry = require(path.join(ROOT, "src/main/fs-transient-retry.js"));
{
  const originalRename = fs.renameSync;
  let attempts = 0;
  fs.renameSync = () => {
    attempts += 1;
    if (attempts < 3) {
      const e = new Error("operation not permitted");
      e.code = "EPERM";
      throw e;
    }
  };
  try {
    assert(retry.renameSyncWithRetry("a.tmp", "a.json") === true, "transient EPERM retried to success");
    assert(attempts === 3, "retried until success");
  } finally {
    fs.renameSync = originalRename;
  }

  attempts = 0;
  fs.renameSync = () => {
    attempts += 1;
    const e = new Error("operation not permitted");
    e.code = "EPERM";
    throw e;
  };
  try {
    const result = retry.renameSyncWithRetry("b.tmp", "b.json");
    assert(result === false, "persistent EPERM is swallowed (returns false)");
    assert(attempts === 4, "bounded attempts before giving up");
  } finally {
    fs.renameSync = originalRename;
  }

  fs.renameSync = () => {
    const e = new Error("no such file");
    e.code = "ENOENT";
    throw e;
  };
  try {
    assert(retry.renameSyncWithRetry("c.tmp", "c.json") === false, "non-transient errors not retried, still no throw");
  } finally {
    fs.renameSync = originalRename;
  }
}

// --- skill-registry: remote ids must pass the local-skill whitelist.
const registry = require(path.join(ROOT, "src/main/skill-registry.js"));
{
  const base = { latestVersion: "1.0.0", github: { repo: "lily/skills", path: "skills/x" } };
  assert(registry.normalizeRegistryEntry({ ...base, id: "lily-ok-skill" })?.id === "lily-ok-skill", "valid id accepted");
  assert(registry.normalizeRegistryEntry({ ...base, id: "../../etc" }) === null, "path traversal id rejected");
  assert(registry.normalizeRegistryEntry({ ...base, id: "bad id?" }) === null, "Windows-illegal characters rejected");
  assert(registry.normalizeRegistryEntry({ ...base, id: "CON" }) === null, "uppercase (Windows reserved-name risk) rejected");
  assert(registry.normalizeRegistryEntry({ ...base, id: "a".repeat(101) }) === null, "overlong id rejected");
}

// --- proxy-aware-fetch: plain node (no Electron) falls back to global fetch.
const proxyAwareFetch = require(path.join(ROOT, "src/main/proxy-aware-fetch.js"));
{
  let called = null;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (...args) => {
    called = args;
    return Promise.resolve({ ok: true });
  };
  try {
    const res = await proxyAwareFetch("https://example.com/x", { method: "GET" });
    assert(res?.ok === true, "fallback returns the global fetch result");
    assert(called?.[0] === "https://example.com/x", "fallback forwards url and options");
  } finally {
    globalThis.fetch = originalFetch;
  }
}

console.log("windows-hardening: ok");
