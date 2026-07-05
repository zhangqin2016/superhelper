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
