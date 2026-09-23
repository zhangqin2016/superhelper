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

// 2026-09-14 field case: a conversation of short Chinese turns ("继续",
// "帮我优化", "现在不能用啊") was reset on every send because the engine
// stores the LAYERED text Lily sent and the flat 6-char floor never let a
// 4-char CJK message match. Compare the user's own words, script-aware.
{
  const { buildLayeredEngineText } = require("../src/main/engine-message-layers");
  const layered = buildLayeredEngineText({
    userText: "帮我优化",
    platformContext: "internal lily context. current date/time: 2026-09-14 23:56 (utc+4).",
  });
  assert.ok(layered.includes('<lily_layer title="user_original_request">'), "fixture is layered engine text");
  const result = classifyResumeContinuity({
    localMessages: [
      { role: "user", content: "继续" },
      { role: "user", content: "帮我优化" },
      { role: "user", content: "现在不能用啊" },
    ],
    officialMessages: [{ role: "user", content: layered }],
  });
  assert.equal(result.ok, true, `short CJK turns wrapped in lily layers must still match their local record (${result.reason})`);
  assert.equal(result.reason, "recent_user_overlap");
}

{
  const result = classifyResumeContinuity({
    localMessages: [{ role: "user", content: "继续" }],
    officialMessages: [{ role: "user", content: "请继续把报告写完" }],
  });
  assert.equal(result.ok, true, "a 2-character CJK follow-up contained in the engine turn is an overlap");
  const unrelated = classifyResumeContinuity({
    localMessages: [{ role: "user", content: "帮我优化" }],
    officialMessages: [{ role: "user", content: "analyze stock 600171 latest fundamentals" }],
  });
  assert.equal(unrelated.ok, false, "unrelated CJK vs Latin history still mismatches");
  const shortLatin = classifyResumeContinuity({
    localMessages: [{ role: "user", content: "ok go" }],
    officialMessages: [{ role: "user", content: "ok go ahead and analyze stock 600171" }],
  });
  assert.equal(shortLatin.ok, false, "Latin text keeps the 6-char floor so tiny tokens do not match by accident");
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

// --- prompts the platform sent to itself are not the user's history ----------
// 2026-09-23 field case: the engine's recent user messages were a run of
// self-checks, which exist only on its side. They pushed the real messages out
// of the comparison window, the guard read a mismatch, and a healthy session
// lost its resume for no reason.
{
  const user = (text) => ({ role: "user", content: text });
  const real = "感觉我们平台还差很多才能生产实用啊";
  const selfCheck = `<lily_internal_prompt kind="self_check"/>\ntask continuity check: the native todo list still has unfinished todo items. continuation attempt: 1/2.`;
  const recovery = `<lily_internal_prompt kind="recovery"/>\nplease deliver the missing final result`;

  const flooded = classifyResumeContinuity({
    localMessages: [user(real)],
    officialMessages: [user(real), ...Array.from({ length: 6 }, () => user(selfCheck))],
  });
  assert.equal(flooded.ok, true, "a run of self-checks must not read as a history mismatch");
  assert.equal(flooded.reason, "recent_user_overlap");

  assert.equal(
    classifyResumeContinuity({
      localMessages: [user(real)],
      officialMessages: [user(real), user(recovery), user(recovery)],
    }).ok,
    true,
    "a recovery prompt was not the user's either, even though its answer is theirs",
  );

  // Engine history made ENTIRELY of platform prompts carries no user history to
  // disagree with, so there is nothing to reset over.
  assert.equal(
    classifyResumeContinuity({ localMessages: [user(real)], officialMessages: [user(selfCheck)] }).reason,
    "official_history_empty",
    "no real user history on the engine side is not a mismatch",
  );
}

// A genuinely different conversation must STILL be caught — the whole point of
// the guard is to refuse a resume that belongs to someone else's history.
{
  const user = (text) => ({ role: "user", content: text });
  const mismatch = classifyResumeContinuity({
    localMessages: [user("帮我看看这个 PDF")],
    officialMessages: [user("write me a poem about rivers")],
  });
  assert.equal(mismatch.ok, false, "unrelated histories are still a mismatch");
  assert.equal(mismatch.reason, "recent_user_history_mismatch");
}

// And a real user message must never be dropped by the new filter, including
// one the engine wrapped in its own layers, or the guard would start inventing
// mismatches instead of preventing them.
{
  const user = (text) => ({ role: "user", content: text });
  const wrapped = `<lily_layer title="guidance">platform rules</lily_layer>\n帮我优化这段代码`;
  // A user who QUOTES an internal prompt still owns their message: the tag is
  // the test, not the prose. The REASON is asserted, not just the verdict —
  // a filter that wrongly dropped this message would empty both sides and
  // still answer "ok", which is the same answer for the opposite reason.
  const quoted = classifyResumeContinuity({
    localMessages: [user("为什么会出现 task continuity check 这种提示")],
    officialMessages: [user("为什么会出现 task continuity check 这种提示")],
  });
  assert.equal(quoted.ok, true, "quoting an internal prompt does not make a message the platform's");
  assert.equal(quoted.reason, "recent_user_overlap", "it matched because the message SURVIVED, not because both sides went empty");
  const layered = classifyResumeContinuity({
    localMessages: [user("帮我优化这段代码")],
    officialMessages: [user(wrapped)],
  });
  assert.equal(layered.reason, "recent_user_overlap", "a layered message likewise survives rather than vanishing");
}

console.log("resume continuity guard tests passed");
