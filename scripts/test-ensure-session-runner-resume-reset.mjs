import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

process.env.LILY_USER_DATA_DIR ||= fs.mkdtempSync(path.join(os.tmpdir(), "lily-resume-reset-"));

const require = createRequire(import.meta.url);
const { ensureSessionRunner } = require("../src/main/ipc-utils");
const skillManager = require("../src/main/skill-manager");

const original = {
  writeSessionAgentGuide: skillManager.writeSessionAgentGuide,
  resolveSessionSkillIds: skillManager.resolveSessionSkillIds,
  getDisallowedTools: skillManager.getDisallowedTools,
};
const previousEnginePath = process.env.OPENCODE_BIN;

try {
  // The runner pool below is a test double: this existing executable only
  // satisfies engine discovery, and is never launched as an assistant engine.
  process.env.OPENCODE_BIN = process.execPath;
  skillManager.writeSessionAgentGuide = () => process.cwd();
  skillManager.resolveSessionSkillIds = () => ["lily-media-generation"];
  skillManager.getDisallowedTools = () => [];

  const session = {
    id: "image-session",
    projectId: "project-a",
    agentResumeId: "ses_stock",
    agentResumeBinding: {
      version: 1,
      resumeId: "ses_stock",
      lilySessionId: "stock-session",
      projectId: "project-a",
      workspacePathHash: "wrong",
      enabledSkillIdsHash: "wrong",
      firstUserMessageHash: "",
      opencodeVersion: "wrong",
    },
  };
  const project = { id: "project-a", path: process.cwd() };
  const ctx = {
    sessionManager: {
      findById(id) {
        assert.equal(id, session.id);
        return session;
      },
      findAgentResumeOwner() {
        return null;
      },
      clearAgentResumeId(id) {
        assert.equal(id, session.id);
        delete session.agentResumeId;
        delete session.agentResumeBinding;
      },
      getConversation() {
        return [{ role: "user", content: "epicrealism" }];
      },
    },
    projectManager: {
      find(id) {
        assert.equal(id, project.id);
        return project;
      },
    },
    runnerPool: {
      terminated: false,
      get(id) {
        assert.equal(id, session.id);
        return { isAlive: () => true };
      },
      terminateSession(id) {
        assert.equal(id, session.id);
        this.terminated = true;
      },
      ensure(id, cwd, extra) {
        assert.equal(id, session.id);
        assert.equal(cwd, project.path);
        assert.equal(extra.resumeSessionId, null);
        return { isAlive: () => true, bindOrchestrator() {} };
      },
    },
    turnOrchestrator: { bindRunner() {} },
  };

  const result = ensureSessionRunner(ctx, session.id, { spawn: true });
  assert.equal(result.runner?.isAlive(), true);
  assert.equal(result.usedResume, false);
  assert.equal(result.coldStart, true, "resetting a polluted live resume must rehydrate local Lily history");
  assert.equal(ctx.runnerPool.terminated, true);
  assert.equal(session.agentResumeId, undefined);
} finally {
  Object.assign(skillManager, original);
  if (previousEnginePath === undefined) delete process.env.OPENCODE_BIN;
  else process.env.OPENCODE_BIN = previousEnginePath;
}

console.log("ensure session runner resume reset tests passed");
