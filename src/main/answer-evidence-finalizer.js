"use strict";

const { assessFinalAnswerEvidence, appendEvidenceGateNotice } = require("./evidence-gate");
const {
  answerLanguage,
  composeBoundedExternalAnswer,
  composeFramedBoundedAnswer,
  prependFramingNote,
  safeExternalFactFallback,
  salvageSupportedExternalAnswer,
} = require("./external-evidence-recovery");
const { externalFactRiskTier, isHighStakesPolicy, shouldAutoVerifyExternalFact } = require("./external-fact-policy");
const { isSideEffectFreeToolRun } = require("./tool-call-rescue");
const {
  assessDocumentDelivery,
  requiresDocumentDelivery,
  safeDocumentDeliveryFallback,
  withDocumentOutputEvidence,
} = require("./document-delivery-gate");

function isExternalFactContract(taskContract = null) {
  return Boolean(taskContract?.externalFactPolicy?.required);
}

function isSourceContentContract(taskContract = null) {
  return taskContract?.taskType === "content_extraction";
}

function shouldBufferAssistantAnswer(taskContract = null) {
  if (isSourceContentContract(taskContract) || requiresDocumentDelivery(taskContract)) return true;
  // Verify-before-stream for the only paths that may still REPLACE the final
  // answer wholesale (hard tier; roster/ranking-critical verify_soft). Streaming
  // an answer and then swapping it for a fallback reads as the platform erasing
  // its own work; buffering shows the gated result once, cleanly. Other tiers
  // never erase content, so they keep streaming. Legacy mode (tiers disabled)
  // keeps legacy streaming.
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
      return {
        assistant: safeDocumentDeliveryFallback({ assessment: documentDelivery, userText }),
        assessment: {
          ok: false,
          required: true,
          strongClaim: true,
          hasEvidence: documentDelivery.artifacts.length > 0,
          reason: documentDelivery.reason,
          documentDelivery,
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
      // The claims passed, but the turn judge ruled the LABEL itself is an
      // informal convention — deliver with the framing note up front.
      const framed = semanticVerdict?.informalLabel === true;
      const delivered = framed ? prependFramingNote(original, semanticVerdict, userText) : original;
      const finalOkAssessment = framed ? { ...okAssessment, informalLabelFramed: true } : okAssessment;
      return {
        assistant: delivered,
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
    // Delivery-time entity floor: whichever stage failed (the authority stage
    // short-circuits the entity check), fabricated entities — absent from the
    // evidence entirely — must reach the bounded composer's guard so the
    // fail-open path can never banner-keep them.
    let deliveryAssessment = assessment;
    if (
      externalFact &&
      !assessment.entityCoverage &&
      policy?.verificationPlan?.entityEvidenceRequired
    ) {
      const { assessEntityClaimEvidence } = require("./entity-claim-evidence");
      const deliveryCoverage = assessEntityClaimEvidence({
        assistant: original,
        evidenceText,
        verificationPlan: policy.verificationPlan,
        acceptedClaimLabels,
        judgedUnsupportedClaims,
        judgedConflictingClaims,
      });
      if (deliveryCoverage?.ok === false) {
        deliveryAssessment = {
          ...assessment,
          entityCoverage: deliveryCoverage,
          unsupportedClaims: [...new Set([...(assessment.unsupportedClaims || []), ...deliveryCoverage.unsupportedClaims])],
          conflictingClaims: [...new Set([...(assessment.conflictingClaims || []), ...deliveryCoverage.conflictingClaims])],
        };
      }
    }
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
    // Tiered failure delivery. Invariant: outside the hard tier, the gate may
    // relabel/trim/bound the answer but never reduces delivered task content
    // to zero while any supported content exists.
    let finalAssistant;
    let finalAssessment = deliveryAssessment;
    if (externalFact && riskTier === "advisory") {
      finalAssistant = appendEvidenceGateNotice(original, deliveryAssessment);
    } else if (externalFact && riskTier === "verify_soft") {
      const bounded = composeFramedBoundedAnswer({
        assistant: original,
        assessment: deliveryAssessment,
        evidenceSummary: effectiveEvidenceSummary,
        evidenceText,
        userText,
        recoveryAttempt,
        framing: semanticVerdict,
      }) || composeBoundedExternalAnswer({
        assistant: original,
        assessment: deliveryAssessment,
        policy,
        evidenceSummary: effectiveEvidenceSummary,
        userText,
        recoveryAttempt,
        // The recovery pass IS the final state — no further retry will improve
        // it, so the bounded-answer invariant applies there.
        retryPending: externalFactRetry && !recoveryAttempt,
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
      if (bounded) {
        finalAssistant = bounded.assistant;
        finalAssessment = bounded.assessment;
      } else {
        finalAssistant = safeExternalFactFallback({ policy, evidenceSummary, userText, recoveryAttempt });
      }
    } else if (externalFact) {
      // Fail boundary (user decision 2026-07-20): only genuinely high-stakes
      // asks fail CLOSED (zero-content fallback). Ordinary hard-tier asks
      // fail OPEN: with real research in the ledger the researched answer is
      // delivered under an explicit banner — never a vocabulary decision,
      // the guards in composeFramedBoundedAnswer are literal-only.
      const legacyAllHard = process.env.LILY_EVIDENCE_RISK_TIERS === "0";
      const failClosed = legacyAllHard || isHighStakesPolicy(policy, semanticVerdict);
      const bounded = !failClosed
        ? composeFramedBoundedAnswer({
            assistant: original,
            assessment: deliveryAssessment,
            evidenceSummary: effectiveEvidenceSummary,
            evidenceText,
            userText,
            recoveryAttempt,
            framing: semanticVerdict,
          })
        : null;
      if (bounded) {
        finalAssistant = bounded.assistant;
        finalAssessment = bounded.assessment;
      } else {
        finalAssistant = safeExternalFactFallback({ policy, evidenceSummary, userText, recoveryAttempt });
      }
    } else if (sourceContent) {
      finalAssistant = safeSourceContentFallback({ evidenceSummary, userText });
    } else {
      finalAssistant = appendEvidenceGateNotice(original, assessment);
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
    // Internal gate error: only the hard tier fails closed (its guarantees are
    // the product promise). verify_soft/advisory fail OPEN with the original
    // answer — a broken gate must never make the platform dumber than baseline.
    let errorTier = "hard";
    if (externalFact) {
      try {
        errorTier = externalFactRiskTier(taskContract?.externalFactPolicy);
      } catch {
        errorTier = "hard";
      }
    }
    if (externalFact && errorTier !== "hard") {
      return {
        assistant: original,
        assessment: {
          ok: false,
          required: true,
          strongClaim: false,
          hasEvidence: false,
          reason: "evidence_gate_internal_error",
          riskTier: errorTier,
          failedOpen: true,
        },
        evidenceSummary,
        triggerVerifyRetry: false,
        triggerDocumentVerifyRetry: false,
        error,
      };
    }
    return {
      assistant: externalFact
        ? safeExternalFactFallback({
            policy: taskContract?.externalFactPolicy,
            evidenceSummary,
            userText,
            recoveryAttempt,
          })
        : safeSourceContentFallback({ evidenceSummary, userText }),
      assessment: {
        ok: false,
        required: true,
        strongClaim: true,
        hasEvidence: false,
        reason: "evidence_gate_internal_error",
      },
      evidenceSummary,
      triggerVerifyRetry: false,
      triggerDocumentVerifyRetry: false,
      error,
    };
  }
}

/**
 * evaluateAnswerEvidence + the unified semantic judge. The deterministic gate
 * runs first (fast path — a passing answer never pays a model call, and the
 * literal floor: URL/entity/number grounding, fabrication checks). When it
 * fails on something inherently SEMANTIC — claim entailment, source
 * authority, conflicts, informal-label framing, stakes — ONE judge call
 * (judgeTurnSemantics) rules on all of it, and the FULL deterministic gate
 * re-runs with the verdict as whitelists/rulings. Hard floors:
 *   - claims without real evidence windows are never judged (fabrication);
 *   - judge-ruled conflicts are never banner-kept or overridden;
 *   - judge unavailable/malformed → the deterministic verdict's own delivery
 *     applies (ordinary tiers fail open bounded, high-stakes fail closed).
 * Kill switch: LILY_EVIDENCE_LLM_JUDGE=0.
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
        .map((win) => win.slice(0, 700));
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
    const verdict = await judgeFn({
      claims: claimParams,
      urls,
      userText: String(params_.userText || ""),
    });
    // Judge unavailable/failed: the deterministic delivery already encodes the
    // fail boundary (bounded fail-open ordinary, zero-content high-stakes).
    if (!verdict) return result;
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
  safeExternalFactFallback,
  shouldBufferAssistantAnswer,
  toolEvidenceText,
};
