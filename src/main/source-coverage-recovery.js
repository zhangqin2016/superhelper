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
 * The round inherits what the previous pass already read (the same
 * evidenceRecoveryContext the external-fact retry uses), so it continues rather
 * than restarts. Without that it would re-read the same sources and, if the
 * shortfall came from a hard limit, stop in exactly the same place — a round
 * spent to arrive back where it started.
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
  const truncated = coverage.truncated === true;
  // Structured facts decide this, never the answer's wording: "read the rest"
  // only makes sense when there demonstrably IS a rest. Two ways to have one:
  // files never opened (total > observed), or a file opened but cut at the
  // extractor's budget (truncated). The counts are in FILES, so a single long
  // PDF read to its first pages is 1/1 and only the second signal knows it is
  // unfinished — by count alone the round could never fire for that case.
  if (!(total > observed) && !truncated) return { ok: false, reason: "nothing_left_to_read" };
  if (!String(input.assistant || "").trim()) return { ok: false, reason: "no_answer_to_extend" };
  return { ok: true, reason: total > observed ? "partial_source_coverage" : "truncated_source", observed, total, truncated };
}

/**
 * The instruction for the follow-up round.
 *
 * Its own text, not a branch inside the external-fact recovery hint: that one
 * is six steps of research discipline (search authority, cite opened links,
 * build an item-level evidence map) and none of it applies to finishing a file
 * that is already on disk.
 */
function buildSourceCoverageHint({ language = "en", observed = 0, total = 0, truncated = false } = {}) {
  const span = total > observed ? `${observed}/${total}` : "";
  // Say WHICH shortfall it is: unopened files call for opening them; a file cut
  // at the budget calls for reading on from where the cut fell.
  const shortfallZh = span
    ? `上一轮只解析了附件的一部分（${span}${truncated ? "，且已读文件的内容被截断" : ""}）`
    : "上一轮读到的附件内容被截断，只拿到了开头部分";
  const shortfallEn = span
    ? `The prior pass parsed only part of the attachment (${span}${truncated ? ", and the parsed content was cut short" : ""})`
    : "The prior pass received only the beginning of the attachment — the extracted content was cut short";
  return language === "zh"
    ? [
      `[系统纠正：附件未读完] ${shortfallZh}，回答因此只覆盖了读到的内容。`,
      "1. 上一轮已读到的内容随本次一并给你，不要重读它们——把**剩余**部分读完再作答：对同一批附件继续调用抽取/解析工具（换页码区间、换解析方式），直到覆盖完整或工具明确报告无法继续。",
      "2. 不要凭文件名、目录或已读部分推测未读内容。",
      "3. 读完后给出针对用户原问题的完整回答；若确实有读不到的部分，明确写出哪些没读到及原因，其余照常作答。",
      "4. 不要只回复过程叙述或笼统拒绝——已经读到的结论必须保留。",
    ].join("\n")
    : [
      `[system correction: attachment not fully read] ${shortfallEn}, so the answer covered only what was read.`,
      "1. What the previous pass already read is carried over with this message — do not read it again. Read the REMAINDER before answering: keep calling the extraction/parsing tools on the same attachments (different page ranges or a different parse mode) until coverage is complete or a tool clearly reports it cannot continue.",
      "2. Do not infer unread content from the filename, the directory, or the part already read.",
      "3. Then answer the user's original question over the whole source. If some part genuinely cannot be read, say which and why, and answer from the rest.",
      "4. Do not return only process narration or a blanket refusal — conclusions already supported must be kept.",
    ].join("\n");
}

module.exports = { MAX_ATTEMPTS, buildSourceCoverageHint, shouldReadRemainingSources };
