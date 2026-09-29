"use strict";

// The prompt of the 文档交付续检 round: what the delivery gate found missing,
// file by file, and only the steps that complete it.
const { answerLanguage } = require("../shared/script.mjs");
const { missingLabels } = require("./document-delivery-gate");
const { INTERNAL_PROMPT_KINDS, markInternalPrompt, stripInternalPromptMarker } = require("./internal-prompt-marker");

// Each numbered step of the continuation, by the check it completes. The round
// asks only for what the gate found missing: 2026-09-30 it listed every file,
// including Markdown that had passed, so the model re-verified all of them
// (three .md converted, rendered and inspected page by page for nothing).
const RECOVERY_STEPS = {
  zh: {
    render: [
      "先调用 lily_capability_status 检查当前技能、runtime pack 和工具状态。已安装但健康检查失败的 pack 不可当作可用；按返回的 installAction 调用 runtime_pack_install，若 args 含 repair: true 就用 repair: true 强制修复。不要传 wait: true；安装/修复会返回后台 jobId，用 runtime_pack_list 观察进度。不要优先探测 /usr/local/bin/soffice 这类系统路径。",
      "使用 Lily 的 render_document.py 将文件渲染为逐页图片。缺 LibreOffice 或路径损坏时，先走受管理 runtime pack 安装/修复路线再重试；禁止临时 pip/npm/playwright install。",
    ],
    structure: ["用确定性库重新打开文件并确认结构有效，修正生成代码后重新生成。"],
    formula_recalculation: ["工作簿含公式：用 xlsx 技能（anthropics-xlsx）自带的 recalc.py 重算并消除公式错误。"],
    visual_inspection: [
      "真正查看渲染页内容：优先使用平台已有的图像读取/视觉通道查看页面图片，只有图像读取/视觉工具查看过页面图片，才算视觉验收。OCR 只能作为文字覆盖检查，不能替代视觉验收。12 页以内逐页查看；更多页至少查看首页、末页和分布在全文的 6 页。文件在渲染后改过就先用 render_document.py 重新渲染。",
      "检查遮挡、溢出、截断、空白页、字体替换、表格/图表错位、图片缺失和页边距。只修复实际发现的问题，然后重新渲染受影响页。",
    ],
    finish: [
      "如果渲染、依赖修复、图像读取通道全部失败后仍不能完成，才明确说明未完成的检查，并列出具体失败的本地依赖/工具；不要把 OCR 或文本抽取描述成视觉检查。",
      "这段回复会接在原回答下方显示：只写本次补做了哪些检查、发现和修改了什么，不要重复原回答的交付清单、结论或来源；仍无法验证的部分必须明确标为未验证。不要复述这段系统续检说明。",
    ],
  },
  en: {
    render: [
      "First call lily_capability_status to inspect active skills, runtime packs, and tools. A pack that is installed but unhealthy is not available; follow its installAction and call runtime_pack_install, using repair: true when returned. Do not pass wait: true; install/repair returns a background jobId and progress is observed with runtime_pack_list. Do not prefer ad-hoc system paths such as /usr/local/bin/soffice.",
      "Render the artifact to page images with Lily's render_document.py. If LibreOffice is missing or points to a broken executable, repair/install the managed runtime pack first and retry; never run ad-hoc pip/npm/playwright install.",
    ],
    structure: ["Reopen the file with a deterministic library and confirm its structure; fix the generating code and regenerate."],
    formula_recalculation: ["The workbook contains formulas: recalculate with the recalc.py bundled in the xlsx skill (anthropics-xlsx) and resolve formula errors."],
    visual_inspection: [
      "Actually inspect rendered pages with the platform's available image-reading or vision route. OCR may be used only for text coverage; it does not satisfy visual QA. Inspect every page up to 12 pages; for longer files inspect the first, last, and at least 6 pages distributed through the document. If the file changed after rendering, render it again with render_document.py first.",
      "Check clipping, overlap, overflow, blank pages, font fallback, table/chart alignment, missing images, and margins. Fix only confirmed defects, then re-render affected pages.",
    ],
    finish: [
      "Only after rendering, dependency repair, and image-reading routes all fail should you report the check as incomplete; include the exact missing or broken local dependency/tool and do not describe OCR or text extraction as visual inspection.",
      "This reply is shown under the original answer: state only which checks you completed and what you found and fixed; do not repeat the original answer's deliverables, conclusions or sources. Explicitly label anything still unverified. Do not repeat this internal continuation notice.",
    ],
  },
};
const ALL_CHECKS = ["render", "structure", "formula_recalculation", "visual_inspection"];
// The first line of every continuation prompt: how a history reader knows a
// turn was a delivery check (older ones were recorded as replacing the answer).
const OPENERS = {
  zh: "[系统文档交付续检] 这是对刚生成文件的一次内部续接，不是让你从头重做原任务。",
  en: "[system document delivery continuation] This is an internal continuation for files just created, not a request to redo the original task from scratch.",
};

function isDeliveryCheckPrompt(text = "") {
  const value = stripInternalPromptMarker(text).trimStart();
  return Object.values(OPENERS).some((opener) => value.startsWith(opener.slice(0, opener.indexOf("]") + 1)));
}

// Tagged as the platform's own recovery prompt: the question is hidden from the
// conversation, the answer to it is kept.
function buildDocumentDeliveryRecoveryPrompt(assessment = null, userText = "") {
  return markInternalPrompt(recoveryPromptText(assessment, userText), INTERNAL_PROMPT_KINDS.RECOVERY);
}

function recoveryPromptText(assessment = null, userText = "") {
  const all = (assessment?.artifacts || []).filter((item) => item?.path);
  // Files the gate passed are not re-verified. An item without a verdict (an
  // older caller) keeps the full checklist, as before.
  const failing = all.filter((item) => item.ok !== true);
  const pending = failing.length ? failing : all;
  const needs = (item) => (Array.isArray(item.missing) && item.missing.length ? item.missing : ALL_CHECKS);
  const needed = new Set(pending.flatMap(needs));
  const language = answerLanguage(userText);
  const zh = language === "zh";
  const steps = RECOVERY_STEPS[zh ? "zh" : "en"];
  const listed = pending.map((item) => {
    const missing = Array.isArray(item.missing) && item.missing.length ? missingLabels(item.missing, zh ? "zh" : "en") : "";
    return `- ${item.path}${missing ? (zh ? `（缺：${missing}）` : ` (missing: ${missing})`) : ""}`;
  }).join("\n");
  // What the schema check found, verbatim — the follow-up fixes that, not a guess.
  const violations = pending.flatMap((item) => {
    const structure = item?.checks?.structure;
    if (structure?.reason !== "ooxml_schema_violation") return [];
    return [`- ${item.path} (${structure.count})`, ...(structure.violations || []).slice(0, 3)
      .map((v) => `  ${v.part} ${v.node}: ${v.message}`)];
  });
  const numbered = [
    ...(needed.has("render") || needed.has("output_file") ? steps.render : []),
    ...(needed.has("structure") ? steps.structure : []),
    ...(needed.has("formula_recalculation") ? steps.formula_recalculation : []),
    ...(needed.has("visual_inspection") || needed.has("render") ? steps.visual_inspection : []),
    ...steps.finish,
  ].map((text, index) => `${index + 1}. ${text}`);
  if (zh) {
    return [
      OPENERS.zh,
      "请只补完下面列出的检查；其他文件已通过，不要重新验收。目标是尽可能完成用户任务，不要把可修复的依赖或工具选择问题当作终点。保留原内容和原路径，只在看到确定的质量问题时修改源文件。",
      "待补检查：",
      listed,
      ...(violations.length ? [
        "OOXML 结构校验发现 Word/PowerPoint/Excel 会拒绝打开的标记（LibreOffice 照样能渲染，所以页面看不出来）。修正生成代码并重新生成，再用 render_document.py 渲染确认 package.count 为 0：",
        ...violations,
      ] : []),
      "必须完成：",
      ...numbered,
    ].join("\n");
  }
  return [
    OPENERS.en,
    "Complete only the checks listed below; the other files passed and are not re-verified. The goal is to keep completing the user's task; repair recoverable dependency or tool-selection problems before declaring a gap. Preserve their content and paths; modify a source file only for a defect you actually observe.",
    "Checks to complete:",
    listed,
    ...(violations.length ? [
      "The OOXML structure check found markup Word/PowerPoint/Excel will refuse to open (LibreOffice renders it anyway, so the pages do not show it). Fix the generating code, regenerate, and render with render_document.py until package.count is 0:",
      ...violations,
    ] : []),
    "Required:",
    ...numbered,
  ].join("\n");
}

module.exports = { buildDocumentDeliveryRecoveryPrompt, isDeliveryCheckPrompt };
