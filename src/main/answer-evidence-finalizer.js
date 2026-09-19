"use strict";

const { assessFinalAnswerEvidence } = require("./evidence-gate");
const {
  answerLanguage,
  salvageSupportedExternalAnswer,
} = require("./external-evidence-recovery");
const { externalFactRiskTier, shouldAutoVerifyExternalFact } = require("./external-fact-policy");
const { isSideEffectFreeToolRun } = require("./tool-call-rescue");
const {
  assessDocumentDelivery,
  missingLabels,
  requiresDocumentDelivery,
  safeDocumentDeliveryFallback,
  withDocumentOutputEvidence,
} = require("./document-delivery-gate");

function isExternalFactContract(taskContract = null) {
  return Boolean(taskContract?.externalFactPolicy?.required);
}

function isSourceContentContract(taskContract = null) {
  if (taskContract?.taskType !== "content_extraction") return false;
  // 2026-09-15: a folder/workspace question routed here has NOTHING attached, so
  // the source-content verdict can never pass and the canned "I could not read
  // the attachment" line replaced real, tool-grounded analysis. With no source
  // there is no attachment to confabulate about — ordinary evidence rules apply.
  try { return require("./task-evidence-policy").hasExtractableContentSource(taskContract); }
  catch { return true; }
}

function shouldBufferAssistantAnswer(taskContract = null) {
  if (isSourceContentContract(taskContract) || requiresDocumentDelivery(taskContract)) return true;
  // Verify-before-stream for paths whose gated verdict should be shown once,
  // cleanly (hard tier; roster/ranking-critical verify_soft). Delivery itself
  // is fail-open — the original answer plus at most one honesty note — but
  // streaming an answer that is certain to fail verification reads as the
  // platform changing its mind; buffering shows the final state directly.
  // Other tiers keep streaming. Legacy mode (tiers disabled) keeps legacy
  // streaming.
  if (process.env.LILY_EVIDENCE_RISK_TIERS === "0") return false;
  const policy = taskContract?.externalFactPolicy;
  if (!policy?.required) return false;
  try {
    const tier = externalFactRiskTier(policy);
    if (tier === "hard") return true;
    if (tier === "verify_soft") {
      // Only the GUARANTEED-replacement combination buffers: a roster/ranking
      // ask where research is prohibited can never acquire evidence, so its
      // streamed answer would always be erased. Researchable rankings keep
      // streaming — they have a real chance to pass, and failures route
      // through the auto-verify retry.
      if (!policy.researchProhibited) return false;
      const plan = policy.verificationPlan || {};
      const reasons = (policy.reasonCodes || []).map(String);
      return Boolean(plan.entityEvidenceRequired ||
        (Array.isArray(plan.claimKinds) && plan.claimKinds.includes("ranking")) ||
        reasons.includes("ranking") || reasons.includes("superlative_comparison"));
    }
  } catch {
    /* fail-open: stream normally */
  }
  return false;
}

function safeSourceContentFallback({ evidenceSummary = null, userText = "" } = {}) {
  const language = answerLanguage(userText);
  if (evidenceSummary?.sourceContentCoverage?.status === "partial") {
    return {
      zh: "我只成功读取了部分图片或文档内容，当前证据不足以支持一个看似完整的结论。我不会补猜未读到的文字、页面或细节；需要继续解析剩余内容，或基于已明确读到的部分作答并标注范围。",
      ar: "تمكنت من قراءة جزء فقط من الصورة أو المستند، ولا يكفي الدليل الحالي لاستنتاج كامل. لن أخمن النص أو الصفحات أو التفاصيل غير المقروءة؛ يجب متابعة القراءة أو تقييد الإجابة بالجزء المقروء بوضوح.",
      en: "I could read only part of the image or document, which is not enough for a complete-looking conclusion. I will not guess unseen text, pages, or details; the remaining content must be read, or the answer must be limited to the clearly observed portion.",
    }[language];
  }
  return {
    zh: "我还没有成功读取这份图片或文档的实际内容，因此不能可靠回答其中写了什么、出现了什么或包含哪些数据。我不会根据文件名或上下文猜测；需要先重新识别或解析附件。",
    ar: "لم أتمكن بعد من قراءة المحتوى الفعلي للصورة أو المستند، لذلك لا أستطيع الإجابة بشكل موثوق عما يحتويه. لن أخمن من اسم الملف أو السياق، ويجب إعادة قراءة المرفق أولا.",
    en: "I could not read the actual image or document content, so I cannot reliably say what it contains. I will not guess from the filename or surrounding context; the attachment needs to be read again first.",
  }[language];
}

function toolEvidenceText(tools = []) {
  const chunks = [];
  for (const tool of tools) {
    const result = tool?.result;
    if (typeof result === "string") chunks.push(result);
    else if (result && typeof result.output === "string") chunks.push(result.output);
    else if (Array.isArray(result?.content)) {
      chunks.push(result.content.map((item) => (item && typeof item.text === "string" ? item.text : "")).join(" "));
    } else if (typeof tool?.content === "string") chunks.push(tool.content);
    else if (typeof tool?.output === "string") chunks.push(tool.output);
    else {
      try { chunks.push(JSON.stringify(result ?? tool?.content ?? tool?.output ?? "")); } catch { /* ignore */ }
    }
  }
  return chunks.filter(Boolean).join("\n").slice(0, 40_000);
}

function hasImageInput(files = []) {
  return files.some(
    (file) => file && (file.isImage === true || /^image\//i.test(String(file.mime || file.type || file.mimeType || ""))),
  );
}

// Model-first delivery (2026-07-20 user direction): the gate never decorates or
// erases a good-faith answer. The ONLY user-visible addition at a failed final
// state is one plain-language line — no internal identifiers, no boilerplate.
// Everything else the gate knows lives in assessment meta for the learning loop.
function unverifiedHonestyNote(userText = "") {
  const language = answerLanguage(userText);
  return {
    zh: "\n\n备注：以上回答未能通过本轮逐项核实，请以原始来源为准。",
    ar: "\n\nملاحظة: لم تُجتز هذه الإجابة التحقق البندي في هذه الجولة؛ يرجى الرجوع إلى المصادر الأصلية.",
    en: "\n\nNote: this answer did not pass this turn's item-level verification; defer to original sources.",
  }[language];
}

/**
 * The scope sentence a partially-read source needs — appended, never substituted.
 *
 * A partial read means bytes WERE read, so the model's analysis of what it saw
 * is real work. The gate that flags it says so itself: it reports
 * `hasEvidence: true` and fails only when the answer does not disclose the
 * partial scope. What was missing is therefore one sentence, not the answer.
 *
 * The exception is an answer that claims to have covered the WHOLE source while
 * only part was read: "完整展示了…全部价格" is a false statement about the pages
 * nobody saw, and appending a scope note would leave the contradiction standing.
 * That one is still replaced. So the decision is three-way, not two: nothing
 * read, overclaimed, or honestly partial.
 *
 * Erasing it was the observed behaviour on a 3 MB .docx: 23 tool steps and 18
 * reasoning segments ran, and the user was handed a refusal instead of the
 * analysis of the pages that had been read. Wording matches
 * PARTIAL_SOURCE_DISCLOSURE_RE in evidence-gate.js on purpose — a disclosure
 * that the gate would not recognise is not a disclosure.
 */
// A totality word NEGATED is the opposite of an overclaim — "未能完整解析",
// "没有完整列出", "could not read the whole file" are answers being honest about
// the very shortfall this branch exists to catch. Matching the word alone erased
// them, which is worse than the confabulation it was written to stop.
const NEGATED_WHOLE_CLAIM_RE =
  /(?:没有?|未能?|不曾|无法|尚未|cannot|could not|couldn't|did not|didn't|not)\s*[^。.!?；;]{0,8}(?:完整|全部|所有|整份|entire|whole|complete|all)/i;

// The answer asserting it covered the whole source. Narrow on purpose: it only
// has to catch a totality claim, because anything short of one is compatible
// with a partial read once the scope note is appended.
const WHOLE_SOURCE_CLAIM_RE =
  /(完整(?:展示|列出|包含|覆盖|呈现|解析|读取)|全部(?:内容|页面|条目|价格|数据|字段|章节)|所有(?:页面|条目|内容|字段|章节)|整份(?:文档|文件|报告)|\b(?:the )?(?:entire|whole|complete) (?:document|file|image|attachment|report)\b|\ball (?:pages|items|entries|prices|fields|sections)\b)/i;

/** The gate's own definition of "this answer states its scope", reused rather than re-invented. */
function disclosesPartialScope(text = "") {
  try { return require("./evidence-gate").disclosesPartialSourceScope(String(text || "")); }
  catch { return false; }
}

function partialSourceScopeNote(evidenceSummary = null, userText = "") {
  const language = answerLanguage(userText);
  const coverage = evidenceSummary?.sourceContentCoverage || {};
  const seen = Number(coverage.observedCount) || 0;
  const total = Number(coverage.sourceCount) || 0;
  // The counts are in files: a span is only meaningful when files went unopened.
  // A single file cut at the extractor's budget is 1/1 — printing that would
  // claim it was fully read while explaining that it was not.
  const span = seen && total > seen ? `${seen}/${total}` : "";
  const truncated = coverage.truncated === true;
  const scopeZh = span ? `附件的部分内容（${span}）` : truncated ? "附件的开头部分（内容被截断）" : "附件的部分内容";
  const scopeEn = span ? `part of the attachment (${span})` : truncated ? "the beginning of the attachment (the content was cut short)" : "part of the attachment";
  const scopeAr = span ? `جزء فقط من المرفق (${span})` : truncated ? "بداية المرفق فقط (تم اقتطاع المحتوى)" : "جزء فقط من المرفق";
  return {
    zh: `\n\n备注：本次只解析了${scopeZh}，以上结论仅覆盖已读到的部分，未读部分未作推测。`,
    ar: `\n\nملاحظة: تمت قراءة ${scopeAr}؛ ما سبق يغطي الجزء المقروء فقط ولم يُخمَّن الباقي (partial read).`,
    en: `\n\nNote: only ${scopeEn} was read; the above covers only the observed portion and nothing beyond it was guessed.`,
  }[language];
}

function documentDeliveryNote(delivery, userText = "") {
  const language = answerLanguage(userText);
  const labels = missingLabels(delivery?.missing || [], language);
  return {
    zh: `\n\n备注：文件已生成，但自动检查未全部完成（${labels}），可直接打开使用。`,
    ar: `\n\nملاحظة: تم إنشاء الملف، لكن الفحوصات التلقائية لم تكتمل (${labels})؛ يمكن فتحه مباشرة.`,
    en: `\n\nNote: the file was created, but automatic checks are incomplete (${labels}); it can be opened directly.`,
  }[language];
}

function evaluateAnswerEvidence({
  assistant = "",
  taskContract = null,
  turnPolicy = null,
  evidenceSummary = null,
  tools = [],
  fileChangeCount = 0,
  inputFiles = [],
  userText = "",
  artifacts = [],
  recoveryAttempt = false,
  acceptedClaimLabels = [],
  acceptedAuthorityUrls = [],
  judgedUnsupportedClaims = [],
  judgedConflictingClaims = [],
  semanticVerdict = null,
} = {}) {
  const original = String(assistant || "").trim();
  const externalFact = isExternalFactContract(taskContract);
  const sourceContent = isSourceContentContract(taskContract);
  const documentDeliveryRequired = requiresDocumentDelivery(taskContract);
  try {
    const evidenceText = toolEvidenceText(tools);
    const documentDelivery = assessDocumentDelivery({
      taskContract,
      artifacts,
      tools,
      userText,
    });
    const effectiveEvidenceSummary = withDocumentOutputEvidence(evidenceSummary, artifacts, documentDelivery);
    const assessment = assessFinalAnswerEvidence({
      assistant: original,
      evidencePolicy: taskContract?.evidencePolicy,
      turnPolicy,
      evidenceSummary: effectiveEvidenceSummary,
      toolCount: tools.length,
      fileChangeCount,
      evidenceText,
      userText,
      skipNumericGrounding: hasImageInput(inputFiles),
      acceptedClaimLabels,
      acceptedAuthorityUrls,
      judgedUnsupportedClaims,
      judgedConflictingClaims,
    });
    if (documentDelivery.required && !documentDelivery.ok) {
      // Structural failures (file missing/broken) are literal facts — keep the
      // explanatory fallback. Incomplete quality CHECKS (render/visual/recalc)
      // never erase the deliverable: original answer + one plain note; at most
      // one silent verification retry runs and may supersede it.
      const structural = (documentDelivery.missing || []).some((m) => m === "structure" || m === "output_file");
      return {
        assistant: structural
          ? safeDocumentDeliveryFallback({ assessment: documentDelivery, userText })
          : `${original}${documentDeliveryNote(documentDelivery, userText)}`,
        assessment: {
          ok: false,
          required: true,
          strongClaim: true,
          hasEvidence: documentDelivery.artifacts.length > 0,
          reason: documentDelivery.reason,
          documentDelivery,
          ...(structural ? {} : { deliveredUnverifiedWithNote: true }),
        },
        documentDelivery,
        evidenceSummary: effectiveEvidenceSummary,
        triggerVerifyRetry: false,
        triggerDocumentVerifyRetry: Boolean(documentDelivery.retryRecommended),
        evidenceText,
      };
    }
    if (assessment.ok) {
      // Record the tier on the success path too — the learning loop (incident →
      // eval case) needs pass/fail decisions per tier, not only failures.
      const okAssessment = externalFact
        ? { ...assessment, riskTier: externalFactRiskTier(taskContract?.externalFactPolicy) }
        : assessment;
      // The turn judge's informal-label ruling is recorded for the learning loop
      // but never decorates the delivered answer (2026-07-20 model-first).
      const finalOkAssessment = semanticVerdict?.informalLabel === true
        ? { ...okAssessment, informalLabelFramed: true }
        : okAssessment;
      return {
        assistant: original,
        assessment: documentDelivery.required ? { ...finalOkAssessment, documentDelivery } : finalOkAssessment,
        documentDelivery,
        evidenceSummary: effectiveEvidenceSummary,
        triggerVerifyRetry: false,
        triggerDocumentVerifyRetry: false,
        evidenceText,
      };
    }

    // Salvage on ANY pass and ANY tier — it is inherently safe (the projected
    // subset must re-pass the full gate before it is delivered). Previously this
    // ran only on the recovery pass, so a hard-tier first pass with real
    // research (evidence in the ledger, only SOME items unsupported) threw away
    // every supported finding and delivered a zero-content fallback — dumber
    // than answering. The verified subset is delivered immediately; if a verify
    // retry is still available it runs anyway and may supersede the subset with
    // a more complete verified answer.
    if (externalFact) {
      const salvaged = salvageSupportedExternalAnswer({
        assistant: original,
        assessment,
        userText,
        reassess: (candidate) => assessFinalAnswerEvidence({
          assistant: candidate,
          evidencePolicy: taskContract?.evidencePolicy,
          turnPolicy,
          evidenceSummary: effectiveEvidenceSummary,
          toolCount: tools.length,
          fileChangeCount,
          evidenceText,
          userText,
          skipNumericGrounding: hasImageInput(inputFiles),
      acceptedClaimLabels,
      acceptedAuthorityUrls,
      judgedUnsupportedClaims,
      judgedConflictingClaims,
        }),
      });
      if (salvaged) {
        const salvageRetry = !recoveryAttempt && shouldAutoVerifyExternalFact({
          policy: taskContract?.externalFactPolicy || null,
          assessment,
          evidenceSummary,
          sideEffectFree: isSideEffectFreeToolRun(tools),
          enabled:
            process.env.LILY_EXTERNAL_FACT_VERIFY_RETRY !== "0" &&
            process.env.LILY_EVIDENCE_VERIFY_RETRY !== "0",
        });
        return {
          assistant: salvaged.assistant,
          assessment: salvaged.assessment,
          documentDelivery,
          evidenceSummary: effectiveEvidenceSummary,
          triggerVerifyRetry: salvageRetry,
          triggerDocumentVerifyRetry: false,
          evidenceText,
        };
      }
    }

    const policy = taskContract?.externalFactPolicy || null;
    const riskTier = externalFact ? externalFactRiskTier(policy) : "advisory";
    const sideEffectFree = isSideEffectFreeToolRun(tools);
    const externalFactRetry = riskTier !== "advisory" && shouldAutoVerifyExternalFact({
      policy,
      assessment,
      evidenceSummary,
      sideEffectFree,
      enabled:
        process.env.LILY_EXTERNAL_FACT_VERIFY_RETRY !== "0" &&
        process.env.LILY_EVIDENCE_VERIFY_RETRY !== "0",
    });
    const legacyOptInRetry = !externalFact && Boolean(assessment.strongClaim) && sideEffectFree &&
      process.env.LILY_EVIDENCE_VERIFY_RETRY === "1";
    // Model-first failure delivery (2026-07-20 user direction): the gate never
    // decorates and never erases a good-faith answer. At most one silent
    // auto-verify retry may supersede it; at the final state the original
    // answer stands with a single plain-language note. The only replacement
    // left is source-content confabulation (no attachment bytes were read, so
    // any content claim is fabricated by construction — a literal fact).
    let finalAssistant = original;
    let finalAssessment = assessment;
    let sourceCoverageRetry = { ok: false, reason: "not_evaluated" };
    if (sourceContent) {
      // Two different situations shared one outcome. "Nothing was read" justifies
      // replacement — any content claim is fabricated by construction. "Part was
      // read" does not: the analysis of what WAS read is real work, and the gate
      // itself reports hasEvidence: true, failing only on the missing scope
      // sentence. Supply the sentence; never erase the work.
      const partial = evidenceSummary?.sourceContentCoverage?.status === "partial";
      // An answer that already discloses partial scope cannot be claiming the
      // whole source, whatever words it used — that relation is structural, so
      // the gate's own disclosure test settles it rather than more prose rules.
      const overclaimsWholeSource = WHOLE_SOURCE_CLAIM_RE.test(original)
        && !NEGATED_WHOLE_CLAIM_RE.test(original)
        && !disclosesPartialScope(original);
      // Before deciding how to word a shortfall, ask whether it can simply be
      // removed: sources that were never opened can be opened. The scope note
      // below stays as the honest fallback for when they cannot.
      sourceCoverageRetry = require("./source-coverage-recovery").shouldReadRemainingSources({
        taskContract, evidenceSummary, assistant: original, recoveryAttempt,
      });
      finalAssistant = partial && original && !overclaimsWholeSource
        ? `${original}${partialSourceScopeNote(evidenceSummary, userText)}`
        : safeSourceContentFallback({ evidenceSummary, userText });
    } else if (externalFact && riskTier !== "advisory" && !(externalFactRetry && !recoveryAttempt)) {
      finalAssistant = `${original}${unverifiedHonestyNote(userText)}`;
      finalAssessment = { ...assessment, deliveredUnverifiedWithNote: true };
    }
    if (externalFact && finalAssessment && typeof finalAssessment === "object") {
      finalAssessment = { ...finalAssessment, riskTier };
    }
    return {
      assistant: finalAssistant,
      assessment: finalAssessment,
      documentDelivery,
      evidenceSummary: effectiveEvidenceSummary,
      triggerVerifyRetry: externalFactRetry || legacyOptInRetry,
      triggerDocumentVerifyRetry: false,
      triggerSourceCoverageRetry: sourceCoverageRetry.ok === true,
      sourceCoverage: sourceCoverageRetry.ok
        ? { observed: sourceCoverageRetry.observed, total: sourceCoverageRetry.total, truncated: sourceCoverageRetry.truncated === true }
        : null,
      evidenceText,
    };
  } catch (error) {
    if (!externalFact && !sourceContent && !documentDeliveryRequired) {
      return {
        assistant: original,
        assessment: null,
        evidenceSummary,
        triggerVerifyRetry: false,
        triggerDocumentVerifyRetry: false,
        error,
      };
    }
    if (documentDeliveryRequired) {
      return {
        assistant: original,
        assessment: {
          ok: false,
          required: true,
          strongClaim: false,
          hasEvidence: false,
          reason: "document_delivery_gate_internal_error",
        },
        evidenceSummary,
        triggerVerifyRetry: false,
        triggerDocumentVerifyRetry: false,
        error,
      };
    }
    // Internal gate error: fail OPEN with the original answer for every tier —
    // a broken gate must never make the platform dumber than baseline, and a
    // gate error is never proof the answer is wrong (2026-07-20: hard included).
    return {
      assistant: original,
      assessment: {
        ok: false,
        required: true,
        strongClaim: false,
        hasEvidence: false,
        reason: "evidence_gate_internal_error",
        failedOpen: true,
      },
      evidenceSummary,
      triggerVerifyRetry: false,
      triggerDocumentVerifyRetry: false,
      error,
    };
  }
}

/**
 * evaluateAnswerEvidence + the unified semantic judge: deterministic gate first
 * (fast path + literal floor), then ONE judgeTurnSemantics call rules on the
 * semantic failures (entailment, authority, conflicts, informal label, stakes)
 * and the full gate re-runs with the verdict as whitelists/rulings. Floors:
 * windowless claims are never judged; judge-ruled conflicts are final; judge
 * unavailable → the deterministic delivery applies. Kill: LILY_EVIDENCE_LLM_JUDGE=0.
 */
async function evaluateAnswerEvidenceWithJudge(params = {}, { judge } = {}) {
  let params_ = params;
  let result = evaluateAnswerEvidence(params_);
  try {
    if (process.env.LILY_EVIDENCE_LLM_JUDGE === "0") return result;
    let assessment = result.assessment;
    let citationRepairMeta = null;
    // Round 1: citation repair (deterministic) — a citation-DISCIPLINE failure
    // must not destroy real research. Final-state only: while an auto-verify
    // retry is available it runs first.
    if (
      assessment && assessment.ok === false &&
      ["external_fact_without_source_link", "source_link_not_in_evidence"].includes(String(assessment.reason || "")) &&
      process.env.LILY_EVIDENCE_CITATION_REPAIR !== "0" &&
      (params_.recoveryAttempt === true || !result.triggerVerifyRetry)
    ) {
      const { repairAnswerCitations } = require("./external-evidence-recovery");
      const repair = repairAnswerCitations({
        assistant: String(params_.assistant || ""),
        evidenceText: result.evidenceText || "",
        evidenceSummary: params_.evidenceSummary,
        assessment,
        userText: String(params_.userText || ""),
      });
      if (repair) {
        params_ = { ...params_, assistant: repair.assistant };
        citationRepairMeta = {
          citationRepaired: true,
          citationStrippedUrls: (repair.strippedUrls || []).slice(0, 5),
          citationAppendedSources: (repair.appendedSources || []).slice(0, 5),
        };
        result = evaluateAnswerEvidence(params_);
        if (result.assessment && typeof result.assessment === "object") {
          result.assessment = { ...result.assessment, ...citationRepairMeta };
        }
        assessment = result.assessment;
      }
    }
    if (!assessment || assessment.ok !== false) return result;

    // Round 2: unified semantic judge — one call for everything semantic.
    const plan = params_.taskContract?.externalFactPolicy?.verificationPlan || {};
    const needAuthority = Boolean(assessment.authorityPending) && !assessment.authorityPinned;
    const { assessEntityClaimEvidence, evidenceWindows } = require("./entity-claim-evidence");
    const coverage = assessment.entityCoverage ||
      assessEntityClaimEvidence({
        assistant: String(params_.assistant || ""),
        evidenceText: result.evidenceText || "",
        verificationPlan: plan,
      });
    const pendingLabels = [...new Set([
      ...(Array.isArray(assessment.pendingClaims) ? assessment.pendingClaims : []),
      ...(Array.isArray(coverage?.pendingClaims) ? coverage.pendingClaims : []),
    ])];
    const answerLines = String(params_.assistant || "").split(/\r?\n/);
    const claimParams = [];
    for (const label of pendingLabels) {
      const windows = evidenceWindows(result.evidenceText || "", label, 320)
        .slice(0, 2)
        .map((win) => win.slice(0, 450));
      if (!windows.length) continue; // fabrication floor: no window, never judged
      claimParams.push({
        label,
        windows,
        sentence: (answerLines.find((line) => line.includes(label)) || "").slice(0, 300),
      });
    }
    let urls = [];
    if (needAuthority) {
      const { extractHttpUrls } = require("./external-source-authority");
      const grounded = new Set(extractHttpUrls(result.evidenceText || ""));
      urls = extractHttpUrls(String(params_.assistant || "")).filter((url) => grounded.has(url));
    }
    if (!claimParams.length && !urls.length) return result;
    const judgeFn = judge || require("./evidence-entailment-judge").judgeTurnSemantics;
    const judgeDiag = {};
    const verdict = await judgeFn({ claims: claimParams, urls, userText: String(params_.userText || ""), diagnostics: judgeDiag });
    // Judge unavailable/failed: the deterministic delivery encodes the fail boundary
    // (bounded fail-open ordinary, zero-content high-stakes). Record WHY in the gate
    // meta so field diagnosis reads messages.db (2026-07-20 silently-dead-judge lesson).
    if (!verdict) {
      const reason = String(judgeDiag.reason || "").slice(0, 120);
      if (reason && result.assessment && typeof result.assessment === "object") {
        result.assessment = { ...result.assessment, judgeUnavailable: reason };
      }
      return result;
    }
    const rerun = evaluateAnswerEvidence({
      ...params_,
      acceptedClaimLabels: verdict.supportedClaims,
      acceptedAuthorityUrls: verdict.authoritativeUrls,
      judgedUnsupportedClaims: verdict.unsupportedClaims,
      judgedConflictingClaims: verdict.conflictingClaims,
      semanticVerdict: verdict,
    });
    if (rerun.assessment && typeof rerun.assessment === "object") {
      rerun.assessment = {
        ...rerun.assessment,
        ...(citationRepairMeta || {}),
        semanticJudged: true,
        judgeAcceptedClaims: verdict.supportedClaims.slice(0, 10),
        ...(verdict.authoritativeUrls.length
          ? { judgeAcceptedAuthorityUrls: verdict.authoritativeUrls.slice(0, 10) }
          : {}),
      };
    }
    return rerun;
  } catch {
    return result;
  }
}

module.exports = {
  evaluateAnswerEvidence,
  evaluateAnswerEvidenceWithJudge,
  isExternalFactContract,
  shouldBufferAssistantAnswer,
  toolEvidenceText,
};
