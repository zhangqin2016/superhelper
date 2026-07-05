import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  buildResumeBinding,
  verifyResumeBinding,
} = require("../src/main/resume-binding");
const {
  classifyResumeContinuity,
  verifyRunnerResumeContinuity,
} = require("../src/main/resume-continuity-guard");

{
  const result = classifyResumeContinuity({
    localMessages: [{ role: "user", content: "generate one realistic image" }],
    officialMessages: [{ role: "user", content: "please generate one realistic image" }],
  });
  assert.equal(result.ok, true, "overlapping recent user history should be accepted");
}

{
  const result = classifyResumeContinuity({
    localMessages: [],
    officialMessages: [{ role: "user", content: "analyze stock 600171 latest fundamentals" }],
  });
  assert.equal(result.ok, false, "empty local session must not inherit populated engine history");
  assert.equal(result.reason, "official_history_for_empty_local_session");
}

{
  const result = classifyResumeContinuity({
    localMessages: [{ role: "user", content: "epicrealism" }],
    officialMessages: [{ role: "user", content: "analyze stock 600171 latest fundamentals" }],
  });
  assert.equal(result.ok, false, "image generation session must reject unrelated stock history");
  assert.equal(result.reason, "recent_user_history_mismatch");
}

{
  const result = classifyResumeContinuity({
    localMessages: [{ role: "user", content: "epicrealism" }],
    officialMessages: [],
  });
  assert.equal(result.ok, true, "empty official history should not block resume");
}

{
  const runner = {
    async getConversationPage() {
      return {
        conversation: [{ role: "user", content: "analyze stock 600171 latest fundamentals" }],
      };
    },
  };
  const sessionManager = {
    getConversation(sessionId) {
      assert.equal(sessionId, "image-session");
      return [{ role: "user", content: "epicrealism" }];
    },
  };
  const result = await verifyRunnerResumeContinuity({
    runner,
    sessionManager,
    sessionId: "image-session",
  });
  assert.equal(result.ok, false, "runner continuity verifier should expose mismatched resume history");
}

{
  const runner = {
    async getConversationPage() {
      return new Promise(() => {});
    },
  };
  const result = await verifyRunnerResumeContinuity({
    runner,
    sessionManager: {
      getConversation() {
        throw new Error("local history should not be needed after timeout");
      },
    },
    sessionId: "slow-session",
    timeoutMs: 5,
  });
  assert.equal(result.ok, true, "slow official history check should fail open");
  assert.equal(result.reason, "official_history_timeout");
}

{
  const sessionManager = {
    getConversation(sessionId) {
      assert.equal(sessionId, "s1");
      return [{ role: "user", content: "draft a sales deck" }];
    },
  };
  const session = { id: "s1", projectId: "p1", agentResumeId: "resume-a" };
  const binding = buildResumeBinding({
    session,
    project: { id: "p1", path: "D:/work/sales" },
    activeSkillIds: ["lily-docs", "learned-sales"],
    sessionManager,
  });
  assert.equal(verifyResumeBinding({ ...session, agentResumeBinding: binding }, binding).ok, true);

  const mismatched = buildResumeBinding({
    session: { ...session, agentResumeId: "resume-b" },
    project: { id: "p1", path: "D:/work/sales" },
    activeSkillIds: ["lily-docs", "learned-sales"],
    sessionManager,
  });
  const result = verifyResumeBinding({ ...session, agentResumeBinding: binding }, mismatched);
  assert.equal(result.ok, false, "binding mismatch should force a fresh engine session");
  assert.equal(result.reason, "binding_resumeId_mismatch");
}

console.log("resume continuity guard tests passed");
