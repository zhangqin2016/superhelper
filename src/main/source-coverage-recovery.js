"use strict";

/**
 * A partially-read source gets read, not apologised for.
 *
 * The platform already detects the shortfall: the evidence ledger reports
 * `sourceContentCoverage.status === "partial"` with how many sources were
 * observed out of how many exist, and the evidence gate fails the answer for
 * `partial_source_content_without_disclosure`. Five consumers read that signal
 * and every one of them only DESCRIBED it — the gate's verdict, the finalizer's
 * wording, the contract carry-over, the run state. Nothing read the rest.
 *
 * Meanwhile the platform continues a turn for every other recoverable shortfall
 * it detects: unfinished todos, a required tool that never confirmed, a claimed
 * deliverable that is not on disk, a model that went silent. An attachment the
 * model only got halfway through was the one detected, recoverable shortfall
 * with no recovery — so a user who asked about a 3 MB document was handed a
 * refusal after 23 tool steps instead of the analysis of the whole thing.
 *
 * This module decides when to go back for the rest, and what to say. It does
 * not dispatch: it rides the same route DOCUMENT_DELIVERY_UNVERIFIED already
 * uses (finalizer flag → turn-terminal-finalizer code → rescue strategy →
 * hint → one follow-up round), so there is no second retry mechanism.
 *
 * Deliberately narrow, because a retry costs the user a round:
 *   - only a content_extraction turn whose source coverage is partial;
 *   - only when sources actually remain (observed < total), from the STRUCTURED
 *     counts, never from reading the answer's prose;
 *   - only when the model produced an answer worth extending;
 *   - at most once, and never on an interrupted, stalled or failed turn.
 * Everything else falls through to the scope note the finalizer appends, which
 * remains the honest fallback. [gate: attachment-content-grounding]
 */

const MAX_ATTEMPTS = 1;

/**
 * @param {{ taskContract?: object, evidenceSummary?: object, assistant?: string,
 *   recoveryAttempt?: boolean, attempts?: number, env?: object }} input
 * @returns {{ ok: boolean, reason: string, observed?: number, total?: number }}
 */
function shouldReadRemainingSources(input = {}) {
  const env = input.env || process.env;
  if (env.LILY_SOURCE_COVERAGE_RETRY === "0") return { ok: false, reason: "disabled" };
  if (input.taskContract?.taskType !== "content_extraction") return { ok: false, reason: "not_extraction" };
  // A follow-up round is itself the recovery; it must never chain.
  if (input.recoveryAttempt) return { ok: false, reason: "already_recovery" };
  if ((Number(input.attempts) || 0) >= MAX_ATTEMPTS) return { ok: false, reason: "attempts_exhausted" };
  const coverage = input.evidenceSummary?.sourceContentCoverage || {};
  if (coverage.status !== "partial") return { ok: false, reason: "coverage_not_partial" };
  const observed = Number(coverage.observedCount) || 0;
  const total = Number(coverage.sourceCount) || 0;
  // Structured counts decide this, never the answer's wording: "read the rest"
  // only makes sense when there demonstrably IS a rest.
  if (!(total > observed)) return { ok: false, reason: "nothing_left_to_read" };
  if (!String(input.assistant || "").trim()) return { ok: false, reason: "no_answer_to_extend" };
  return { ok: true, reason: "partial_source_coverage", observed, total };
}

/**
 * The instruction for the follow-up round.
 *
 * Its own text, not a branch inside the external-fact recovery hint: that one
 * is six steps of research discipline (search authority, cite opened links,
 * build an item-level evidence map) and none of it applies to finishing a file
 * that is already on disk.
 */
function buildSourceCoverageHint({ language = "en", observed = 0, total = 0 } = {}) {
  const span = total > observed ? `${observed}/${total}` : "";
  return language === "zh"
    ? [
      `[系统纠正：附件未读完] 上一轮只解析了附件的一部分${span ? `（${span}）` : ""}，回答因此只覆盖了读到的内容。`,
      "1. 先把剩余部分读完，再作答：对同一批附件继续调用抽取/解析工具，直到覆盖完整或工具明确报告无法继续。",
      "2. 不要凭文件名、目录或已读部分推测未读内容。",
      "3. 读完后给出针对用户原问题的完整回答；若确实有读不到的部分，明确写出哪些没读到及原因，其余照常作答。",
      "4. 不要只回复过程叙述或笼统拒绝——已经读到的结论必须保留。",
    ].join("\n")
    : [
      `[system correction: attachment not fully read] The prior pass parsed only part of the attachment${span ? ` (${span})` : ""}, so the answer covered only what was read.`,
      "1. Read the rest before answering: keep calling the extraction/parsing tools on the same attachments until coverage is complete or a tool clearly reports it cannot continue.",
      "2. Do not infer unread content from the filename, the directory, or the part already read.",
      "3. Then answer the user's original question over the whole source. If some part genuinely cannot be read, say which and why, and answer from the rest.",
      "4. Do not return only process narration or a blanket refusal — conclusions already supported must be kept.",
    ].join("\n");
}

module.exports = { MAX_ATTEMPTS, buildSourceCoverageHint, shouldReadRemainingSources };
