#!/usr/bin/env node
/**
 * Test SessionManager core operations: create, message push, find, CRUD.
 * Mock Electron to run without the full app.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import module from "node:module";

const require = module.createRequire(import.meta.url);
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "lily-session-manager-"));
const userData = path.join(tempRoot, "userData");
const electronPath = require.resolve("electron");

require.cache[electronPath] = {
  id: electronPath,
  filename: electronPath,
  loaded: true,
  exports: {
    app: {
      getPath: (name) => {
        if (name === "userData") return userData;
        if (name === "home") return tempRoot;
        if (name === "documents") return tempRoot;
        return tempRoot;
      },
    },
  },
};

const SessionManager = require("../src/main/session-manager.js");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

try {
  fs.mkdirSync(userData, { recursive: true });

  const projectManager = {
    projects: [
      { id: "p1", name: "Test Project", path: tempRoot },
    ],
    getActive() {
      return this.projects[0];
    },
    total() {
      return this.projects.length;
    },
  };

  // Test 1: construction and load
  const manager = new SessionManager(projectManager);
  manager.load();

  // Test 2: create session (load may have already created one if empty)
  const beforeCount = manager.listForProject("p1").length;
  const session = manager.create("p1", "Test Session");
  assert(session && session.id, "create should return session with id");
  assert(session.title === "Test Session", `title should match, got ${session.title}`);
  assert(session.projectId === "p1", "projectId should be p1");

  // Test 3: findById
  const found = manager.findById(session.id);
  assert(found && found.id === session.id, "findById should return session");

  // Test 4: getActive
  const active = manager.getActive();
  assert(active && active.id === session.id, "newest session should be active");

  // Test 5: pushMessage (uses active session)
  manager.pushMessage("user", "Hello world");
  const conv = manager.getConversation(session.id);
  assert(conv.length === 1, `should have 1 message, got ${conv.length}`);
  assert(conv[0].role === "user", `role should be user, got ${conv[0].role}`);
  assert(conv[0].content === "Hello world", "content should match");

  // Test 6: push assistant message
  manager.pushMessage("assistant", "Hello human");
  const conv2 = manager.getConversation(session.id);
  assert(conv2.length === 2, `should have 2 messages, got ${conv2.length}`);

  // Test 7: pushMessageTo with extra id
  manager.pushMessageTo(session.id, "system", "meta message", null, { id: "msg_001" });
  const msg = manager.findMessage(session.id, "msg_001");
  assert(msg && msg.role === "system", "should find by message id");

  // Test 8: getLastUserMessage
  const lastUser = manager.getLastUserMessage(session.id);
  assert(lastUser && lastUser.content === "Hello world", "should get last user message");

  // Test 9: rename
  manager.rename(session.id, "Renamed Session");
  const renamed = manager.findById(session.id);
  assert(renamed.title === "Renamed Session", "title should be renamed");

  // Test 10: create second session
  const session2 = manager.create("p1", "Second Session");
  assert(session2.id !== session.id, "second session should have different id");
  const list = manager.listForProject("p1");
  assert(list.length >= 2, `should list 2+ sessions, got ${list.length}`);

  // Test 11: switchTo
  manager.switchTo(session2.id);
  assert(manager.getActive().id === session2.id, "should switch active session");

  // Test 12: delete session — must also drop the OpenCode engine resume cache
  const engRoot = path.join(userData, "opencode-sessions");
  const session2Dir = path.join(engRoot, session2.id);
  fs.mkdirSync(session2Dir, { recursive: true });
  fs.writeFileSync(path.join(session2Dir, "opencode.db"), "x");
  manager.delete(session2.id);
  const afterDelete = manager.findById(session2.id);
  assert(!afterDelete, "deleted session should not be found");
  assert(manager.getActive().id === session.id, "active should revert to remaining session");
  assert(!fs.existsSync(session2Dir), "deleting a session must remove its opencode engine cache");

  // Test 13: orphan GC keeps live sessions, removes the rest
  const liveDir = path.join(engRoot, session.id);
  const orphanDir = path.join(engRoot, "ses_orphan_does_not_exist");
  fs.mkdirSync(liveDir, { recursive: true });
  fs.mkdirSync(orphanDir, { recursive: true });
  const removed = manager.gcOrphanEngineSessions();
  assert(removed === 1, `gc should remove exactly the 1 orphan, removed ${removed}`);
  assert(fs.existsSync(liveDir), "gc must keep a live session's engine cache");
  assert(!fs.existsSync(orphanDir), "gc must remove an orphan engine cache");

  // Test 13: clearConversation
  manager.clearConversation(session.id);
  const cleared = manager.getConversation(session.id);
  assert(cleared.length === 0, `conversation should be empty after clear, got ${cleared.length}`);

  // Test 14: save and reload
  manager.saveImmediate();
  const manager2 = new SessionManager(projectManager);
  manager2.load();
  const reloaded = manager2.findById(session.id);
  assert(reloaded, "session should survive save/reload");
  assert(reloaded.title === "Renamed Session", "title should persist after reload");

  console.log("PASS: test-session-manager");
} catch (err) {
  console.error("FAIL:", err.message);
  process.exit(1);
}
