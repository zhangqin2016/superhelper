import assert from "node:assert/strict";

const {
  listCapabilities,
  listSkillCapabilityGraph,
  recommendSkillCapabilityGraph,
  compactCapabilityContext,
  shouldInjectCapabilityContext,
} = await import(
  "../src/main/capability-broker.js"
);

const capabilities = listCapabilities();
assert.ok(capabilities.some((item) => item.id === "dependency.install"));
assert.ok(capabilities.some((item) => item.id === "file.index"));
assert.ok(capabilities.some((item) => item.id === "process.job"));
assert.ok(capabilities.some((item) => item.id === "artifact.reveal"));

for (const item of capabilities) {
  assert.match(item.id, /^[a-z][a-z0-9.-]+$/);
  assert.ok(item.title);
  assert.ok(item.family);
  assert.ok(Array.isArray(item.triggers));
  assert.ok(item.route);
  assert.ok(item.failOpen);
}

const context = compactCapabilityContext({ maxChars: 2500 });
assert.ok(context.includes("dependency.install"));
assert.ok(context.includes("process.job"));
assert.ok(context.includes("fail open"));
assert.ok(context.includes("runtime_pack_list/runtime_pack_install"));
assert.ok(context.includes("Do not invoke OpenCode native `skill <id>`"));
assert.ok(context.includes("anthropics-*"));
assert.equal(context.includes("Use lily-runtime-packs skill"), false);
assert.ok(context.length <= 2500);

const graph = listSkillCapabilityGraph();
const byId = new Map(graph.map((item) => [item.id, item]));
assert.ok(byId.has("lily-office-intent"), "capability graph should include the office router");
assert.equal(byId.get("lily-office-intent").kind, "router");
assert.ok(byId.get("lily-office-intent").intents.includes("office.route"));
assert.ok(byId.has("anthropics-xlsx"), "capability graph should include bundled spreadsheet skills");
assert.equal(byId.get("anthropics-xlsx").kind, "tool");
assert.ok(byId.get("anthropics-xlsx").guidePath.endsWith("resources/skills-catalog/anthropics-xlsx/SKILL.md"));
assert.ok(byId.get("anthropics-xlsx").requiredRuntimePacks.includes("libreoffice"));
assert.ok(byId.get("anthropics-xlsx").requiredRuntimePacks.includes("large-document"));
assert.ok(byId.get("anthropics-xlsx").verification.required);
assert.ok(graph.every((item) => item.failOpen), "every graph node should expose a fail-open route");
assert.ok(
  byId.get("lily-stock-research")?.matchHints?.includes("portfolio"),
  "capability graph should preserve registry-declared match hints instead of relying only on broker hardcoding"
);
assert.ok(
  byId.get("lily-research-synthesis")?.matchHints?.includes("latest news"),
  "research routing variants should live in registry match hints instead of only broker regexes"
);
assert.ok(
  byId.get("lily-research-synthesis")?.matchHints?.includes("API prices"),
  "research price/citation variants should be catalog-declared capability hints"
);
assert.ok(
  byId.get("lily-research-synthesis")?.matchHints?.includes("带来源"),
  "capability graph should not truncate multilingual research match hints"
);
assert.ok(
  byId.get("lily-research-synthesis")?.matchHints?.includes("给出处"),
  "capability graph should preserve late registry hints used by Chinese source-backed requests"
);
assert.ok(
  byId.get("lily-runtime-packs")?.matchHints?.includes("image resize"),
  "runtime image transform variants should live in registry match hints instead of only broker regexes"
);
assert.ok(
  byId.get("lily-runtime-packs")?.matchHints?.includes("background removal"),
  "runtime background-removal variants should be catalog-declared capability hints"
);
assert.ok(
  byId.get("lily-runtime-packs")?.matchHints?.includes("video transcode"),
  "runtime media processing variants should be catalog-declared capability hints"
);
assert.ok(
  byId.get("lily-prompt-enhancer")?.avoidHints?.includes("skill route"),
  "capability graph should preserve registry-declared avoid hints for negative routing contexts"
);

const officeContext = compactCapabilityContext({ maxChars: 4000 });
assert.ok(officeContext.includes("Skill capability graph"));
assert.ok(officeContext.includes("anthropics-xlsx"));
assert.ok(officeContext.includes("packs=libreoffice,large-document"));

const defaultCompactContext = compactCapabilityContext({ maxChars: 2500 });
assert.ok(defaultCompactContext.includes("lily-app-builder"), "default compact context should expose app-building capability");
assert.ok(defaultCompactContext.includes("lily-mail-assistant"), "default compact context should expose mail capability");
assert.ok(defaultCompactContext.includes("lily-research-synthesis"), "default compact context should expose research capability");

const pdfRecommendations = recommendSkillCapabilityGraph({
  text: "把这个复杂 PDF 表格提取出来并检查版面",
  files: [{ name: "contract.pdf" }],
});
assert.ok(pdfRecommendations.some((skill) => skill.id === "lily-office-intent"), "PDF work should include the office router");
assert.ok(pdfRecommendations.some((skill) => skill.id === "lily-pdf-extraction-router"), "PDF work should include the PDF router");
assert.ok(pdfRecommendations.some((skill) => skill.id === "anthropics-pdf"), "PDF work should include the bundled PDF tool");
assert.ok(!pdfRecommendations.some((skill) => skill.id === "anthropics-xlsx"), "PDF work should not prioritize spreadsheet skills");

const xlsxRecommendations = recommendSkillCapabilityGraph({
  text: "分析这个 Excel 并生成图表",
  files: [{ name: "sales.xlsx" }],
});
assert.equal(xlsxRecommendations[0]?.id, "lily-excel-data-analysis", "spreadsheet analysis should put the Excel analysis workflow first");
assert.ok(xlsxRecommendations.some((skill) => skill.id === "anthropics-xlsx"), "spreadsheet work should include the bundled spreadsheet tool");
assert.ok(!xlsxRecommendations.some((skill) => skill.id === "anthropics-pdf"), "spreadsheet work should not prioritize PDF skills");

const csvChartRecommendations = recommendSkillCapabilityGraph({
  text: "把 CSV 清洗成规范 Excel，生成透视汇总和柱状图",
  files: [{ name: "raw.csv" }],
});
assert.equal(csvChartRecommendations[0]?.id, "lily-excel-data-analysis", "CSV cleanup and chart work should put the Excel analysis workflow first");
assert.ok(csvChartRecommendations.some((skill) => skill.id === "anthropics-xlsx"), "CSV cleanup should retain spreadsheet tooling");

const runtimeInstallRecommendations = recommendSkillCapabilityGraph({
  text: "安装处理大型 PDF 的 OCR 和 Docling 依赖包",
});
assert.equal(runtimeInstallRecommendations[0]?.id, "lily-runtime-packs", "runtime dependency install should put runtime packs first");
assert.ok(
  runtimeInstallRecommendations.some((skill) => skill.id === "lily-pdf-extraction-router"),
  "runtime dependency install for PDF should retain PDF extraction routing context"
);

const pdfRuntimeRecommendations = recommendSkillCapabilityGraph({
  text: "这个 PDF 需要 OCR 和 Docling 大模型包",
  files: [{ name: "scan.pdf" }],
});
assert.equal(pdfRuntimeRecommendations[0]?.id, "lily-runtime-packs", "PDF runtime enablement should put runtime packs first");
assert.ok(pdfRuntimeRecommendations.some((skill) => skill.id === "anthropics-pdf"), "PDF runtime enablement should retain the bundled PDF tool");

const imageOcrRecommendations = recommendSkillCapabilityGraph({
  text: "对这张扫描件做 OCR 并提取文字",
  files: [{ name: "scan.png" }],
});
assert.equal(imageOcrRecommendations[0]?.id, "lily-runtime-packs", "image OCR should put OCR/runtime support first");
assert.ok(imageOcrRecommendations.some((skill) => skill.id === "lily-image-qa"), "image OCR should retain image inspection context");
assert.ok(
  !imageOcrRecommendations.some((skill) => skill.id === "lily-pdf-extraction-router" || skill.id === "anthropics-pdf"),
  "image OCR should not route through PDF extraction or PDF tooling"
);

const imageCreateRecommendations = recommendSkillCapabilityGraph({
  text: "生成一张产品海报图片，适合小红书封面",
});
assert.equal(imageCreateRecommendations[0]?.id, "lily-creative-director", "image/poster generation should put creative direction first");
assert.ok(imageCreateRecommendations.some((skill) => skill.id === "lily-prompt-enhancer"), "image generation should retain prompt enhancement support");
assert.ok(imageCreateRecommendations.some((skill) => skill.id === "lily-image-qa"), "image generation should retain image QA as verification support");

const promptEnhanceRecommendations = recommendSkillCapabilityGraph({
  text: "帮我把这个图片生成提示词写得更专业",
});
assert.equal(promptEnhanceRecommendations[0]?.id, "lily-prompt-enhancer", "image prompt writing should put prompt enhancement first");
assert.ok(
  promptEnhanceRecommendations.some((skill) => skill.id === "lily-creative-director"),
  "image prompt writing should retain creative direction support"
);

const imageQaRecommendations = recommendSkillCapabilityGraph({
  text: "检查这张生成的海报有没有文字错误",
  files: [{ name: "poster.png" }],
});
assert.equal(imageQaRecommendations[0]?.id, "lily-image-qa", "image review should put image QA first");
assert.ok(
  !imageQaRecommendations.some((skill) => skill.id === "lily-creative-director"),
  "image review should not recommend creative generation workflow"
);

const englishImageArtifactRecommendations = recommendSkillCapabilityGraph({
  text: "Review this generated image for artifact defects",
  files: [{ name: "poster.png" }],
});
assert.equal(englishImageArtifactRecommendations[0]?.id, "lily-image-qa", "English image artifact review should put image QA first");
assert.ok(
  !englishImageArtifactRecommendations.some((skill) => skill.id === "lily-app-builder"),
  "image artifact review should not be mistaken for app/artifact creation"
);

const uploadedImageResizeRecommendations = recommendSkillCapabilityGraph({
  text: "Resize the uploaded image and export as webp",
});
assert.equal(
  uploadedImageResizeRecommendations[0]?.id,
  "lily-runtime-packs",
  "uploaded image resize/export should put runtime packs first even when the file object is not present"
);
assert.ok(
  !uploadedImageResizeRecommendations.some((skill) => skill.id === "lily-creative-director"),
  "uploaded image resize/export should not be mistaken for creative image generation"
);

const attachedPhotoShrinkRecommendations = recommendSkillCapabilityGraph({
  text: "Make the attached photo smaller and save as jpeg",
});
assert.equal(
  attachedPhotoShrinkRecommendations[0]?.id,
  "lily-runtime-packs",
  "attached image resize/conversion should not depend on exact resize/export wording"
);

const screenshotFormatChangeRecommendations = recommendSkillCapabilityGraph({
  text: "Change this screenshot to png",
});
assert.equal(
  screenshotFormatChangeRecommendations[0]?.id,
  "lily-runtime-packs",
  "screenshot format conversion should route to runtime packs without a file object"
);

const attachedPhotoBackgroundRemovalRecommendations = recommendSkillCapabilityGraph({
  text: "Remove the background from the attached product photo",
});
assert.equal(
  attachedPhotoBackgroundRemovalRecommendations[0]?.id,
  "lily-runtime-packs",
  "attached product photo background removal should put local image runtime packs first"
);
assert.ok(
  !attachedPhotoBackgroundRemovalRecommendations.some((skill) => skill.id === "lily-office-intent" || skill.id === "lily-pdf-extraction-router"),
  "attached product photo background removal should not fall through to Office/PDF routing"
);

const productPhotoCutoutRecommendations = recommendSkillCapabilityGraph({
  text: "给这张产品图抠图去背景",
});
assert.equal(
  productPhotoCutoutRecommendations[0]?.id,
  "lily-runtime-packs",
  "product photo cutout/background removal should route to runtime packs instead of creative generation"
);
assert.ok(
  !productPhotoCutoutRecommendations.some((skill) => skill.id === "lily-creative-director"),
  "deterministic product photo cutout should not be mistaken for creative direction"
);

const browserQaRecommendations = recommendSkillCapabilityGraph({
  text: "测试这个网页是否有 console error 和按钮失效问题",
});
assert.equal(browserQaRecommendations[0]?.id, "lily-browser-qa", "web QA should put browser QA first");
assert.ok(
  !browserQaRecommendations.some((skill) => skill.id === "lily-web-system-learning"),
  "web QA should not recommend high-risk web system learning"
);

const localSmokeRecommendations = recommendSkillCapabilityGraph({
  text: "打开 localhost:3000 做前端冒烟测试",
});
assert.equal(localSmokeRecommendations[0]?.id, "lily-browser-qa", "localhost smoke tests should put browser QA first");
assert.ok(
  !localSmokeRecommendations.some((skill) => skill.id === "lily-office-intent"),
  "localhost smoke tests should not fall back to Office routing"
);

const webLearningRecommendations = recommendSkillCapabilityGraph({
  text: "学习这个后台系统，以后用自然语言操作",
});
assert.equal(webLearningRecommendations[0]?.id, "lily-web-system-learning", "web system learning should put the learning connector first");
assert.ok(webLearningRecommendations.some((skill) => skill.id === "lily-browser-qa"), "web system learning should retain browser QA as supporting context");

const stockResearchRecommendations = recommendSkillCapabilityGraph({
  text: "研究一下英伟达股票，给我估值、风险和引用来源",
});
assert.equal(stockResearchRecommendations[0]?.id, "lily-stock-research", "stock research should put the stock workflow first");
assert.ok(stockResearchRecommendations.some((skill) => skill.id === "lily-research-synthesis"), "stock research should retain source synthesis support");
assert.ok(
  !stockResearchRecommendations.some((skill) => skill.id === "lily-document-query"),
  "stock research should not be mistaken for document evidence lookup"
);

const tickerStockRecommendations = recommendSkillCapabilityGraph({
  text: "Analyze ticker AAPL portfolio exposure and downside risk with sources",
});
assert.equal(
  tickerStockRecommendations[0]?.id,
  "lily-stock-research",
  "stock research should not depend on a short hardcoded company-name list"
);
assert.ok(
  tickerStockRecommendations.some((skill) => skill.id === "lily-research-synthesis"),
  "ticker stock research should retain source synthesis support"
);

const goToMarketRecommendations = recommendSkillCapabilityGraph({
  text: "Create a go-to-market launch plan for a SaaS product",
});
assert.ok(
  !goToMarketRecommendations.some((skill) => skill.id === "lily-stock-research"),
  "stock match hints must not treat generic go-to-market planning as financial research"
);

const folderIndexRecommendations = recommendSkillCapabilityGraph({
  text: "Index this project folder and summarize the files",
});
assert.ok(
  !folderIndexRecommendations.some((skill) => skill.id === "lily-stock-research"),
  "stock match hints must not treat file indexing as market index research"
);

const researchRecommendations = recommendSkillCapabilityGraph({
  text: "帮我做竞品研究，比较三家产品并给证据来源",
});
assert.equal(researchRecommendations[0]?.id, "lily-research-synthesis", "source-backed research should put research synthesis first");
assert.ok(
  !researchRecommendations.some((skill) => skill.id === "lily-document-query"),
  "source-backed research without files should not be mistaken for document evidence lookup"
);

const currentTechNewsRecommendations = recommendSkillCapabilityGraph({
  text: "今天有哪些重要科技新闻，给出处",
});
assert.equal(
  currentTechNewsRecommendations[0]?.id,
  "lily-research-synthesis",
  "current news with sources should put research synthesis first"
);
assert.equal(
  shouldInjectCapabilityContext({ text: "今天有哪些重要科技新闻，给出处" }),
  true,
  "current news with sources should inject focused research capability context"
);

const browserRankingRecommendations = recommendSkillCapabilityGraph({
  text: "最新的 AI 浏览器排行榜是什么，带来源",
});
assert.equal(
  browserRankingRecommendations[0]?.id,
  "lily-research-synthesis",
  "browser ranking research should not be stolen by browser QA just because the topic says browser"
);

const apiPriceResearchRecommendations = recommendSkillCapabilityGraph({
  text: "Compare current model API prices with citations",
});
assert.equal(
  apiPriceResearchRecommendations[0]?.id,
  "lily-research-synthesis",
  "source-backed API price comparison should not be mistaken for coding work"
);

const skillQualityRecommendations = recommendSkillCapabilityGraph({
  text: "检查这个技能是否符合质量门槛和能力契约",
});
assert.equal(skillQualityRecommendations[0]?.id, "lily-skill-quality-gate", "skill quality review should put the skill quality gate first");

const intentEvalRecommendations = recommendSkillCapabilityGraph({
  text: "评估这句话应该触发哪个意图和技能",
});
assert.equal(intentEvalRecommendations[0]?.id, "lily-intent-eval", "intent routing evaluation should put intent eval first");

const englishIntentEvalRecommendations = recommendSkillCapabilityGraph({
  text: "Evaluate which skill route this prompt should trigger",
});
assert.equal(
  englishIntentEvalRecommendations[0]?.id,
  "lily-intent-eval",
  "English skill-route evaluation should not be mistaken for prompt enhancement"
);
assert.ok(
  !englishIntentEvalRecommendations.some((skill) => skill.id === "lily-prompt-enhancer"),
  "prompt wording inside a routing-eval request must not pull in prompt enhancement"
);

const mailDraftRecommendations = recommendSkillCapabilityGraph({
  text: "给我写一封邮件回复客户，语气专业",
});
assert.equal(mailDraftRecommendations[0]?.id, "lily-mail-assistant", "email drafting should put mail assistant first");
assert.ok(
  !mailDraftRecommendations.some((skill) => skill.id === "lily-office-intent"),
  "email drafting should not fall back to Office routing"
);

const uiQualityRecommendations = recommendSkillCapabilityGraph({
  text: "检查这个页面的 UI 质量、间距、层级和视觉一致性",
});
assert.equal(uiQualityRecommendations[0]?.id, "lily-ui-quality", "UI quality review should put UI quality first");
assert.ok(uiQualityRecommendations.some((skill) => skill.id === "lily-browser-qa"), "UI quality review should retain browser QA support");

const englishUiQualityRecommendations = recommendSkillCapabilityGraph({
  text: "Audit spacing hierarchy and visual consistency on this dashboard",
});
assert.equal(englishUiQualityRecommendations[0]?.id, "lily-ui-quality", "English UI audit should put UI quality first");
assert.ok(
  !englishUiQualityRecommendations.some((skill) => skill.id === "lily-creative-director"),
  "UI audit should not be mistaken for creative visual generation"
);

const codeRepairRecommendations = recommendSkillCapabilityGraph({
  text: "修复这个报错：TypeError cannot read property of undefined",
});
assert.equal(codeRepairRecommendations[0]?.id, "lily-code-repair", "runtime error repair should put code repair first");
assert.ok(
  !codeRepairRecommendations.some((skill) => skill.id === "lily-office-intent"),
  "runtime error repair should not fall back to Office routing"
);

const appBuilderRecommendations = recommendSkillCapabilityGraph({
  text: "帮我做一个 CRM 管理后台应用，包含客户列表和统计看板",
});
assert.equal(appBuilderRecommendations[0]?.id, "lily-app-builder", "new app creation should put app builder first");
assert.ok(appBuilderRecommendations.some((skill) => skill.id === "lily-coding-core"), "new app creation should retain coding core support");
assert.ok(appBuilderRecommendations.some((skill) => skill.id === "lily-browser-qa"), "new app creation should retain browser verification support");

const englishDashboardBuilderRecommendations = recommendSkillCapabilityGraph({
  text: "Build a SaaS dashboard for revenue retention cohorts",
});
assert.equal(englishDashboardBuilderRecommendations[0]?.id, "lily-app-builder", "English dashboard creation should put app builder first");
assert.ok(englishDashboardBuilderRecommendations.some((skill) => skill.id === "lily-coding-core"), "English dashboard creation should retain coding core support");

const codingCoreRecommendations = recommendSkillCapabilityGraph({
  text: "实现一个登录表单组件并接入校验逻辑",
});
assert.equal(codingCoreRecommendations[0]?.id, "lily-coding-core", "component implementation should put coding core first");
assert.ok(
  !codingCoreRecommendations.some((skill) => skill.id === "lily-office-intent"),
  "component implementation should not fall back to Office routing"
);

const engineeringRulesRecommendations = recommendSkillCapabilityGraph({
  text: "按工程规范审查这个实现方案，避免过度设计和能力退化",
});
assert.equal(engineeringRulesRecommendations[0]?.id, "lily-engineering-rules", "engineering discipline review should put engineering rules first");
assert.ok(
  !engineeringRulesRecommendations.some((skill) => skill.id === "anthropics-doc-coauthoring"),
  "engineering discipline review should not be mistaken for document drafting"
);

const englishEngineeringRulesRecommendations = recommendSkillCapabilityGraph({
  text: "Review this implementation plan for overengineering and capability regression",
});
assert.equal(
  englishEngineeringRulesRecommendations[0]?.id,
  "lily-engineering-rules",
  "English engineering discipline review should put engineering rules first"
);
assert.ok(
  !englishEngineeringRulesRecommendations.some((skill) => skill.id === "lily-office-intent"),
  "English engineering discipline review should not fall through to generic Office routing"
);

const englishCodeReviewRecommendations = recommendSkillCapabilityGraph({
  text: "Review this diff for bugs and missing tests",
});
assert.equal(
  englishCodeReviewRecommendations[0]?.id,
  "lily-engineering-rules",
  "English code review should put engineering rules first"
);
assert.ok(
  !englishCodeReviewRecommendations.some((skill) => skill.id === "lily-office-intent"),
  "English code review should not fall through to generic Office routing"
);

const scriptBuilderRecommendations = recommendSkillCapabilityGraph({
  text: "写一个脚本批量重命名这些文件",
});
assert.equal(scriptBuilderRecommendations[0]?.id, "lily-app-builder", "script creation should put app builder first");
assert.ok(scriptBuilderRecommendations.some((skill) => skill.id === "lily-coding-core"), "script creation should retain coding core support");
assert.ok(
  !scriptBuilderRecommendations.some((skill) => skill.id === "lily-office-intent"),
  "script creation should not fall back to Office routing"
);

const pdfCreateRecommendations = recommendSkillCapabilityGraph({
  text: "创建一个新的 PDF 报告并加水印",
});
assert.equal(pdfCreateRecommendations[0]?.id, "anthropics-pdf", "PDF creation/editing should put the PDF tool first");
assert.ok(
  !pdfCreateRecommendations.some((skill) => skill.id === "lily-app-builder"),
  "PDF creation/editing should not be mistaken for app creation"
);

const wordCreateRecommendations = recommendSkillCapabilityGraph({
  text: "创建一份带目录和页码的 Word 报告",
});
assert.equal(wordCreateRecommendations[0]?.id, "anthropics-doc-coauthoring", "Word report creation should put document coauthoring first");
assert.ok(wordCreateRecommendations.some((skill) => skill.id === "anthropics-docx"), "Word report creation should retain DOCX tooling");
assert.ok(
  !wordCreateRecommendations.some((skill) => skill.id === "lily-app-builder"),
  "Word report creation should not be mistaken for app creation"
);

const pptCreateRecommendations = recommendSkillCapabilityGraph({
  text: "创建一个 PowerPoint 培训课件",
});
assert.equal(pptCreateRecommendations[0]?.id, "anthropics-pptx", "PowerPoint creation should put PPTX tooling first");
assert.ok(
  !pptCreateRecommendations.some((skill) => skill.id === "lily-app-builder"),
  "PowerPoint creation should not be mistaken for app creation"
);

const templateFillRecommendations = recommendSkillCapabilityGraph({
  text: "用这个 Word 模板批量填充客户信息生成合同",
  files: [{ name: "contract-template.docx" }],
});
assert.equal(templateFillRecommendations[0]?.id, "lily-template-fill", "template fill should put template filling first");
assert.ok(templateFillRecommendations.some((skill) => skill.id === "anthropics-docx"), "template fill should retain DOCX tooling");

const videoTranscodeRecommendations = recommendSkillCapabilityGraph({
  text: "剪辑这个视频并转码成 mp4",
  files: [{ name: "clip.mov" }],
});
assert.equal(videoTranscodeRecommendations[0]?.id, "lily-runtime-packs", "video editing/transcoding should put runtime packs first");
assert.ok(
  !videoTranscodeRecommendations.some((skill) => skill.id === "lily-creative-director"),
  "video editing/transcoding should not be mistaken for creative prompt direction"
);

const videoRuntimePackRecommendations = recommendSkillCapabilityGraph({
  text: "Enable ffmpeg video processing pack",
});
assert.equal(videoRuntimePackRecommendations[0]?.id, "lily-runtime-packs", "video runtime pack enablement should put runtime packs first");
assert.ok(
  !videoRuntimePackRecommendations.some((skill) => skill.id === "lily-creative-director"),
  "video runtime pack enablement should not be mistaken for creative video generation"
);

const currentVideoCompressRecommendations = recommendSkillCapabilityGraph({
  text: "Compress the current video to mp4",
});
assert.equal(
  currentVideoCompressRecommendations[0]?.id,
  "lily-runtime-packs",
  "current video compression should put runtime packs first even when the file object is not present"
);
assert.ok(
  !currentVideoCompressRecommendations.some((skill) => skill.id === "lily-office-intent" || skill.id === "lily-pdf-extraction-router"),
  "current video compression should not fall through to Office/PDF routing"
);

const focusedPdfContext = compactCapabilityContext({
  text: "提取 PDF 表格",
  files: [{ name: "a.pdf" }],
  maxChars: 3500,
});
assert.ok(focusedPdfContext.includes("anthropics-pdf"), "focused PDF context should include PDF skill");
assert.equal(focusedPdfContext.includes("anthropics-xlsx"), false, "focused PDF context should omit unrelated spreadsheet skill");

const activeUnrelatedRecommendations = recommendSkillCapabilityGraph({
  text: "提取 PDF 表格",
  files: [{ name: "a.pdf" }],
  activeSkillIds: ["lily-mail-assistant"],
});
assert.ok(
  !activeUnrelatedRecommendations.some((skill) => skill.id === "lily-mail-assistant"),
  "active but unrelated skills should not pollute focused recommendations"
);

function firstFocusedSkillId(contextText) {
  return contextText
    .split("\n")
    .find((line) => line.startsWith("- "))
    ?.match(/^- ([^ ]+)/)?.[1] || "";
}

assert.equal(
  firstFocusedSkillId(compactCapabilityContext({
    text: "帮我做一个 CRM 管理后台应用，包含客户列表和统计看板",
    maxChars: 2000,
  })),
  "lily-app-builder",
  "focused app context should preserve the top recommended app builder skill"
);
assert.equal(
  firstFocusedSkillId(compactCapabilityContext({
    text: "研究一下英伟达股票，给我估值、风险和引用来源",
    maxChars: 2000,
  })),
  "lily-stock-research",
  "focused stock context should preserve the top recommended stock skill"
);
assert.equal(
  firstFocusedSkillId(compactCapabilityContext({
    text: "检查这个页面的 UI 质量、间距、层级和视觉一致性",
    maxChars: 2000,
  })),
  "lily-ui-quality",
  "focused UI context should preserve the top recommended UI quality skill"
);

const pdfFormRecommendations = recommendSkillCapabilityGraph({
  text: "填写这个 PDF 表单，校验必填字段并导出",
  files: [{ name: "visa-form.pdf" }],
});
assert.ok(pdfFormRecommendations.some((skill) => skill.id === "lily-pdf-form"), "PDF form work should include the form-specific skill");
assert.ok(pdfFormRecommendations.some((skill) => skill.id === "anthropics-pdf"), "PDF form work should still include the bundled PDF tool");
assert.ok(!pdfFormRecommendations.some((skill) => skill.id === "anthropics-xlsx"), "PDF form work should not prioritize spreadsheet skills");

const englishPdfFormRecommendations = recommendSkillCapabilityGraph({
  text: "Validate fillable required fields in this PDF form",
  files: [{ name: "visa.pdf" }],
});
assert.equal(englishPdfFormRecommendations[0]?.id, "lily-pdf-form", "explicit PDF form validation should put the form-specific skill first");
assert.ok(englishPdfFormRecommendations.some((skill) => skill.id === "anthropics-pdf"), "PDF form validation should retain the bundled PDF tool");

const documentDraftRecommendations = recommendSkillCapabilityGraph({
  text: "写一份结构化项目提案文档，包含目标、范围、预算和风险",
});
assert.ok(
  documentDraftRecommendations.some((skill) => skill.id === "anthropics-doc-coauthoring"),
  "structured document drafting should include the coauthoring workflow"
);
assert.ok(documentDraftRecommendations.some((skill) => skill.id === "anthropics-docx"), "structured document drafting should include the DOCX tool");
assert.ok(!documentDraftRecommendations.some((skill) => skill.id === "anthropics-pdf"), "document drafting should not prioritize PDF skills");

const documentQueryRecommendations = recommendSkillCapabilityGraph({
  text: "查询这份合同文档里的付款条件并引用证据",
  files: [{ name: "contract.docx" }],
});
assert.equal(
  documentQueryRecommendations[0]?.id,
  "lily-document-query",
  "document evidence lookup should put the query/index skill first"
);
assert.ok(documentQueryRecommendations.some((skill) => skill.id === "anthropics-docx"), "document evidence lookup should retain the DOCX tool");
assert.ok(
  !documentQueryRecommendations.some((skill) => skill.id === "lily-template-fill"),
  "document evidence lookup should not recommend template filling"
);
assert.ok(
  !documentQueryRecommendations.some((skill) => skill.id === "lily-pdf-extraction-router"),
  "DOCX evidence lookup should not recommend the PDF extraction router"
);

const uploadedDocumentQueryRecommendations = recommendSkillCapabilityGraph({
  text: "Find evidence for the cancellation policy in the uploaded contract",
});
assert.equal(
  uploadedDocumentQueryRecommendations[0]?.id,
  "lily-document-query",
  "uploaded document evidence lookup should put document query first even when the file object is not present"
);
assert.ok(
  !uploadedDocumentQueryRecommendations.some((skill) => skill.id === "lily-browser-qa"),
  "uploaded document evidence lookup should not fall through to browser QA"
);

const currentReportVerifyRecommendations = recommendSkillCapabilityGraph({
  text: "Verify pagination and table layout in the current report",
});
assert.equal(
  currentReportVerifyRecommendations[0]?.id,
  "lily-document-verify",
  "current report delivery verification should put document verification first even when the file object is not present"
);
assert.ok(
  !currentReportVerifyRecommendations.some((skill) => skill.id === "anthropics-doc-coauthoring"),
  "current report delivery verification should not be mistaken for document drafting"
);

const pdfReadSummaryRecommendations = recommendSkillCapabilityGraph({
  text: "读取并总结这个 PDF 文件",
  files: [{ name: "paper.pdf" }],
});
assert.equal(pdfReadSummaryRecommendations[0]?.id, "anthropics-pdf", "PDF read/summary should put PDF tooling first");
assert.ok(pdfReadSummaryRecommendations.some((skill) => skill.id === "lily-pdf-extraction-router"), "PDF read/summary should retain PDF routing");
assert.ok(
  pdfReadSummaryRecommendations.indexOf(pdfReadSummaryRecommendations.find((skill) => skill.id === "lily-document-query")) >
    pdfReadSummaryRecommendations.indexOf(pdfReadSummaryRecommendations.find((skill) => skill.id === "anthropics-pdf")),
  "PDF read/summary should not let document query outrank PDF tooling"
);

const docxReadSummaryRecommendations = recommendSkillCapabilityGraph({
  text: "读取这个 Word 文档并总结要点",
  files: [{ name: "report.docx" }],
});
assert.equal(docxReadSummaryRecommendations[0]?.id, "anthropics-docx", "DOCX read/summary should put DOCX tooling first");
assert.ok(
  docxReadSummaryRecommendations.indexOf(docxReadSummaryRecommendations.find((skill) => skill.id === "lily-document-query")) >
    docxReadSummaryRecommendations.indexOf(docxReadSummaryRecommendations.find((skill) => skill.id === "anthropics-docx")),
  "DOCX read/summary should not let document query outrank DOCX tooling"
);

const pptReadSummaryRecommendations = recommendSkillCapabilityGraph({
  text: "读取这个 PowerPoint 并提取每页要点",
  files: [{ name: "deck.pptx" }],
});
assert.equal(pptReadSummaryRecommendations[0]?.id, "anthropics-pptx", "PPT read/summary should put PPTX tooling first");

const xlsxReadSummaryRecommendations = recommendSkillCapabilityGraph({
  text: "读取这个 Excel 并说明每个 sheet 的内容",
  files: [{ name: "book.xlsx" }],
});
assert.equal(xlsxReadSummaryRecommendations[0]?.id, "anthropics-xlsx", "XLSX read/summary should put XLSX tooling first");

const currentWorkbookFormulaRecommendations = recommendSkillCapabilityGraph({
  text: "Fix formulas in the current workbook",
});
assert.equal(
  currentWorkbookFormulaRecommendations[0]?.id,
  "lily-excel-data-analysis",
  "current workbook formula repair should put Excel analysis first even when the file object is not present"
);
assert.ok(
  currentWorkbookFormulaRecommendations.some((skill) => skill.id === "anthropics-xlsx"),
  "current workbook formula repair should retain spreadsheet tooling"
);
assert.ok(
  !currentWorkbookFormulaRecommendations.some((skill) => skill.id === "lily-code-repair"),
  "current workbook formula repair should not be mistaken for code repair"
);

const pptQaRecommendations = recommendSkillCapabilityGraph({
  text: "检查这个 PPT 是否有文字溢出、版式问题并导出 QA 报告",
  files: [{ name: "training.pptx" }],
});
assert.equal(pptQaRecommendations[0]?.id, "lily-ppt-design-qa", "PPT visual QA should put the presentation QA skill first");
assert.ok(pptQaRecommendations.some((skill) => skill.id === "anthropics-pptx"), "PPT visual QA should retain the PPTX tool");
assert.ok(
  !pptQaRecommendations.some((skill) => skill.id === "anthropics-docx"),
  "PPT visual QA should not recommend DOCX tooling"
);

const englishPptQaRecommendations = recommendSkillCapabilityGraph({
  text: "Review slide overflow and visual consistency",
  files: [{ name: "deck.pptx" }],
});
assert.equal(englishPptQaRecommendations[0]?.id, "lily-ppt-design-qa", "English slide QA should put PPT design QA first");
assert.ok(
  englishPptQaRecommendations.indexOf(englishPptQaRecommendations.find((skill) => skill.id === "lily-ui-quality")) >
    englishPptQaRecommendations.indexOf(englishPptQaRecommendations.find((skill) => skill.id === "lily-ppt-design-qa")),
  "generic UI quality should not outrank PPT-specific QA for slide decks"
);

const pptExportRecommendations = recommendSkillCapabilityGraph({
  text: "把这份 PPT 转成 PDF 并检查版面",
  files: [{ name: "training.pptx" }],
});
assert.ok(pptExportRecommendations.some((skill) => skill.id === "anthropics-pptx"), "PPT export should include the PPTX tool");
assert.ok(pptExportRecommendations.some((skill) => skill.id === "lily-document-verify"), "PPT export should include render verification");
assert.ok(
  !pptExportRecommendations.some((skill) => skill.id === "lily-pdf-extraction-router"),
  "PPT export to PDF should not recommend the PDF extraction router"
);

const tinyContext = compactCapabilityContext({ maxChars: 500 });
assert.ok(tinyContext.length <= 500);

assert.equal(shouldInjectCapabilityContext({ text: "你好", files: [] }), false);
assert.equal(shouldInjectCapabilityContext({ text: "分析这个 PDF", files: [{ path: "/tmp/a.pdf" }] }), true);
assert.equal(shouldInjectCapabilityContext({ text: "安装能处理大 PDF 的依赖", files: [] }), true);
assert.equal(shouldInjectCapabilityContext({ text: "继续", files: [], dependencyAdvisory: { text: "missing" } }), true);
assert.equal(shouldInjectCapabilityContext({ text: "给我写一封邮件回复客户，语气专业", files: [] }), true);
assert.equal(shouldInjectCapabilityContext({ text: "研究一下英伟达股票，给我估值、风险和引用来源", files: [] }), true);
assert.equal(shouldInjectCapabilityContext({ text: "AAPL portfolio exposure", files: [] }), true);
assert.equal(shouldInjectCapabilityContext({ text: "Synthesize current sources about EU AI Act compliance", files: [] }), true);
assert.equal(shouldInjectCapabilityContext({ text: "Audit this capability contract before release", files: [] }), true);
assert.equal(shouldInjectCapabilityContext({ text: "Review this implementation plan for overengineering and capability regression", files: [] }), true);
assert.equal(shouldInjectCapabilityContext({ text: "Review this diff for bugs and missing tests", files: [] }), true);
assert.equal(shouldInjectCapabilityContext({ text: "tell me a joke", files: [] }), false);
assert.equal(shouldInjectCapabilityContext({ text: "帮我做一个 CRM 管理后台应用，包含客户列表和统计看板", files: [] }), true);
assert.equal(shouldInjectCapabilityContext({ text: "评估这句话应该触发哪个意图和技能", files: [] }), true);

console.log("capability-broker: ok");
