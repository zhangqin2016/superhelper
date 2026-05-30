#!/usr/bin/env node
import module from "node:module";
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
  shouldPreferLegacyJson,
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

const tmpCurrent = path.join("/tmp", "current-projects.json");
const tmpLegacy = path.join("/tmp", "legacy-projects.json");
if (shouldPreferLegacyJson("projects.json", tmpCurrent, tmpLegacy)) {
  throw new Error("shouldPreferLegacyJson should not replace projects.json wholesale");
}

console.log("data-migration: ok");
