#!/usr/bin/env node
import module from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = module.createRequire(import.meta.url);

const electronPath = require.resolve("electron");
require.cache[electronPath] = {
  id: electronPath,
  filename: electronPath,
  loaded: true,
  exports: {
    app: {
      getPath: () => "/tmp",
    },
  },
};

const {
  mergeProjectsJson,
  mergeSessionsJson,
  migrateLegacyUserDataRoot,
  recoverOrphanLegacyMessageSessions,
  shouldPreferLegacyJson,
  forEachPersistedSession,
} = require(path.join(__dirname, "../src/main/data-migration.js"));

const legacyProjects = {
  activeProjectId: "legacy-only",
  projects: [
    { id: "shared-id", name: "Shared", path: "/tmp/shared", pinned: false },
    { id: "legacy-only", name: "Legacy", path: "/tmp/legacy", pinned: false },
  ],
};

const currentProjects = {
  activeProjectId: "shared-id",
  projects: [
    { id: "shared-id", name: "Current name", path: "/tmp/shared", pinned: true },
  ],
};

const { merged, added } = mergeProjectsJson(currentProjects, legacyProjects);
if (added !== 1 || merged.projects.length !== 2) {
  throw new Error(`mergeProjectsJson added=${added} count=${merged.projects.length}, want 1 and 2`);
}
const shared = merged.projects.find((p) => p.path === "/tmp/shared");
if (!shared || shared.name !== "Current name" || !shared.pinned) {
  throw new Error("mergeProjectsJson should keep current project when paths match");
}

const { merged: mergedSessions, added: sessionsAdded } = mergeSessionsJson(
  { activeSessionId: null, sessions: {} },
  {
    activeSessionId: "sess-1",
    sessions: {
      "legacy-only": [
        {
          id: "sess-1",
          projectId: "legacy-only",
          title: "默认对话",
          messages: [{ role: "user", content: "hi" }],
        },
      ],
    },
  },
  currentProjects.projects,
  legacyProjects.projects,
);
if (sessionsAdded !== 1 || !mergedSessions.sessions["legacy-only"]?.[0]?.messages?.length) {
  throw new Error("mergeSessionsJson should import legacy sessions for new workspaces");
}

const { merged: mergedSameWorkspaceSessions, added: sameWorkspaceAdded } = mergeSessionsJson(
  {
    activeSessionId: "new-session",
    sessions: {
      "shared-id": [
        { id: "new-session", projectId: "shared-id", title: "OpenCode 新会话" },
      ],
    },
  },
  {
    activeSessionId: "old-session",
    sessions: {
      "legacy-shared-id": [
        { id: "old-session", projectId: "legacy-shared-id", title: "Claude 旧会话" },
      ],
    },
  },
  currentProjects.projects,
  [{ id: "legacy-shared-id", name: "Shared", path: "/tmp/shared" }],
);
if (
  sameWorkspaceAdded !== 1 ||
  mergedSameWorkspaceSessions.sessions["shared-id"]?.length !== 2 ||
  !mergedSameWorkspaceSessions.sessions["shared-id"].some((session) => session.id === "old-session")
) {
  throw new Error("mergeSessionsJson should append legacy sessions when the same workspace already has new sessions");
}

const { merged: repairedSameSession, added: repairedSameSessionAdded } = mergeSessionsJson(
  {
    activeSessionId: "same-session",
    sessions: {
      "shared-id": [
        {
          id: "same-session",
          projectId: "shared-id",
          title: "索引会话",
          messages: [{ role: "user", content: "第一条" }],
        },
      ],
    },
  },
  {
    activeSessionId: "same-session",
    sessions: {
      "legacy-shared-id": [
        {
          id: "same-session",
          projectId: "legacy-shared-id",
          title: "旧完整会话",
          messages: [
            { role: "user", content: "第一条" },
            { role: "assistant", content: "第二条" },
          ],
        },
      ],
    },
  },
  currentProjects.projects,
  [{ id: "legacy-shared-id", name: "Shared", path: "/tmp/shared" }],
);
const sameSessionList = repairedSameSession.sessions["shared-id"] || [];
if (
  repairedSameSessionAdded !== 1 ||
  sameSessionList.length !== 1 ||
  sameSessionList[0].messages?.length !== 2 ||
  sameSessionList[0].messages[1].content !== "第二条"
) {
  throw new Error("mergeSessionsJson should repair same-id legacy session messages instead of skipping them");
}

const tmpCurrent = path.join("/tmp", "current-projects.json");
const tmpLegacy = path.join("/tmp", "legacy-projects.json");
if (shouldPreferLegacyJson("projects.json", tmpCurrent, tmpLegacy)) {
  throw new Error("shouldPreferLegacyJson should not replace projects.json wholesale");
}

const resumeRaw = {
  activeSessionId: "s1",
  sessions: {
    proj1: [
      { id: "s1", projectId: "proj1", claudeSessionId: "resume-old", messages: [] },
    ],
  },
};
let resumeChanged = false;
forEachPersistedSession(resumeRaw, (session) => {
  if (session.claudeSessionId && !session.agentResumeId) {
    session.agentResumeId = session.claudeSessionId;
    delete session.claudeSessionId;
    resumeChanged = true;
  }
});
if (!resumeChanged || resumeRaw.sessions.proj1[0].agentResumeId !== "resume-old") {
  throw new Error("forEachPersistedSession should migrate claudeSessionId on nested sessions");
}

// Old releases used Electron's default userData based on productName
// ("Lily Workbench"). New releases pin it to lowercase "lily-workbench".
// A VIP upgrade must merge the old folder before ProjectManager/SessionManager
// load, otherwise the app opens as if history disappeared.
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lily-data-migration-"));
  const currentRoot = path.join(root, "lily-workbench");
  const legacyRoot = path.join(root, "Lily Workbench");
  process.env.LILY_USER_DATA_DIR = currentRoot;
  fs.mkdirSync(path.join(legacyRoot, "session-messages"), { recursive: true });
  fs.mkdirSync(path.join(legacyRoot, "opencode-shared"), { recursive: true });
  fs.writeFileSync(path.join(legacyRoot, "projects.json"), JSON.stringify({
    activeProjectId: "legacy-project",
    projects: [{ id: "legacy-project", name: "VIP Workspace", path: "/vip/workspace" }],
  }), "utf8");
  fs.writeFileSync(path.join(legacyRoot, "sessions.json"), JSON.stringify({
    activeSessionId: "vip-session",
    sessions: {
      "legacy-project": [
        { id: "vip-session", projectId: "legacy-project", title: "VIP 历史会话" },
      ],
    },
  }), "utf8");
  fs.writeFileSync(path.join(legacyRoot, "session-messages", "vip-session.json"), JSON.stringify({
    messages: [{ role: "user", content: "历史问题" }],
  }), "utf8");
  fs.writeFileSync(path.join(legacyRoot, "opencode-shared", "opencode.db"), "legacy-opencode-db", "utf8");

  migrateLegacyUserDataRoot();

  const migratedProjects = JSON.parse(fs.readFileSync(path.join(currentRoot, "projects.json"), "utf8"));
  const migratedSessions = JSON.parse(fs.readFileSync(path.join(currentRoot, "sessions.json"), "utf8"));
  if (migratedProjects.projects?.[0]?.name !== "VIP Workspace") {
    throw new Error("legacy productName userData project should migrate into current root");
  }
  if (migratedSessions.sessions?.["legacy-project"]?.[0]?.id !== "vip-session") {
    throw new Error("legacy productName userData session should migrate into current root");
  }
  if (!fs.existsSync(path.join(currentRoot, "session-messages", "vip-session.json"))) {
    throw new Error("legacy per-session messages should migrate into current root");
  }
  if (!fs.existsSync(path.join(currentRoot, "opencode-shared", "opencode.db"))) {
    throw new Error("legacy OpenCode shared database should migrate into current root");
  }
  if (!fs.existsSync(`${legacyRoot}.migrated-backup`)) {
    throw new Error("legacy userData root should be archived instead of deleted");
  }
}

// A real VIP path can be Claude -> OpenCode -> current. If the current app
// already has a split sessions-index for the same workspace, legacy sessions
// from the old productName folder must still be appended into that index.
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lily-data-migration-chain-"));
  const currentRoot = path.join(root, "lily-workbench");
  const legacyRoot = path.join(root, "Lily Workbench");
  process.env.LILY_USER_DATA_DIR = currentRoot;
  fs.mkdirSync(currentRoot, { recursive: true });
  fs.mkdirSync(legacyRoot, { recursive: true });
  fs.writeFileSync(path.join(currentRoot, "projects.json"), JSON.stringify({
    activeProjectId: "current-project",
    projects: [{ id: "current-project", name: "VIP Workspace", path: "/vip/workspace" }],
  }), "utf8");
  fs.writeFileSync(path.join(currentRoot, "sessions-index.json"), JSON.stringify({
    activeSessionId: "opencode-session",
    sessions: {
      "current-project": [
        { id: "opencode-session", projectId: "current-project", title: "OpenCode 新会话" },
      ],
    },
  }), "utf8");
  fs.writeFileSync(path.join(legacyRoot, "projects.json"), JSON.stringify({
    activeProjectId: "claude-project",
    projects: [{ id: "claude-project", name: "VIP Workspace", path: "/vip/workspace" }],
  }), "utf8");
  fs.writeFileSync(path.join(legacyRoot, "sessions.json"), JSON.stringify({
    activeSessionId: "claude-session",
    sessions: {
      "claude-project": [
        { id: "claude-session", projectId: "claude-project", title: "Claude 旧会话" },
      ],
    },
  }), "utf8");

  migrateLegacyUserDataRoot();

  const migratedIndex = JSON.parse(fs.readFileSync(path.join(currentRoot, "sessions-index.json"), "utf8"));
  const list = migratedIndex.sessions?.["current-project"] || [];
  if (list.length !== 2 || !list.some((session) => session.id === "claude-session")) {
    throw new Error("Claude -> OpenCode -> current upgrade should preserve same-workspace legacy sessions");
  }
  const migratedLegacy = list.find((session) => session.id === "claude-session");
  if (migratedLegacy.projectId !== "current-project") {
    throw new Error("same-workspace legacy session should be remapped to the current project id");
  }
}

// If a prior bad migration copied legacy message files but dropped the session
// index, recover visible session entries instead of leaving history invisible.
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lily-data-migration-orphan-"));
  const currentRoot = path.join(root, "lily-workbench");
  process.env.LILY_USER_DATA_DIR = currentRoot;
  fs.mkdirSync(path.join(currentRoot, "session-messages"), { recursive: true });
  fs.writeFileSync(path.join(currentRoot, "projects.json"), JSON.stringify({
    activeProjectId: "current-project",
    projects: [{ id: "current-project", name: "VIP Workspace", path: "/vip/workspace" }],
  }), "utf8");
  fs.writeFileSync(path.join(currentRoot, "sessions-index.json"), JSON.stringify({
    activeSessionId: "visible-session",
    sessions: {
      "current-project": [
        { id: "visible-session", projectId: "current-project", title: "已有会话" },
      ],
    },
  }), "utf8");
  fs.writeFileSync(path.join(currentRoot, "session-messages", "orphan-session.json"), JSON.stringify({
    messages: [{ role: "user", content: "被遗漏的历史问题" }],
  }), "utf8");

  if (!recoverOrphanLegacyMessageSessions()) {
    throw new Error("orphan legacy message file should recover a visible session entry");
  }
  const migratedIndex = JSON.parse(fs.readFileSync(path.join(currentRoot, "sessions-index.json"), "utf8"));
  const recovered = migratedIndex.sessions["current-project"].find((session) => session.id === "orphan-session");
  if (!recovered || recovered.title !== "恢复的历史会话" || !recovered.recoveredFromLegacyMessages) {
    throw new Error("recovered orphan session should be visible and marked as recovered");
  }
}

// Already-imported legacy message files are a safety archive, not a source of
// new sessions. Re-scanning them on every startup can flood the sidebar with
// synthetic "recovered history" sessions even though the real sessions exist.
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lily-data-migration-imported-ignore-"));
  const currentRoot = path.join(root, "lily-workbench");
  process.env.LILY_USER_DATA_DIR = currentRoot;
  fs.mkdirSync(path.join(currentRoot, "session-messages.imported"), { recursive: true });
  fs.writeFileSync(path.join(currentRoot, "projects.json"), JSON.stringify({
    activeProjectId: "current-project",
    projects: [{ id: "current-project", name: "VIP Workspace", path: "/vip/workspace" }],
  }), "utf8");
  fs.writeFileSync(path.join(currentRoot, "sessions-index.json"), JSON.stringify({
    activeSessionId: "visible-session",
    sessions: {
      "current-project": [
        { id: "visible-session", projectId: "current-project", title: "已有会话" },
      ],
    },
  }), "utf8");
  fs.writeFileSync(path.join(currentRoot, "session-messages.imported", "already-imported-session.json"), JSON.stringify({
    messages: [{ role: "user", content: "已经导入过的历史问题" }],
  }), "utf8");

  if (recoverOrphanLegacyMessageSessions()) {
    throw new Error("imported legacy message archive should not create recovered sessions");
  }
  const migratedIndex = JSON.parse(fs.readFileSync(path.join(currentRoot, "sessions-index.json"), "utf8"));
  const recovered = migratedIndex.sessions["current-project"].find((session) => session.id === "already-imported-session");
  if (recovered) {
    throw new Error("imported archive session should remain hidden from the live session index");
  }
}

{
  const mainSource = fs.readFileSync(path.join(__dirname, "../src/main.js"), "utf8");
  const migrationIndex = mainSource.indexOf('runDataMigrations()');
  const projectLoadIndex = mainSource.indexOf('projectManager.load()');
  if (migrationIndex < 0 || projectLoadIndex < 0 || migrationIndex > projectLoadIndex) {
    throw new Error("main startup must run data migrations before loading projects/sessions");
  }
}

console.log("data-migration: ok");
