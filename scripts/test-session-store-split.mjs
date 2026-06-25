#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import module from "node:module";

const require = module.createRequire(import.meta.url);
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "lily-session-store-split-"));
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
const {
  blobStoreDir,
  legacySessionsBackupPath,
  messageDbPath,
  sessionMessagesImportedDir,
  sessionsConfigPath,
  sessionsIndexPath,
} = require("../src/main/config.js");
const { MessageStore } = require("../src/main/store/message-store.js");

const projectManager = {
  projects: [{ id: "p1", name: "Workspace", path: tempRoot }],
  getActive() {
    return this.projects[0];
  },
};

try {
  fs.mkdirSync(userData, { recursive: true });
  fs.writeFileSync(
    sessionsConfigPath(),
    JSON.stringify({
      activeSessionId: "s1",
      sessions: {
        p1: [{
          id: "s1",
          projectId: "p1",
          title: "旧会话",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
          status: "idle",
          messages: Array.from({ length: 205 }, (_, index) => ({
            role: index % 2 === 0 ? "user" : "assistant",
            content: `旧消息 ${index + 1}`,
          })),
        }],
      },
    }, null, 2),
  );

  const manager = new SessionManager(projectManager);
  manager.load();

  if (fs.existsSync(sessionsConfigPath())) {
    throw new Error("legacy sessions.json should be removed after split migration");
  }
  if (!fs.existsSync(legacySessionsBackupPath())) {
    throw new Error("legacy sessions.json should be backed up once migration succeeds");
  }

  const index = JSON.parse(fs.readFileSync(sessionsIndexPath(), "utf8"));
  const indexedSession = index.sessions.p1?.[0];
  if (!indexedSession || indexedSession.messageCount !== 205) {
    throw new Error(`session index missing messageCount: ${JSON.stringify(indexedSession)}`);
  }
  // The lightweight index must never carry message bodies — that separation is
  // what keeps session listing cheap regardless of history size.
  if ("messages" in indexedSession) {
    throw new Error("session index must not contain message bodies");
  }

  // Legacy inline messages must migrate into the SQLite store without loss
  // and in original order.
  const conversation = manager.getConversation("s1");
  if (conversation.length !== 205 || conversation[0].content !== "旧消息 1" || conversation[204].content !== "旧消息 205") {
    throw new Error(`manager should load migrated conversation: ${conversation.length}`);
  }

  // Opening a large session returns only the newest page (bounded read — the
  // fix for the freeze), with a keyset cursor for loading older messages.
  const page = manager.getConversationPage("s1");
  if (
    page.conversation.length !== 50 ||
    page.conversation[0].content !== "旧消息 156" ||
    page.conversation[49].content !== "旧消息 205" ||
    !page.hasMore ||
    !Number.isInteger(page.nextBefore)
  ) {
    throw new Error(`default conversation page should return latest 50: ${JSON.stringify({ len: page.conversation.length, first: page.conversation[0]?.content, hasMore: page.hasMore, nextBefore: page.nextBefore })}`);
  }

  // The cursor walks backwards through history.
  const older = manager.getConversationPage("s1", { before: page.nextBefore, limit: 50 });
  if (older.conversation.length !== 50 || older.conversation[49].content !== "旧消息 155") {
    throw new Error(`older page should precede the newest: ${older.conversation[49]?.content}`);
  }

  console.log("session-store-split: ok");
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}

const mergeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "lily-session-store-merge-"));
const mergeUserData = path.join(mergeRoot, "userData");
require.cache[electronPath].exports.app.getPath = (name) => {
  if (name === "userData") return mergeUserData;
  if (name === "home") return mergeRoot;
  if (name === "documents") return mergeRoot;
  return mergeRoot;
};

try {
  fs.mkdirSync(mergeUserData, { recursive: true });
  fs.writeFileSync(
    sessionsIndexPath(),
    JSON.stringify({
      activeSessionId: "s-current",
      sessions: {
        p1: [{
          id: "s-current",
          projectId: "p1",
          title: "当前会话",
          status: "idle",
          messageCount: 0,
        }],
      },
    }, null, 2),
  );
  fs.writeFileSync(
    sessionsConfigPath(),
    JSON.stringify({
      activeSessionId: "s-legacy",
      sessions: {
        p1: [{
          id: "s-legacy",
          projectId: "p1",
          title: "补迁移会话",
          status: "idle",
          messages: [{ role: "user", content: "补迁移消息" }],
        }],
      },
    }, null, 2),
  );

  const manager = new SessionManager(projectManager);
  manager.load();
  const mergedConversation = manager.getConversation("s-legacy");
  if (mergedConversation[0]?.content !== "补迁移消息") {
    throw new Error(`split store should merge later legacy sessions: ${JSON.stringify(mergedConversation)}`);
  }
  const mergedIndex = JSON.parse(fs.readFileSync(sessionsIndexPath(), "utf8"));
  if (!mergedIndex.sessions.p1.some((session) => session.id === "s-legacy")) {
    throw new Error("merged legacy session missing from split index");
  }
  if (fs.existsSync(sessionsConfigPath())) {
    throw new Error("merged legacy sessions.json should be removed");
  }
} finally {
  fs.rmSync(mergeRoot, { recursive: true, force: true });
}

const repairRoot = fs.mkdtempSync(path.join(os.tmpdir(), "lily-session-store-repair-"));
const repairUserData = path.join(repairRoot, "userData");
require.cache[electronPath].exports.app.getPath = (name) => {
  if (name === "userData") return repairUserData;
  if (name === "home") return repairRoot;
  if (name === "documents") return repairRoot;
  return repairRoot;
};

try {
  fs.mkdirSync(repairUserData, { recursive: true });
  fs.writeFileSync(
    sessionsIndexPath(),
    JSON.stringify({
      activeSessionId: "same-session",
      sessions: {
        p1: [{
          id: "same-session",
          projectId: "p1",
          title: "索引会话",
          status: "idle",
          messageCount: 1,
        }],
      },
    }, null, 2),
  );

  // Simulate a partial previous migration: one message already made it into
  // SQLite, but the legacy inline source still has the complete transcript.
  const store = new MessageStore(messageDbPath(), blobStoreDir());
  store.bulkInsert("same-session", [{ role: "user", content: "第一条" }]);
  store.close();

  fs.writeFileSync(
    sessionsConfigPath(),
    JSON.stringify({
      activeSessionId: "same-session",
      sessions: {
        p1: [{
          id: "same-session",
          projectId: "p1",
          title: "旧会话完整记录",
          status: "idle",
          messages: [
            { role: "user", content: "第一条" },
            { role: "assistant", content: "第二条" },
            { role: "user", content: "第三条" },
          ],
        }],
      },
    }, null, 2),
  );

  const manager = new SessionManager(projectManager);
  manager.load();

  const list = JSON.parse(fs.readFileSync(sessionsIndexPath(), "utf8")).sessions.p1 || [];
  if (list.filter((session) => session.id === "same-session").length !== 1) {
    throw new Error("same-id legacy session should repair the existing index entry, not create a duplicate");
  }
  const repaired = manager.getConversation("same-session");
  if (
    repaired.length !== 3 ||
    repaired[0].content !== "第一条" ||
    repaired[1].content !== "第二条" ||
    repaired[2].content !== "第三条"
  ) {
    throw new Error(`partial migrated session should be repaired without loss: ${JSON.stringify(repaired)}`);
  }
} finally {
  fs.rmSync(repairRoot, { recursive: true, force: true });
}

const rescueRoot = fs.mkdtempSync(path.join(os.tmpdir(), "lily-session-store-rescue-"));
const rescueUserData = path.join(rescueRoot, "userData");
require.cache[electronPath].exports.app.getPath = (name) => {
  if (name === "userData") return rescueUserData;
  if (name === "home") return rescueRoot;
  if (name === "documents") return rescueRoot;
  return rescueRoot;
};

try {
  fs.mkdirSync(sessionMessagesImportedDir(), { recursive: true });
  fs.writeFileSync(
    sessionsIndexPath(),
    JSON.stringify({
      activeSessionId: "archived-session",
      sessions: {
        p1: [{
          id: "archived-session",
          projectId: "p1",
          title: "真实历史会话",
          status: "idle",
          messageCount: 2,
        }],
      },
    }, null, 2),
  );
  fs.writeFileSync(
    path.join(sessionMessagesImportedDir(), "archived-session.json"),
    JSON.stringify({
      messages: [
        { role: "user", content: "升级前的问题" },
        { role: "assistant", content: "升级前的回答" },
      ],
    }, null, 2),
  );

  const manager = new SessionManager(projectManager);
  manager.load();
  const rescued = manager.getConversation("archived-session");
  if (rescued.length !== 2 || rescued[0].content !== "升级前的问题" || rescued[1].content !== "升级前的回答") {
    throw new Error(`existing session should rescue messages from imported archive: ${JSON.stringify(rescued)}`);
  }
  const rescuedIndex = JSON.parse(fs.readFileSync(sessionsIndexPath(), "utf8"));
  const recoveredDuplicates = (rescuedIndex.sessions.p1 || []).filter((session) => session.title === "恢复的历史会话");
  if (recoveredDuplicates.length !== 0) {
    throw new Error("imported archive rescue must not create synthetic recovered sessions");
  }
} finally {
  fs.rmSync(rescueRoot, { recursive: true, force: true });
}

const backupRescueRoot = fs.mkdtempSync(path.join(os.tmpdir(), "lily-session-store-backup-rescue-"));
const backupRescueUserData = path.join(backupRescueRoot, "userData");
require.cache[electronPath].exports.app.getPath = (name) => {
  if (name === "userData") return backupRescueUserData;
  if (name === "home") return backupRescueRoot;
  if (name === "documents") return backupRescueRoot;
  return backupRescueRoot;
};

try {
  fs.mkdirSync(backupRescueUserData, { recursive: true });
  fs.writeFileSync(
    sessionsIndexPath(),
    JSON.stringify({
      activeSessionId: "backup-session",
      sessions: {
        p1: [{
          id: "backup-session",
          projectId: "p1",
          title: "备份历史会话",
          status: "idle",
          messageCount: 2,
        }],
      },
    }, null, 2),
  );
  fs.writeFileSync(
    legacySessionsBackupPath(),
    JSON.stringify({
      activeSessionId: "backup-session",
      sessions: {
        p1: [{
          id: "backup-session",
          projectId: "p1",
          title: "备份历史会话",
          status: "idle",
          messages: [
            { role: "user", content: "备份里的问题" },
            { role: "assistant", content: "备份里的回答" },
          ],
        }],
      },
    }, null, 2),
  );

  const manager = new SessionManager(projectManager);
  manager.load();
  const rescued = manager.getConversation("backup-session");
  if (rescued.length !== 2 || rescued[0].content !== "备份里的问题" || rescued[1].content !== "备份里的回答") {
    throw new Error(`existing session should rescue messages from legacy sessions backup: ${JSON.stringify(rescued)}`);
  }
} finally {
  fs.rmSync(backupRescueRoot, { recursive: true, force: true });
}
