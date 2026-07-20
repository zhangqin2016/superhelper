"use strict";

const { assessFinalAnswerEvidence, appendEvidenceGateNotice } = require("./evidence-gate");
const {
  answerLanguage,
  safeExternalFactFallback,
  salvageSupportedExternalAnswer,
} = require("./external-evidence-recovery");
const { shouldAutoVerifyExternalFact } = require("./external-fact-policy");
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
  return isExternalFactContract(taskContract) ||
    isSourceContentContract(taskContract) ||
    requiresDocumentDelivery(taskContract);
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
      return {
        assistant: original,
        assessment: documentDelivery.required ? { ...assessment, documentDelivery } : assessment,
        documentDelivery,
        evidenceSummary: effectiveEvidenceSummary,
        triggerVerifyRetry: false,
        triggerDocumentVerifyRetry: false,
        evidenceText,
      };
    }

    if (externalFact && recoveryAttempt) {
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
        }),
      });
      if (salvaged) {
        return {
          assistant: salvaged.assistant,
          assessment: salvaged.assessment,
          documentDelivery,
          evidenceSummary: effectiveEvidenceSummary,
          triggerVerifyRetry: false,
          triggerDocumentVerifyRetry: false,
          evidenceText,
        };
      }
    }

    const policy = taskContract?.externalFactPolicy || null;
    const sideEffectFree = isSideEffectFreeToolRun(tools);
    const externalFactRetry = shouldAutoVerifyExternalFact({
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
    return {
      assistant: externalFact
        ? safeExternalFactFallback({ policy, evidenceSummary, userText, recoveryAttempt })
        : sourceContent
          ? safeSourceContentFallback({ evidenceSummary, userText })
          : appendEvidenceGateNotice(original, assessment),
      assessment,
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

module.exports = {
  evaluateAnswerEvidence,
  isExternalFactContract,
  safeExternalFactFallback,
  shouldBufferAssistantAnswer,
  toolEvidenceText,
};
