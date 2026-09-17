#!/usr/bin/env node
/**
 * A prompt the platform sends to itself never reads as the user's, and neither
 * does the model's answer to it.
 *
 * Field case 2026-09-17: a task finished and summarised, then two more blocks
 * appeared. They were the platform's own todo-continuity check and the model's
 * answer to it. The conversation was supposed to hide that whole turn, but it
 * recognised internal prompts by matching one hard-coded English sentence — and
 * the platform had since added a second internal prompt of its own wording, so
 * it could not recognise what it had just sent.
 *
 * Prose matching cannot hold: every new internal prompt, reworded prompt and
 * translation leaks. The prompt is now tagged where it is built. The kind is
 * part of the tag because the two cases want opposite treatment — a self-check's
 * answer is scaffolding and goes, a recovery's answer is the work the user asked
 * for and stays.
 *
 * [gate: internal-prompt-provenance]
 * Run: node scripts/test-internal-prompt-provenance.mjs
 */
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  INTERNAL_PROMPT_KINDS,
  internalPromptKind,
  isMarkedInternalPrompt,
  isSelfCheckPrompt,
  markInternalPrompt,
  stripInternalPromptMarker,
} = require("../src/main/internal-prompt-marker.js");
const {
  isInjectedUserPromptText,
  isInternalOnlyUserPromptText,
  stripInternalContinuationTurns,
} = require("../src/main/opencode-conversation-source.js");
const { buildTodoContinuationPrompt } = require("../src/main/opencode-todo-completion-policy.js");

let checks = 0;
function check(name, fn) { fn(); checks += 1; console.log(`ok - ${name}`); }

check("the tag is written where the prompt is built, not guessed later", () => {
  const prompt = buildTodoContinuationPrompt({ completed: 1, total: 3, unfinished: [{ title: "写报告" }] }, 1, 3);
  assert.equal(isSelfCheckPrompt(prompt), true, "the platform must recognise what it just sent");
  assert.equal(internalPromptKind(prompt), INTERNAL_PROMPT_KINDS.SELF_CHECK);
  assert.match(stripInternalPromptMarker(prompt), /^Task continuity check:/, "the model still reads a clean prompt");
  assert.equal(markInternalPrompt(prompt), prompt, "tagging twice changes nothing");
});

check("a self-check hides its whole turn; a recovery keeps its answer", () => {
  assert.equal(isSelfCheckPrompt(markInternalPrompt("check yourself")), true);
  const recovery = markInternalPrompt("继续把刚才的工作做完", INTERNAL_PROMPT_KINDS.RECOVERY);
  assert.equal(internalPromptKind(recovery), INTERNAL_PROMPT_KINDS.RECOVERY);
  assert.equal(isSelfCheckPrompt(recovery), false, "a recovery answer is the deliverable, not scaffolding");
  assert.equal(isInternalOnlyUserPromptText(recovery), false);
  assert.equal(isMarkedInternalPrompt(recovery), true, "but the question itself is still not the user's");
  assert.equal(isInjectedUserPromptText(recovery), true);
});

check("what the user actually types is never mistaken for an internal prompt", () => {
  for (const text of ["帮我做一份季度报告", "continue", "Task continuity", "", "   "]) {
    assert.equal(isMarkedInternalPrompt(text), false, JSON.stringify(text));
    assert.equal(isSelfCheckPrompt(text), false, JSON.stringify(text));
  }
  assert.equal(isInternalOnlyUserPromptText("帮我做一份季度报告"), false);
  assert.equal(internalPromptKind('<lily_internal_prompt kind="not_a_kind"/>\nx'), INTERNAL_PROMPT_KINDS.SELF_CHECK,
    "an unknown kind falls back to the safe one rather than being trusted");
});

check("the field case: the turn and its answer both leave the conversation", () => {
  const conversation = [
    { role: "user", content: "做一套 Office 压力测试", timestamp: "2026-09-17T11:33:15.000Z", turnId: "t1" },
    { role: "assistant", content: "全部完成。下面是三样你要的东西…", timestamp: "2026-09-17T11:56:00.000Z", turnId: "t1" },
    {
      role: "user",
      content: buildTodoContinuationPrompt({ completed: 1, total: 1, unfinished: [{ title: "x" }] }, 1, 3),
      timestamp: "2026-09-17T11:56:10.000Z",
      turnId: "t1",
    },
    { role: "assistant", content: "The todo list is stale — all phases are actually done.", timestamp: "2026-09-17T11:57:05.000Z", turnId: "t1" },
  ];
  const kept = stripInternalContinuationTurns(conversation);
  assert.deepEqual(kept.map((m) => m.role), ["user", "assistant"]);
  assert.equal(kept[0].content, "做一套 Office 压力测试");
  assert.match(kept[1].content, /全部完成/);
});

check("history written before the tag existed is healed too", () => {
  // The user's own session carries no tag — it predates this. A prefix rule
  // reaches it, because the prompt embeds live counters and never matches whole.
  const legacy = [
    "Task continuity check: the native todo list still has unfinished todo items.",
    "Progress: 7/12 completed. Continue from the current unfinished item.",
  ].join("\n");
  assert.equal(isMarkedInternalPrompt(legacy), false, "it really has no tag");
  assert.equal(isInternalOnlyUserPromptText(legacy), true, "and is still recognised");
  const kept = stripInternalContinuationTurns([
    { role: "user", content: "做事", timestamp: "2026-09-17T11:00:00.000Z", turnId: "t1" },
    { role: "assistant", content: "做完了", timestamp: "2026-09-17T11:10:00.000Z", turnId: "t1" },
    { role: "user", content: legacy, timestamp: "2026-09-17T11:11:00.000Z", turnId: "t1" },
    { role: "assistant", content: "继续检查待办", timestamp: "2026-09-17T11:12:00.000Z", turnId: "t1" },
  ]);
  assert.deepEqual(kept.map((m) => m.content), ["做事", "做完了"]);
  // The opencode auto-compaction prompt keeps working exactly as before.
  assert.equal(isInternalOnlyUserPromptText(
    "Continue if you have next steps, or stop and ask for clarification if you are unsure how to proceed.",
  ), true);
});

console.log(`\n${checks} checks passed (internal prompt provenance)`);
