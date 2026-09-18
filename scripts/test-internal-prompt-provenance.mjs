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
import fs from "node:fs";
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

// The rule that keeps provenance from rotting: every prompt the PLATFORM
// composes goes through the session's one stamped seam. Text the USER typed —
// the pending payload, a steer, the retries that re-deliver the same request
// after an engine rebuild — is carried verbatim and must NEVER be stamped, or
// the user's own message would be hidden from their conversation.
//
// This is enforced structurally rather than by review, because the field defect
// was exactly a review miss: of three places the platform nudged itself, two
// sent bare text and their questions surfaced as if the user had asked them.
{
  const files = [
    "../src/main/opencode-agent-session.js",
    "../src/main/platform-prompt.js",
    "../src/main/required-tool-completion-gate.js",
    "../src/main/opencode-todo-completion-policy.js",
  ];
  const USER_TEXT_PAYLOADS = /sendPrompt\((?:this\._pendingPromptPayload|retryPayload)\)/;
  for (const file of files) {
    const src = fs.readFileSync(new URL(file, import.meta.url), "utf8");
    const lines = src.split("\n");
    for (const [index, line] of lines.entries()) {
      if (!/\.sendPrompt\(/.test(line)) continue;
      const inSeam = /text: markInternalPrompt\(/.test(lines.slice(index, index + 6).join("\n"));
      const userText = USER_TEXT_PAYLOADS.test(line) || /^\s*await server\.sendPrompt\(\{$/.test(line);
      assert.ok(
        inSeam || userText,
        `${file}:${index + 1} sends a prompt outside the stamped seam: ${line.trim()}\n` +
        "Platform-composed text must go through session.sendPlatformPrompt({ text, kind }).",
      );
    }
  }
  const seam = fs.readFileSync(new URL("../src/main/platform-prompt.js", import.meta.url), "utf8");
  assert.match(seam, /kind = INTERNAL_PROMPT_KINDS\.RECOVERY/,
    "the seam defaults to recovery: a platform prompt hides its question but keeps the model's answer, which is the user's work");
  assert.match(seam, /text: markInternalPrompt\(text, kind\)/, "and it is the place the stamp goes on");
  const session = fs.readFileSync(new URL("../src/main/opencode-agent-session.js", import.meta.url), "utf8");
  assert.match(session, /nudgePlatformPrompt\(this, \{ text: note, reason: "completion gate follow-up"/,
    "the incomplete-deliverable nudge uses the seam");
  assert.match(session, /kind: INTERNAL_PROMPT_KINDS\.SELF_CHECK, reason: "unfinished todo continuation"/,
    "the todo continuation keeps the self_check kind it shipped with");
  const gate = fs.readFileSync(new URL("../src/main/required-tool-completion-gate.js", import.meta.url), "utf8");
  assert.match(gate, /session\.sendPlatformPrompt\(\{ text: message \}\)/, "the required-tool nudge uses the seam");
  checks += 1;
  console.log("ok - every platform-composed prompt goes through the one stamped seam");
}

console.log(`\n${checks} checks passed (internal prompt provenance)`);
