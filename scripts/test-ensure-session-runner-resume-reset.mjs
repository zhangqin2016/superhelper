import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "lily-resume-reset-"));
const previousPaths = Object.fromEntries(["LILY_USER_DATA_DIR", "LILY_HOME", "LILY_DOCUMENTS_DIR"].map((key) => [key, process.env[key]]));
for (const key of Object.keys(previousPaths)) process.env[key] = testRoot;

const require = createRequire(import.meta.url);
const { ensureSessionRunner } = require("../src/main/ipc-utils");
const skillManager = require("../src/main/skill-manager");
const { buildResumeBinding } = require("../src/main/resume-binding");
const { opencodeSessionDir } = require("../src/main/config");

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

  for (const scenario of ["approved-upgrade", "polluted", "foreign-owner", "stale", "unknown-version", "legacy-unbound"]) {
    const session = {
      id: `image-session-${scenario}`,
      projectId: "project-a",
      agentResumeId: `ses_${scenario}`,
    };
    const originalResumeId = session.agentResumeId;
    const shouldResume = scenario === "approved-upgrade" || scenario === "legacy-unbound";
    const project = { id: "project-a", path: process.cwd() };
    let clears = 0;
    let requestedResumeId;
    const ctx = {
      sessionManager: {
        findById(id) {
          assert.equal(id, session.id);
          return session;
        },
        findAgentResumeOwner(resumeId, exceptSessionId) {
          assert.equal(resumeId, originalResumeId);
          assert.equal(exceptSessionId, session.id);
          return scenario === "foreign-owner" ? { id: "other-owner" } : null;
        },
        clearAgentResumeId(id) {
          assert.equal(id, session.id);
          clears += 1;
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
          requestedResumeId = extra.resumeSessionId;
          return { isAlive: () => true, bindOrchestrator() {} };
        },
      },
      turnOrchestrator: { bindRunner() {} },
    };

    const expected = buildResumeBinding({ session, project, activeSkillIds: ["lily-media-generation"], sessionManager: ctx.sessionManager });
    assert.equal(expected.opencodeVersion, "1.18.30", "this integration guard targets the pinned upgrade runtime");
    const historicalBinding = Object.freeze({
      ...expected,
      opencodeVersion: scenario === "unknown-version" ? "1.18.28" : "1.18.29",
      ...(scenario === "polluted" ? { lilySessionId: "stock-session" } : {}),
    });
    if (scenario !== "legacy-unbound") session.agentResumeBinding = historicalBinding;

    // Exercise the real filesystem artifact check; this is a nonempty file
    // fixture, not an assertion that a native engine can read/resume its contents.
    const artifactPath = path.join(opencodeSessionDir(session.id), "opencode.db");
    const artifactBytes = Buffer.from(`SQLite format 3\0resume artifact fixture: ${originalResumeId}`);
    if (scenario !== "stale") {
      fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
      fs.writeFileSync(artifactPath, artifactBytes);
    }

    const result = ensureSessionRunner(ctx, session.id, { spawn: true });
    assert.equal(requestedResumeId, shouldResume ? originalResumeId : null, scenario);
    assert.equal(result.runner?.isAlive(), true);
    assert.equal(result.usedResume, shouldResume, scenario);
    assert.equal(result.coldStart, !shouldResume, "only resetting a rejected live resume should rehydrate local Lily history");
    assert.equal(ctx.runnerPool.terminated, !shouldResume, scenario);
    assert.equal(clears, shouldResume ? 0 : 1, scenario);
    assert.equal(session.agentResumeId, shouldResume ? originalResumeId : undefined, scenario);
    if (shouldResume) {
      assert.equal(session.agentResumeBinding, scenario === "legacy-unbound" ? undefined : historicalBinding,
        "accepted upgrades must retain the original historical metadata object");
      assert.deepEqual(fs.readFileSync(artifactPath), artifactBytes, "accepted resume artifacts must remain unchanged");
    }
  }
} finally {
  Object.assign(skillManager, original);
  if (previousEnginePath === undefined) delete process.env.OPENCODE_BIN;
  else process.env.OPENCODE_BIN = previousEnginePath;
  for (const [key, value] of Object.entries(previousPaths)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(testRoot, { recursive: true, force: true });
}

console.log("ensure session runner resume reset tests passed");
