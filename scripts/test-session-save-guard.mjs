#!/usr/bin/env node
// Closed-loop guard for the session-index overwrite protection (CAPABILITY-GATE):
// a catastrophically-collapsed in-memory store must NOT overwrite a healthy on-disk
// index (the "failed load -> saveImmediate empties the file" data-loss footgun).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import module from "node:module";

const require = module.createRequire(import.meta.url);
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "lily-save-guard-"));
const userData = path.join(tempRoot, "userData");
const electronPath = require.resolve("electron");
require.cache[electronPath] = {
  id: electronPath, filename: electronPath, loaded: true,
  exports: { app: { getPath: (n) => (n === "userData" ? userData : tempRoot) } },
};
fs.mkdirSync(userData, { recursive: true });
const SessionManager = require("../src/main/session-manager.js");
const indexPath = path.join(userData, "sessions-index.json");

function assert(c, m) { if (!c) throw new Error(m); }
function diskCount() {
  const o = JSON.parse(fs.readFileSync(indexPath, "utf8"));
  let n = 0; for (const l of Object.values(o.sessions || {})) n += l.length; return n;
}
function fakeSessions(n) {
  const list = Array.from({ length: n }, (_, i) => ({
    id: `s${i}`, projectId: "p1", title: `S${i}`,
    createdAt: "t", updatedAt: "t", status: "idle", messageCount: 3,
  }));
  return { p1: list };
}

const pm = { projects: [{ id: "p1", name: "P", path: tempRoot }], getActive() { return this.projects[0]; }, total() { return 1; } };
const m = new SessionManager(pm);

// 1. Healthy store of 5 persists normally.
m.sessions = fakeSessions(5);
m.saveImmediate();
assert(diskCount() === 5, `baseline save should write 5, got ${diskCount()}`);

// 2. COLLAPSE to 0 -> blocked, disk preserved, guard-backup created.
m.sessions = { p1: [] };
m.saveImmediate();
assert(diskCount() === 5, `collapse-to-0 must NOT overwrite (still 5), got ${diskCount()}`);
assert(fs.readdirSync(userData).some((f) => f.includes("guard-backup")), "a guard-backup of the good file must be written");
console.log("save-guard: collapse-to-0 blocked, disk preserved ok");

// 3. COLLAPSE to 1 (the real incident: failed load auto-creates one) -> blocked.
m.sessions = fakeSessions(1);
m.saveImmediate();
assert(diskCount() === 5, `collapse-to-1 must NOT overwrite (still 5), got ${diskCount()}`);
console.log("save-guard: collapse-to-1 (failed-load signature) blocked ok");

// 4. Normal delete (5 -> 4) is allowed (not a collapse).
m.sessions = fakeSessions(4);
m.saveImmediate();
assert(diskCount() === 4, `normal delete should persist 4, got ${diskCount()}`);
console.log("save-guard: normal delete (4) allowed ok");

// 5. Explicit override env lets a collapse through (escape hatch).
process.env.LILY_DISABLE_SESSION_SAVE_GUARD = "1";
m.sessions = { p1: [] };
m.saveImmediate();
assert(diskCount() === 0, `override must allow the write, got ${diskCount()}`);
delete process.env.LILY_DISABLE_SESSION_SAVE_GUARD;
console.log("save-guard: override escape-hatch ok");

fs.rmSync(tempRoot, { recursive: true, force: true });
console.log("test-session-save-guard: ALL_OK");
