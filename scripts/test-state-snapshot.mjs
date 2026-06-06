#!/usr/bin/env node
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { buildFullStateSnapshot } = require("../src/main/state-snapshot.js");

const hugeMessage = "x".repeat(1024 * 1024);
const snapshot = buildFullStateSnapshot({
  projectState: {
    activeProjectId: "p1",
    projects: [{ id: "p1", name: "Workspace", path: "/tmp/workspace" }],
  },
  sessionManager: {
    activeSessionId: "s1",
    listForProject(projectId) {
      if (projectId !== "p1") return [];
      return [{
        id: "s1",
        title: "默认对话",
        messageCount: 200,
        status: "idle",
        messages: [{ role: "assistant", content: hugeMessage }],
      }];
    },
  },
  runnerPool: {
    getSessionIds() {
      return ["s1"];
    },
  },
  getRuntimeSnapshot(sessionId) {
    return { sessionId, phase: "idle" };
  },
  agent: { ok: true, cliPath: "/bin/lily" },
  cliPath: "/bin/lily",
  cliReady: true,
  models: [],
  permissions: [],
});

if (snapshot.conversation.length !== 0) {
  throw new Error("state:full must not include active conversation history");
}

const session = snapshot.projects[0]?.sessions?.[0];
if (!session) throw new Error("expected session summary");

if ("messages" in session) {
  throw new Error("state:full session summaries must not include messages");
}

if (JSON.stringify(snapshot).includes(hugeMessage)) {
  throw new Error("state:full leaked full message content");
}

if (snapshot.runtime.sessions.s1.phase !== "idle") {
  throw new Error("runtime snapshot should still be included");
}

console.log("state-snapshot: ok");
