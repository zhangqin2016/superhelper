"use strict";

/**
 * The model said what it would do next, and then the turn ended.
 *
 * Three gates already push a cleanly ended turn back into the model: a required
 * tool that never persisted, todos still open, a deliverable claimed but not
 * written. All three read the platform's own record of the work. None reads the
 * strongest statement of intent there is — the model's own closing sentence.
 *
 * Field case 2026-09-21: a turn found a real defect (a persistence test passing
 * while its subscriber logged a swallowed failure), wrote "这才是要闭环的东西。
 * 先追根因。" and stopped. Every existing check was satisfied: the build was
 * green, all ten todos were complete, no deliverable was claimed. The model had
 * not given up — nothing asked it to go on.
 *
 * The danger is the opposite mistake. Measured over 399 real assistant turns
 * from a working profile, 24.6% end by addressing the user — a question, an
 * offer, handing control back ("要不要我下一步专门处理", "你可以直接继续提问,
 * 我会接着把剩下的部分做完"). Re-entering any of those would talk over the
 * user and cost a model round for nothing. Only 0.5% (2 turns) were a genuine
 * self-directed announcement. So the rule is built to REFUSE first:
 *
 *   1. anything addressed to the user is never an announcement, whatever verbs
 *      it contains — this exclusion alone rejected 7 of the 9 wide matches;
 *   2. what remains must be first person (or a bare self-imperative) in the
 *      immediate tense, in the last sentence or two;
 *   3. and the caller additionally requires that the turn actually did work
 *      (tools ran), so an explanatory answer that ends "我来解释一下" is out.
 *
 * Firing on ~0.5% of turns is the point: this is a rescue, not a habit.
 */

/**
 * Three shapes that look like an announcement and are not, each found in the
 * same 399-turn corpus:
 *   negated   — "我验证不了其内容本身" is the opposite of a promise;
 *   completed — "这次就是我漏了这一步，已经在 5173 上补上了" already happened;
 *   structural— a line carrying markdown emphasis, a table pipe or a list
 *               number is part of a plan being reported, not a closing line;
 *               a sentence that ENDS in a bare "3." is the splitter having
 *               swallowed the next item's number.
 */
const NEGATED = /不了|不到|不能|无法|未能|没有|不再|别/;
const COMPLETED = /已经|已在|完成了|补上了|做完了|搞定|(?:做|改|修|补|跑|查|追|读|看|写|验证|处理|实现|分析|定位|排查|漏)了/;
const STRUCTURAL = /\*\*|\||^\s*[-*\d]+[.、)]\s|\d+\.\s*$/;

/** Addressed to the user: a question, an offer, or handing control back. */
const ADDRESSED_TO_USER = /[你您]|要不要|需要我|可以直接|请(告诉|说|确认)|吗[？?]|[？?]\s*$|\b(you|your|let me know)\b/i;

/** First person in the immediate tense, or a bare self-imperative. */
const SELF_ANNOUNCEMENT = new RegExp(
  "(?:我(?:先|这就|来|继续|接着|将|会|去)?\\s*(?:追|查|定位|排查|分析|读|看|修|改|实现|补|写|跑|验证|处理|继续|做))"
  + "|(?:^|[。；;]\\s*)(?:先|接下来|下一步)(?:[^，。；;]{0,24})(?:[。.]|$)"
  + "|\\b(?:I(?:'ll| will)|Let me|I am going to)\\b",
  "i",
);

/** Sentences, with fenced code removed so a snippet cannot look like prose. */
function closingSentences(text, count = 2) {
  const clean = String(text || "").replace(/```[\s\S]*?```/g, " ").replace(/\s+/g, " ").trim();
  if (!clean) return [];
  return clean.split(/(?<=[。！？.!?])\s*/).filter((s) => s.trim()).slice(-count);
}

/**
 * Did this turn end on an announcement of work it did not then do?
 *
 * @param {string} text the assistant's final text for the turn
 * @returns {{ announced: true, fragment: string } | null}
 */
function detectAnnouncedContinuation(text) {
  const sentences = closingSentences(text);
  if (!sentences.length) return null;
  // Read from the end: the last sentence carries the intent, the one before it
  // is allowed to as well (a two-sentence sign-off is common).
  for (let i = sentences.length - 1; i >= 0; i -= 1) {
    const sentence = sentences[i].trim();
    // A closing announcement is short. The long ones in the corpus were all
    // plan reports or caveats that merely contained the same verbs.
    if (!sentence || sentence.length > 60) continue;
    if (ADDRESSED_TO_USER.test(sentence)) return null; // a question or offer ends the matter
    if (NEGATED.test(sentence) || COMPLETED.test(sentence) || STRUCTURAL.test(sentence)) continue;
    if (SELF_ANNOUNCEMENT.test(sentence)) return { announced: true, fragment: sentence };
  }
  return null;
}

/**
 * The nudge. It quotes the model's own words rather than inventing a task, and
 * it explicitly allows "there is nothing more to do" so a false positive costs
 * one short round instead of manufacturing work.
 */
function buildAnnouncedContinuationPrompt(fragment) {
  return [
    `你在本轮结束时写道：「${fragment}」——但这一步还没有做。`,
    "现在就把它做完，然后给出结论。",
    "如果这件事其实不需要做（例如已在本轮完成、或需要用户先决定），直接说明原因并结束，不要重复上面的话。",
  ].join(" ");
}


/**
 * The gate itself: does this cleanly ended turn deserve one more round?
 *
 * Lives here rather than in the session so the whole decision — preconditions,
 * the text rule, the shared budget — reads in one place, and so the session
 * file keeps one subject.
 *
 * @param {object} session the agent session (its gate state and runtime)
 * @param {object} payload the completion payload the turn is about to settle on
 * @param {{ claimContinuation: Function, nudgePlatformPrompt: Function, kind: string, log: object }} deps
 * @returns {boolean} true when the turn was re-entered and must not settle
 */
function continueAnnouncedWork(session, payload, deps = {}) {
  if (
    payload?.interrupted ||
    payload?.stalled ||
    payload?.code !== 0 ||
    !session?._server ||
    session._pendingPermissions?.size ||
    session._pendingQuestions?.size ||
    session._turnGates?.announcedGated ||
    process.env.LILY_ANNOUNCED_CONTINUATION_GATE === "0"
  ) {
    return false;
  }
  // Only a turn that actually did work can have left work announced; an
  // explanatory answer ending "我来解释一下" is not an abandoned step.
  if (!didWork(session)) return false;
  const announced = detectAnnouncedContinuation(payload.output || session.collectedOutput || "");
  if (!announced) return false;
  if (!deps.claimContinuation?.(session._turnGates, "announced")) return false;
  session._turnGates.announcedGated = true;
  session._armResponseTimer?.();
  session._armProgressNoticeTimer?.();
  deps.log?.warn?.("announced continuation gate re-entering", {
    sessionId: session.sessionId,
    fragment: announced.fragment.slice(0, 60),
  });
  deps.nudgePlatformPrompt?.(session, {
    text: buildAnnouncedContinuationPrompt(announced.fragment),
    kind: deps.kind,
    reason: "announced continuation",
    settlePayload: payload,
    log: deps.log,
  });
  return true;
}

/** Did the turn run tools, or record execution progress? */
function didWork(session) {
  if (session?._turnGates?.todo?.executed) return true;
  const calls = session?._toolCalls;
  return Boolean(calls?.size || calls?.length);
}

module.exports = { buildAnnouncedContinuationPrompt, closingSentences, continueAnnouncedWork, detectAnnouncedContinuation };
