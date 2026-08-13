#!/usr/bin/env node
// Root-cause guards for the session-index data-loss footgun (CAPABILITY-GATE):
//  1) atomic write (tmp -> rename) + rolling .bak — an interrupted write never corrupts;
//  2) a corrupt/unreadable index is recovered from .bak, NOT treated as empty;
//  3) corrupt index with no backup -> load bails (no auto-create/save, file preserved);
//  4) empty project set never prunes sessions.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import module from "node:module";

const require = module.createRequire(import.meta.url);
const { MessageStore } = require("../src/main/store/message-store.js");

function freshEnv() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "lily-load-rec-"));
  const userData = path.join(tempRoot, "userData");
  const electronPath = require.resolve("electron");
  require.cache[electronPath] = {
    id: electronPath, filename: electronPath, loaded: true,
    exports: { app: { getPath: (n) => (n === "userData" ? userData : tempRoot) } },
  };
  fs.mkdirSync(userData, { recursive: true });
  delete require.cache[require.resolve("../src/main/session-manager.js")];
  const SessionManager = require("../src/main/session-manager.js");
  return { tempRoot, userData, SessionManager };
}
function assert(c, m) { if (!c) throw new Error(m); }
function pm(projects, activeId) {
  return { projects, getActive() { return projects.find((p) => p.id === activeId) || projects[0] || null; }, total() { return projects.length; } };
}
function goodIndex(pid, n) {
  const list = Array.from({ length: n }, (_, i) => ({ id: `${pid}-s${i}`, projectId: pid, title: `S${i}`, createdAt: "t", updatedAt: "t", status: "idle", messageCount: 1 }));
  return JSON.stringify({ activeSessionId: `${pid}-s0`, sessions: { [pid]: list } }, null, 2);
}
const countDisk = (p) => { const o = JSON.parse(fs.readFileSync(p, "utf8")); let n = 0; for (const l of Object.values(o.sessions || {})) n += l.length; return n; };

// --- 1. atomic write leaves no .tmp and creates a .bak from the prior good file -----
{
  const { userData, SessionManager } = freshEnv();
  const idx = path.join(userData, "sessions-index.json");
  fs.writeFileSync(idx, goodIndex("p1", 5));
  const m = new SessionManager(pm([{ id: "p1", name: "P", path: userData }], "p1-s0"));
  m.load(); // reads 5, then saveImmediate -> .bak + atomic
  assert(!fs.existsSync(idx + ".tmp"), "atomic write must not leave a .tmp file");
  assert(fs.existsSync(idx + ".bak"), "a rolling .bak of the prior good index must exist");
  assert(countDisk(idx) === 5, `index should still hold 5, got ${countDisk(idx)}`);
  console.log("load-recovery: atomic write + .bak ok");
}

// --- 2. corrupt index + good .bak -> recovered (NOT emptied) ------------------------
{
  const { userData, SessionManager } = freshEnv();
  const idx = path.join(userData, "sessions-index.json");
  fs.writeFileSync(idx + ".bak", goodIndex("p1", 4)); // last good
  fs.writeFileSync(idx, "{ this is corrupt json ");     // truncated/garbage
  const m = new SessionManager(pm([{ id: "p1", name: "P", path: userData }], "p1-s0"));
  m.load();
  assert(!m._loadFailed, "with a good .bak the load must NOT be marked failed");
  assert(m.listForProject("p1").length === 4, `must recover 4 sessions from .bak, got ${m.listForProject("p1").length}`);
  assert(fs.readdirSync(userData).some((f) => f.includes(".corrupt-")), "the corrupt index must be quarantined");
  console.log("load-recovery: corrupt index recovered from .bak ok");
}

// --- 3. corrupt index + NO backup -> bail, do NOT overwrite the file ----------------
{
  const { userData, SessionManager } = freshEnv();
  const idx = path.join(userData, "sessions-index.json");
  const garbage = "{ broken ";
  fs.writeFileSync(idx, garbage);
  const m = new SessionManager(pm([{ id: "p1", name: "P", path: userData }], "p1-s0"));
  m.load();
  assert(m._loadFailed, "corrupt index with no backup must flag the load as failed");
  assert(fs.readFileSync(idx, "utf8") === garbage, "a failed load must NOT overwrite the (recoverable) index file");
  console.log("load-recovery: corrupt + no-backup preserves file (no overwrite) ok");
}

// --- 4. empty project set must NOT prune sessions ----------------------------------
{
  const { userData, SessionManager } = freshEnv();
  const idx = path.join(userData, "sessions-index.json");
  fs.writeFileSync(idx, goodIndex("p1", 3));
  const m = new SessionManager(pm([], null)); // projects failed to load
  m.load();
  assert(m.listForProject("p1").length === 3, `empty projects must not prune sessions, got ${m.listForProject("p1").length}`);
  console.log("load-recovery: empty-projects no-prune ok");
}

// --- 5. indexed history survives an old index overwrite ----------------------------
{
  const { userData, SessionManager } = freshEnv();
  const idx = path.join(userData, "sessions-index.json");
  fs.writeFileSync(idx, goodIndex("p1", 1));
  const store = new MessageStore(path.join(userData, "messages.db"), path.join(userData, "blobs"));
  store.append("lost-session", {
    id: "lost-message",
    role: "user",
    content: "A 会话仍在 SQLite 历史中",
    timestamp: "2026-08-13T00:00:00.000Z",
  });
  store.close();

  const m = new SessionManager(pm([{ id: "p1", name: "P", path: userData }], "p1-s0"));
  m.load();
  const restored = m.listForProject("p1").find((session) => session.id === "lost-session");
  assert(restored, "an indexed session missing from the JSON index must be restored");
  assert(restored.messageCount === 1, "restored indexed session must retain its message count");
  console.log("load-recovery: SQLite orphan session restored ok");
}

// --- 6. a deleted conversation is never resurrected from SQLite --------------------
{
  const { userData, SessionManager } = freshEnv();
  fs.writeFileSync(path.join(userData, "sessions-index.json"), goodIndex("p1", 1));
  fs.writeFileSync(path.join(userData, "deleted-sessions.json"), JSON.stringify({
    sessions: { "deleted-session": { id: "deleted-session", deletedAt: "2026-08-13T00:00:00.000Z" } },
  }));
  const store = new MessageStore(path.join(userData, "messages.db"), path.join(userData, "blobs"));
  store.append("deleted-session", { id: "deleted-message", role: "user", content: "不要恢复", timestamp: "2026-08-13T00:00:00.000Z" });
  store.close();

  const m = new SessionManager(pm([{ id: "p1", name: "P", path: userData }], "p1-s0"));
  m.load();
  assert(!m.listForProject("p1").some((session) => session.id === "deleted-session"), "a deletion tombstone must prevent SQLite recovery");
  console.log("load-recovery: SQLite tombstone respected ok");
}

// --- 7. a bulk loss writes a manifest instead of flooding the sidebar ---------------
{
  const { userData, SessionManager } = freshEnv();
  fs.writeFileSync(path.join(userData, "sessions-index.json"), goodIndex("p1", 1));
  const store = new MessageStore(path.join(userData, "messages.db"), path.join(userData, "blobs"));
  for (let i = 0; i < 4; i += 1) {
    store.append(`lost-${i}`, { id: `lost-message-${i}`, role: "user", content: `历史 ${i}`, timestamp: "2026-08-13T00:00:00.000Z" });
  }
  store.close();

  const m = new SessionManager(pm([{ id: "p1", name: "P", path: userData }], "p1-s0"));
  m.load();
  assert(m.listForProject("p1").length === 1, "bulk SQLite recovery must not add sidebar rows automatically");
  const manifest = JSON.parse(fs.readFileSync(path.join(userData, "sqlite-message-recovery.json"), "utf8"));
  assert(manifest.skippedBulkIndexedRecovery?.count === 4, "bulk SQLite recovery must leave a support manifest");
  console.log("load-recovery: SQLite bulk recovery manifest ok");
}

console.log("test-session-load-recovery: ALL_OK");
