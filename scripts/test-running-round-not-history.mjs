#!/usr/bin/env node
/**
 * A round Lily is still running is shown by its live card, never as history.
 *
 * 2026-09-24: a long task ran 25 minutes; each time the user switched away and
 * back, the official-history refresh returned the engine's copy of the round so
 * far — a group of step messages, "completed" one by one, identified by its
 * latest step and cut to the page window — and it was appended as a finished
 * answer. Three "耗时 823s / 893s / 905s" cards of partial narration stood
 * under the real answer, gone only after restarting Lily (they lived in the
 * renderer's merged list, never on disk).
 *
 * Two owners, each deciding from what it actually knows:
 *   - the main process knows which turn is running, and leaves its engine copy
 *     out of history until the turn ends;
 *   - the renderer's merge knows a message bound to a turn IS that turn's
 *     message, whatever id it arrives under — the rule the committed-message
 *     merge already used, now shared.
 */
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
let checks = 0;
const check = (label) => { checks += 1; console.log(`ok - ${label}`); };

const { getConversationPageFromSource } = require("../src/main/opencode-conversation-source.js");
const { mergeLatestConversationPage, conversationMessageKey } = await import("../src/renderer/modules/conversation-pagination.js");

const session = { id: "s1", projectId: "p", agentResumeId: "ses_1" };
const localUser = { id: "msg_local_user", role: "user", content: "继续", turnId: "turn_run", timestamp: "2026-09-24T06:04:17.000Z" };
// What the engine's history gives for a round still running: the user message,
// and a group of step messages keyed by the latest step.
const engineRound = (stepId, text) => [
  { id: "eng_user", engineMessageId: "eng_user", role: "user", content: "继续", timestamp: "2026-09-24T06:04:21.000Z" },
  {
    id: stepId, engineMessageId: stepId, role: "assistant", content: text, timestamp: "2026-09-24T06:18:00.000Z",
    record: { assistantText: text, durationMs: 823_000, meta: { opencode: { messageId: stepId, parentMessageId: "eng_user", finish: "tool-calls" } } },
  },
];

function ctxFor({ phase, turnId, conversation, turnStartedAt = 0 }) {
  return {
    turnOrchestrator: { snapshot: () => ({ phase, turnId, turnStartedAt }) },
    sessionManager: {
      findById: () => session,
      getActive: () => session,
      getConversationPage: () => ({ conversation: [localUser] }),
      getRecentConversation: () => [localUser],
      getConversation: () => [localUser],
      getProjectedConversation: () => [],
    },
    runnerPool: { get: () => ({ isAlive: () => true, getConversationPage: async () => ({ ok: true, source: "opencode", conversation }) }) },
  };
}

// --------------------------------------------------- main: running round held back
{
  const running = await getConversationPageFromSource(ctxFor({ phase: "running", turnId: "turn_run", conversation: engineRound("step_40", "console.sh 改动连贯。做最后一次端到端回归") }), "s1", {});
  assert.equal(running.conversation.filter((m) => m.role === "assistant").length, 0, "the running round's engine copy is not history");
  assert.ok(running.conversation.some((m) => m.role === "user" && m.turnId === "turn_run"), "the question is still shown");

  const settled = await getConversationPageFromSource(ctxFor({ phase: "idle", turnId: null, conversation: engineRound("step_99", "「完整闭环」审计完成") }), "s1", {});
  const answer = settled.conversation.filter((m) => m.role === "assistant");
  assert.equal(answer.length, 1, "once the turn ends, its history is returned as before");
  assert.equal(answer[0].turnId, "turn_run", "bound to the turn it belongs to");
  check("the main process leaves a running round out of history, and returns it once settled");
}

{
  // A different, finished turn is never held back because some turn is running.
  const other = await getConversationPageFromSource(ctxFor({ phase: "running", turnId: "turn_other", conversation: engineRound("step_7", "上一轮的回答") }), "s1", {});
  assert.equal(other.conversation.filter((m) => m.role === "assistant").length, 1);
  const noOrchestrator = ctxFor({ phase: "running", turnId: "turn_run", conversation: engineRound("step_7", "x") });
  delete noOrchestrator.turnOrchestrator;
  const baseline = await getConversationPageFromSource(noOrchestrator, "s1", {});
  assert.equal(baseline.conversation.filter((m) => m.role === "assistant").length, 1, "without an orchestrator, history is returned as before");
  check("only the running turn is held back, and without turn state nothing changes");
}

{
  // The case the first version missed, replayed from the field: a history page
  // is the newest 50 engine messages, and a 156-step round pushes its own
  // question out of it. Nothing binds the steps to the turn, so a turn-id
  // filter lets them through; the round is identified by when it started.
  const turnStartedAt = Date.parse("2026-09-24T07:33:01Z");
  const step = (id, created, text) => ({
    id, engineMessageId: id, role: "assistant", content: text, timestamp: new Date(created).toISOString(),
    record: { assistantText: text, startedAt: created, durationMs: 859_000, meta: { opencode: { messageId: id, parentMessageId: "eng_user_out_of_page", finish: "tool-calls" } } },
  });
  const windowOnly = [step("step_120", turnStartedAt + 780_000, "Now the core service, DTOs, and controller.")];
  const held = await getConversationPageFromSource(ctxFor({ phase: "running", turnId: "turn_run", turnStartedAt, conversation: windowOnly }), "s1", {});
  assert.equal(held.conversation.filter((m) => m.role === "assistant" && m.source !== "lily").length, 0,
    "a running round is held back even when its question has left the page and nothing binds it");

  // Before the running round has written anything, the previous answer stays.
  const previousAnswer = [step("step_prev", turnStartedAt - 600_000, "上一轮的回答")];
  const kept = await getConversationPageFromSource(ctxFor({ phase: "running", turnId: "turn_run", turnStartedAt, conversation: previousAnswer }), "s1", {});
  assert.ok(kept.conversation.some((m) => m.role === "assistant" && m.content === "上一轮的回答"), "an answer written before the running turn began is history");
  check("the running round is identified by when it started, so a page that lost its question still holds it back");
}

{
  // The real orchestrator must publish when the running turn started — the
  // tests above hand the history source a snapshot, so without this a lost
  // field (it was overwritten once, 2026-09-24) would pass them all.
  const { TurnOrchestrator } = require("../src/main/turn-orchestrator.js");
  const orchestrator = Object.create(TurnOrchestrator.prototype);
  const state = { phase: "running", turnId: "turn_real", startedAt: 1_790_000_000_000, queue: [], outcomeUnknownTurns: [], taskRun: null };
  Object.assign(orchestrator, {
    ctx: { sessionManager: { listTaskLifecycles: () => [] } },
    eventBus: { snapshot: () => ({ recent: [] }) },
    _state: () => state,
  });
  assert.equal(orchestrator.snapshot("s1").turnStartedAt, 1_790_000_000_000, "a running turn's start is in the snapshot");
  state.phase = "idle";
  assert.equal(orchestrator.snapshot("s1").turnStartedAt, 0, "and an idle session reports none");
  check("the real orchestrator snapshot carries the running turn's start time");
}

// --------------------------------------------- renderer: one turn, one message
{
  const partial = (id, text) => ({
    id, engineMessageId: id, role: "assistant", content: text, turnId: "turn_run",
    timestamp: "2026-09-24T06:18:00.000Z", record: { assistantText: text, durationMs: 823_000 },
  });
  // Two refreshes of a growing round: different ids, different page windows.
  let merged = mergeLatestConversationPage([localUser], [partial("step_40", "console.sh 改动连贯。会话掉线了，重新登录再回归")]);
  merged = mergeLatestConversationPage(merged, [partial("step_61", "toolDescriptors 把任何能力都暴露成可调用工具，LLM 一旦调用未在网关注册的工具")]);
  merged = mergeLatestConversationPage(merged, [partial("step_70", "有工具注册 API。看工具定义结构与内置执行器")]);
  assert.equal(merged.filter((m) => m.role === "assistant").length, 1, "copies of one round under three ids are one message");

  const final = { id: "msg_final", role: "assistant", content: "「完整闭环」审计完成，全部收尾到位。", turnId: "turn_run", timestamp: "2026-09-24T06:29:26.000Z", record: { durationMs: 1_479_023 } };
  merged = mergeLatestConversationPage(merged, [final]);
  const answers = merged.filter((m) => m.role === "assistant");
  assert.equal(answers.length, 1, "and the real answer replaces it rather than standing beside it");
  assert.equal(answers[0].content, final.content);
  check("the renderer's merge treats every copy of a turn's answer as that one answer");
}

{
  assert.equal(conversationMessageKey({ role: "assistant", id: "a", turnId: "t" }), conversationMessageKey({ role: "assistant", id: "b", turnId: "t" }), "turn identity wins over the id it arrived under");
  assert.notEqual(conversationMessageKey({ role: "user", turnId: "t", steer: true, steerSeq: 1 }), conversationMessageKey({ role: "user", turnId: "t" }), "a steered question keeps its own place");
  assert.notEqual(conversationMessageKey({ role: "assistant", content: "x" }, 1), conversationMessageKey({ role: "assistant", content: "x" }, 2), "unbound messages keep their positional identity");
  const { committedMessageKey } = await import("../src/renderer/modules/committed-message-equivalence.js");
  assert.equal(conversationMessageKey({ role: "assistant", id: "a", turnId: "t" }), committedMessageKey({ role: "assistant", id: "a", turnId: "t" }), "one definition with the committed-message merge");
  check("pagination identity is the committed-message identity, not a second rule");
}

console.log(`running-round-not-history: ok (${checks} checks)`);
