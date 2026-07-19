"use strict";

const { assessFinalAnswerEvidence, appendEvidenceGateNotice } = require("./evidence-gate");
const { shouldAutoVerifyExternalFact } = require("./external-fact-policy");
const { isSideEffectFreeToolRun } = require("./tool-call-rescue");

function isExternalFactContract(taskContract = null) {
  return Boolean(taskContract?.externalFactPolicy?.required);
}

function isSourceContentContract(taskContract = null) {
  return taskContract?.taskType === "content_extraction";
}

function shouldBufferAssistantAnswer(taskContract = null) {
  return isExternalFactContract(taskContract) || isSourceContentContract(taskContract);
}

function answerLanguage(value = "") {
  const text = String(value || "");
  if (/[㐀-鿿]/u.test(text)) return "zh";
  if (/[؀-ۿ]/u.test(text)) return "ar";
  return "en";
}

function safeExternalFactFallback({ policy = null, evidenceSummary = null, userText = "" } = {}) {
  const language = answerLanguage(userText);
  const scopedQuestion = {
    zh: "这类排行没有统一客观答案，而且会随时间和评价口径变化。在没有完成可靠核验前，我不会直接给出一个看似确定的榜单。你希望按代码能力、Agent 能力、团队协作、价格，还是综合体验来排？",
    ar: "لا يوجد ترتيب موضوعي موحد لهذا النوع، كما أنه يتغير حسب الوقت والمعايير. لن أقدم قائمة تبدو مؤكدة قبل التحقق الموثوق. هل تريد الترتيب حسب جودة البرمجة، أو قدرات الوكيل، أو تعاون الفريق، أو السعر، أو التقييم الشامل؟",
    en: "There is no single objective ranking here, and the result changes with time and criteria. I will not present a definite-looking list before reliable verification. Should I rank by coding quality, agent capability, team collaboration, price, or overall experience?",
  };
  if (policy?.scopeClarificationRecommended) return scopedQuestion[language];

  if (policy?.researchProhibited) {
    return {
      zh: "这个问题涉及会变化的外部事实；在不搜索或查验来源的前提下，我无法可靠确认具体结论，因此不会凭记忆编造答案。",
      ar: "يتعلق هذا السؤال بحقائق خارجية متغيرة. وبما أن البحث والتحقق من المصادر غير مسموحين، فلا يمكنني تأكيد نتيجة محددة بشكل موثوق ولن أخمنها من الذاكرة.",
      en: "This depends on changing external facts. Without searching or checking sources, I cannot confirm a specific answer reliably, so I will not guess from memory.",
    }[language];
  }

  if (evidenceSummary?.hasFreshEvidence) {
    return {
      zh: "本轮检索结果不足以逐项支撑这些结论，我不会把未核实的排行、价格或数字作为答案。需要基于更完整的一手来源重新核验。",
      ar: "لا تكفي نتائج البحث في هذه الجولة لدعم الاستنتاجات بندا بندا، لذلك لن أقدم ترتيبا أو سعرا أو أرقاما غير متحققة كإجابة. يلزم تحقق جديد من مصادر أولية أكمل.",
      en: "This turn's research does not support the conclusions item by item, so I will not present an unverified ranking, price, or number as the answer. It needs another check against more complete primary sources.",
    }[language];
  }

  return {
    zh: "我没有取得可核验的实时来源，暂时不能可靠确认这个外部事实，因此不会用记忆补全一个看似具体的答案。",
    ar: "لم أحصل على مصدر آني قابل للتحقق، لذلك لا يمكنني تأكيد هذه الحقيقة الخارجية بشكل موثوق ولن أكملها بتخمين يبدو محددا.",
    en: "I did not obtain a verifiable current source, so I cannot confirm this external fact reliably and will not fill the gap with a specific-looking guess.",
  }[language];
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
} = {}) {
  const original = String(assistant || "").trim();
  const externalFact = isExternalFactContract(taskContract);
  const sourceContent = isSourceContentContract(taskContract);
  try {
    const evidenceText = toolEvidenceText(tools);
    const assessment = assessFinalAnswerEvidence({
      assistant: original,
      evidencePolicy: taskContract?.evidencePolicy,
      turnPolicy,
      evidenceSummary,
      toolCount: tools.length,
      fileChangeCount,
      evidenceText,
      userText,
      skipNumericGrounding: hasImageInput(inputFiles),
    });
    if (assessment.ok) return { assistant: original, assessment, triggerVerifyRetry: false, evidenceText };

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
        ? safeExternalFactFallback({ policy, evidenceSummary, userText })
        : sourceContent
          ? safeSourceContentFallback({ evidenceSummary, userText })
          : appendEvidenceGateNotice(original, assessment),
      assessment,
      triggerVerifyRetry: externalFactRetry || legacyOptInRetry,
      evidenceText,
    };
  } catch (error) {
    if (!externalFact && !sourceContent) {
      return { assistant: original, assessment: null, triggerVerifyRetry: false, error };
    }
    return {
      assistant: externalFact
        ? safeExternalFactFallback({
            policy: taskContract?.externalFactPolicy,
            evidenceSummary,
            userText,
          })
        : safeSourceContentFallback({ evidenceSummary, userText }),
      assessment: {
        ok: false,
        required: true,
        strongClaim: true,
        hasEvidence: false,
        reason: "evidence_gate_internal_error",
      },
      triggerVerifyRetry: false,
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
