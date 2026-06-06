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
const { sessionMessagesDir, sessionsIndexPath } = require("../src/main/config.js");

const projectManager = {
  projects: [{ id: "p1", name: "Workspace", path: tempRoot }],
  getActive() {
    return this.projects[0];
  },
};

try {
  const manager = new SessionManager(projectManager);
  manager.load();
  const session = manager.getActive();
  if (!session) throw new Error("expected default session");

  manager.pushMessageTo(session.id, "user", "last question");
  manager.pushMessageTo(session.id, "assistant", "last answer");

  const messagePath = path.join(sessionMessagesDir(), `${session.id}.json`);
  const beforeFlush = JSON.parse(fs.readFileSync(messagePath, "utf8"));
  const savedBefore = beforeFlush.messages.map((message) => message.content);
  if (savedBefore.includes("last answer")) {
    throw new Error("test setup invalid: pending assistant message was already persisted");
  }

  manager.saveImmediate();
  const indexAfter = JSON.parse(fs.readFileSync(sessionsIndexPath(), "utf8"));
  if ("messages" in indexAfter.sessions.p1[0]) {
    throw new Error("session index must not persist full messages");
  }

  const afterFlush = JSON.parse(fs.readFileSync(messagePath, "utf8"));
  const savedAfter = afterFlush.messages.map((message) => message.content);
  if (!savedAfter.includes("last question") || !savedAfter.includes("last answer")) {
    throw new Error(`saveImmediate did not flush pending messages: ${JSON.stringify(savedAfter)}`);
  }

  console.log("session-save-flush: ok");
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}
