#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import module from "node:module";

const require = module.createRequire(import.meta.url);
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "lily-session-save-flush-"));
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
const { sessionsIndexPath } = require("../src/main/config.js");

const projectManager = {
  projects: [{ id: "p1", name: "Workspace", path: tempRoot }],
  getActive() {
    return this.projects[0];
  },
};

let manager;
let reopened;

try {
  manager = new SessionManager(projectManager);
  manager.load();
  const session = manager.getActive();
  if (!session) throw new Error("expected default session");

  manager.pushMessageTo(session.id, "user", "last question");
  manager.pushMessageTo(session.id, "assistant", "last answer");

  // Messages persist durably the instant they're appended (single-row insert),
  // not via a debounced full-file rewrite — that O(1) append is what kills the
  // old O(n²) save cost. Verify they are immediately retrievable.
  const persisted = manager.getConversation(session.id).map((m) => m.content);
  if (!persisted.includes("last question") || !persisted.includes("last answer")) {
    throw new Error(`messages not persisted on append: ${JSON.stringify(persisted)}`);
  }

  // The session index file must remain a lightweight catalog with no bodies.
  manager.saveImmediate();
  const indexAfter = JSON.parse(fs.readFileSync(sessionsIndexPath(), "utf8"));
  if ("messages" in indexAfter.sessions.p1[0]) {
    throw new Error("session index must not persist full messages");
  }
  if (indexAfter.sessions.p1[0].messageCount !== 2) {
    throw new Error(`index messageCount should track appends: ${indexAfter.sessions.p1[0].messageCount}`);
  }

  // Durability across a fresh process: a new manager sees the same history.
  reopened = new SessionManager(projectManager);
  reopened.load();
  const afterReopen = reopened.getConversation(session.id).map((m) => m.content);
  if (!afterReopen.includes("last question") || !afterReopen.includes("last answer")) {
    throw new Error(`messages did not survive reopen: ${JSON.stringify(afterReopen)}`);
  }

  console.log("session-save-flush: ok");
} finally {
  manager?.close?.();
  reopened?.close?.();
  fs.rmSync(tempRoot, { recursive: true, force: true });
}
