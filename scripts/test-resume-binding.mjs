import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  buildResumeBinding,
  verifyResumeBinding,
} = require("../src/main/resume-binding");

const session = {
  id: "lily-image-session",
  projectId: "project-a",
  agentResumeId: "ses_image",
};
const project = {
  id: "project-a",
  path: "D:\\aicode\\superhelpr",
};
const sessionManager = {
  getConversation(sessionId) {
    assert.equal(sessionId, session.id);
    return [{ role: "user", content: "epicrealism" }];
  },
};
const activeSkillIds = ["lily-media-generation", "lily-template-fill"];

const binding = buildResumeBinding({
  session,
  project,
  activeSkillIds,
  sessionManager,
  resumeId: session.agentResumeId,
});
const emptySkillsBinding = buildResumeBinding({
  session,
  project,
  activeSkillIds: [],
  sessionManager,
  resumeId: session.agentResumeId,
});

assert.notEqual(binding.enabledSkillIdsHash, emptySkillsBinding.enabledSkillIdsHash, "active skill ids must affect resume binding");

{
  const oldBinding = Object.freeze({ ...binding, opencodeVersion: "1.18.29" });
  const expected = { ...binding, opencodeVersion: "1.18.30" };
  const historical = { ...oldBinding };
  const result = verifyResumeBinding({ ...session, agentResumeBinding: oldBinding }, expected);
  assert.equal(result.ok, true, "the explicitly validated 1.18.29 -> 1.18.30 upgrade must retain resume continuity");
  assert.deepEqual(oldBinding, historical, "accepting an upgrade must not rewrite historical binding metadata");
  assert.equal(verifyResumeBinding({
    ...session,
    agentResumeBinding: { ...oldBinding, firstUserMessageHash: "" },
  }, expected).ok, true, "the approved upgrade must preserve resumes emitted before the first user message");

  for (const key of ["resumeId", "lilySessionId", "projectId", "workspacePathHash", "enabledSkillIdsHash", "firstUserMessageHash"]) {
    const mismatch = verifyResumeBinding({
      ...session,
      agentResumeBinding: { ...oldBinding, [key]: "foreign-identity" },
    }, expected);
    assert.equal(mismatch.ok, false, `an approved upgrade must still reject mismatched ${key}`);
    assert.equal(mismatch.reason, `binding_${key}_mismatch`);
  }
}

for (const [actualVersion, expectedVersion] of [
  ["1.18.30", "1.18.29"],
  ["1.18.28", "1.18.30"],
  ["1.18.29", "1.18.31"],
  ["1.18.30", "1.18.31"],
  ["1.17.29", "1.18.30"],
  ["1.18.29", "2.0.0"],
  ["1.18.29-beta", "1.18.30"],
  ["^1.18.29", "1.18.30"],
  ["1.18.29", "~1.18.30"],
  [" 1.18.29", "1.18.30"],
  ["1.18.29", "1.18.30 "],
  ["garbage", "1.18.30"],
  [["1.18.29"], "1.18.30"],
  ["1.18.29", ["1.18.30"]],
  [{ version: "1.18.29" }, "1.18.30"],
  ["", "1.18.30"],
  ["1.18.29", undefined],
]) {
  const result = verifyResumeBinding({
    ...session,
    agentResumeBinding: { ...binding, opencodeVersion: actualVersion },
  }, { ...binding, opencodeVersion: expectedVersion });
  assert.equal(result.ok, false, `unapproved version pair ${JSON.stringify(actualVersion)} -> ${JSON.stringify(expectedVersion)} must be rejected`);
  assert.equal(result.reason, "binding_opencodeVersion_mismatch");
}

for (const version of ["1.18.29", "1.18.30", "1.18.31", "legacy", ""]) {
  const sameVersionBinding = { ...binding, opencodeVersion: version };
  assert.equal(verifyResumeBinding({
    ...session,
    agentResumeBinding: sameVersionBinding,
  }, sameVersionBinding).ok, true, "existing exact-version behavior must remain unchanged");
}

{
  const result = verifyResumeBinding({ ...session, agentResumeBinding: binding }, binding);
  assert.equal(result.ok, true, "matching Lily resume binding should be accepted");
}

{
  const stockSession = {
    ...session,
    id: "lily-stock-session",
    agentResumeBinding: binding,
  };
  const expected = buildResumeBinding({
    session: stockSession,
    project,
    activeSkillIds,
    sessionManager: {
      getConversation() {
        return [{ role: "user", content: "analyze stock 600171 latest fundamentals" }];
      },
    },
    resumeId: session.agentResumeId,
  });
  const result = verifyResumeBinding(stockSession, expected);
  assert.equal(result.ok, false, "resume binding must reject a different Lily session");
  assert.equal(result.reason, "binding_lilySessionId_mismatch");
}

{
  const result = verifyResumeBinding({
    ...session,
    agentResumeBinding: { ...binding, enabledSkillIdsHash: "wrong-skills" },
  }, binding);
  assert.equal(result.ok, false, "resume binding must reject a different active skill set");
  assert.equal(result.reason, "binding_enabledSkillIdsHash_mismatch");
}

{
  const result = verifyResumeBinding({ ...session, agentResumeBinding: null }, binding);
  assert.equal(result.ok, true, "legacy unbound resume should fail open to continuity guard");
  assert.equal(result.reason, "legacy_unbound_resume");
}

{
  const result = verifyResumeBinding({
    ...session,
    agentResumeBinding: { ...binding, firstUserMessageHash: "" },
  }, binding);
  assert.equal(result.ok, true, "resume id emitted before the first user message should not break the second turn");
}

console.log("resume binding tests passed");
