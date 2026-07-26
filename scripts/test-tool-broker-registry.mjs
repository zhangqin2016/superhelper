#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import module from "node:module";
import { assert } from "./lib/test-assert.mjs";

const require = module.createRequire(import.meta.url);
const { buildBrokerTools, findBrokerTool } = require("../src/main/mcp/tool-broker-registry.js");

function names(context, deps) {
  return buildBrokerTools(context, deps).map((tool) => tool.name).sort();
}

const PLATFORM_TOOLS = [
  "lily_capability_list",
  "lily_capability_status",
  "lily_intent_contract_commit",
  "runtime_pack_install",
  "runtime_pack_list",
  "schedule_task_create",
  "schedule_task_list",
];

try {
  const base = { sessionId: "s1", activeSkillIds: [] };
  assert(
    JSON.stringify(names(base)) === JSON.stringify(PLATFORM_TOOLS),
    "platform capabilities are visible even when no optional skills are enabled",
  );
  assert(names({ activeSkillIds: ["lily-mail-assistant"], connectorStatus: { mailConnected: true } }).length === 0, "missing session id fails closed");

  const mail = {
    sessionId: "s1",
    activeSkillIds: ["lily-mail-assistant"],
    connectorStatus: { mailConnected: true },
  };
  assert(
    JSON.stringify(names(mail)) === JSON.stringify([...PLATFORM_TOOLS, "mail_list_accounts", "mail_read", "mail_search", "mail_send"].sort()),
    "mail tools are added when mail skill + bridge are active",
  );
  assert(JSON.stringify(names({ ...mail, connectorStatus: { mailConnected: false } })) === JSON.stringify(PLATFORM_TOOLS), "mail bridge unavailable hides only mail tools");
  assert(findBrokerTool(mail, "mail_send").annotations.destructiveHint === true, "mail_send remains destructive");
  assert(findBrokerTool(mail, "mail_search").inputSchema.limit.safeParse(100).success === false, "mail_search schema clamps limit");
  assert(
    findBrokerTool(mail, "mail_search").executionSurface === "mail_mcp" &&
    findBrokerTool(mail, "mail_search").mcpServerName === "mail",
    "mail tools should declare their execution surface instead of relying on central group mapping",
  );
  const mailConnectedStatus = await findBrokerTool(mail, "lily_capability_status").handler({}, mail);
  assert(
    mailConnectedStatus.toolDetails.some((tool) => (
      tool.name === "mail_search" &&
      tool.available === true &&
      tool.brokerHandlerAvailable === false &&
      tool.brokerHandlerError === "MAIL_BRIDGE_UNAVAILABLE" &&
      tool.executionSurface === "mail_mcp" &&
      tool.mcpServerName === "mail"
    )),
    "capability status should disclose visible tools whose broker handler is not wired",
  );

  const runtime = { sessionId: "s1", activeSkillIds: [] };
  assert(names(runtime).includes("runtime_pack_install"), "runtime-pack install is a platform tool, not gated by a skill");
  assert(findBrokerTool(runtime, "runtime_pack_install").annotations.destructiveHint === true, "runtime pack install is destructive");
  assert(findBrokerTool(runtime, "runtime_pack_install").inputSchema.repair.safeParse(true).success === true, "runtime pack install supports repair mode");
  assert(findBrokerTool(runtime, "runtime_pack_install").inputSchema.wait === undefined, "runtime pack install must not expose wait=true to agents");
  const runtimeInstallCalls = [];
  const backgroundInstall = await findBrokerTool(runtime, "runtime_pack_install").handler({
    packId: "libreoffice",
    repair: true,
    wait: true,
  }, runtime, {
    runtimePackInstaller: {
      startRuntimePackInstall: (packId, options) => {
        runtimeInstallCalls.push({ mode: "start", packId, options });
        return { ok: true, id: packId, jobId: "runtime_pack_job_1", started: true, installing: true };
      },
      installRuntimePack: () => {
        throw new Error("agent-facing broker tool must not run synchronous installs");
      },
    },
  });
  assert(
    backgroundInstall.ok === true &&
    backgroundInstall.jobId === "runtime_pack_job_1" &&
    runtimeInstallCalls[0]?.mode === "start" &&
    runtimeInstallCalls[0]?.options?.repair === true &&
    runtimeInstallCalls[0]?.options?.force === true,
    "runtime_pack_install should always use observable background repair to avoid MCP timeouts",
  );
  assert(
    findBrokerTool(runtime, "runtime_pack_install").executionSurface === "tool_broker" &&
    findBrokerTool(runtime, "runtime_pack_install").mcpServerName === "lily_tool_broker",
    "broker-native tools should declare their execution surface",
  );
  assert(findBrokerTool(runtime, "lily_capability_status").annotations.readOnlyHint === true, "capability status is read-only");
  const intentCommit = findBrokerTool(runtime, "lily_intent_contract_commit");
  assert(intentCommit?.annotations?.readOnlyHint === true, "intent contract commit is a bounded logical update, not an external side effect");
  const intentCandidate = await intentCommit.handler({
    objective: "fix the existing login flow",
    deliverables: ["verified fix"],
    successCriteria: ["regression test passes"],
  }, runtime);
  assert(
    intentCandidate.ok === true &&
    intentCandidate.intentContract.objective === "fix the existing login flow" &&
    intentCandidate.intentContract.successCriteria[0] === "regression test passes",
    "intent contract tool should return a structured candidate for main-process validation",
  );
  const runtimeStatus = await findBrokerTool(runtime, "lily_capability_status").handler({}, runtime);
  assert(
    runtimeStatus.toolDetails.some((tool) => (
      tool.name === "runtime_pack_install" &&
      tool.brokerHandlerAvailable === true &&
      tool.executionSurface === "tool_broker" &&
      tool.mcpServerName === "lily_tool_broker"
    )),
    "capability status should mark broker-native tools with the tool_broker execution surface",
  );
  const platformOnlyStatus = await findBrokerTool({ platformOnly: true, activeSkillIds: [] }, "lily_capability_status").handler({}, {
    platformOnly: true,
    activeSkillIds: [],
  });
  assert(
    platformOnlyStatus.unavailableTools.some((tool) => (
      tool.name === "mail_search" &&
      tool.reason === "SESSION_REQUIRED" &&
      tool.requiresSession === true &&
      tool.sessionAvailable === false
    )),
    "platform-only capability status should explain session-gated tools",
  );
  assert(
    platformOnlyStatus.toolDetails.some((tool) => (
      tool.name === "runtime_pack_list" &&
      tool.requiresSession === false &&
      tool.sessionAvailable === false &&
      tool.available === true &&
      tool.brokerHandlerAvailable === true
    )),
    "platform tools should stay available without a session",
  );

  const listResult = await findBrokerTool(runtime, "lily_capability_list").handler({}, runtime);
  assert(listResult.ok === true, "capability list should be callable");
  assert(Array.isArray(listResult.skillGraph), "capability list should expose the registry-derived skill graph");
  assert(
    listResult.skillGraph.some((skill) => skill.id === "anthropics-xlsx" && skill.requiredRuntimePacks.includes("libreoffice")),
    "capability list should expose bundled office skills with runtime packs",
  );
  assert(
    listResult.skillGraph.some((skill) => skill.id === "lily-office-intent" && skill.kind === "router"),
    "capability list should expose router skills",
  );
  assert(
    listResult.runtimePacks.evaluated === false,
    "unfocused capability list should mark runtime pack status as not evaluated",
  );
  const pdfListResult = await findBrokerTool(runtime, "lily_capability_list").handler({
    query: "提取 PDF 表格",
    files: [{ name: "contract.pdf" }],
  }, runtime);
  assert(pdfListResult.runtimePacks.evaluated === true, "focused capability list should evaluate runtime pack status");
  assert(
    pdfListResult.skillGraph.some((skill) => skill.id === "anthropics-pdf"),
    "capability list query should recommend PDF skills",
  );
  assert(
    !pdfListResult.skillGraph.some((skill) => skill.id === "anthropics-xlsx"),
    "capability list query should omit unrelated spreadsheet skills",
  );
  const activeUnrelatedListResult = await findBrokerTool(runtime, "lily_capability_list").handler({
    query: "提取 PDF 表格",
    files: [{ name: "contract.pdf" }],
  }, { ...runtime, activeSkillIds: ["lily-mail-assistant"] });
  assert(
    !activeUnrelatedListResult.skillGraph.some((skill) => skill.id === "lily-mail-assistant"),
    "capability list query should not include active but unrelated skills",
  );
  const pdfFormListResult = await findBrokerTool(runtime, "lily_capability_list").handler({
    query: "填写 PDF 表单并校验必填字段",
    files: [{ name: "visa-form.pdf" }],
  }, runtime);
  assert(
    pdfFormListResult.skillGraph.some((skill) => skill.id === "lily-pdf-form"),
    "capability list query should recommend PDF form skills",
  );
  const draftListResult = await findBrokerTool(runtime, "lily_capability_list").handler({
    query: "写一份结构化项目提案文档",
  }, runtime);
  assert(
    draftListResult.skillGraph.some((skill) => skill.id === "anthropics-doc-coauthoring"),
    "capability list query should recommend document coauthoring skills",
  );
  const documentQueryListResult = await findBrokerTool(runtime, "lily_capability_list").handler({
    query: "查询这份合同文档里的付款条件并引用证据",
    files: [{ name: "contract.docx" }],
  }, runtime);
  assert(
    documentQueryListResult.skillGraph[0]?.id === "lily-document-query",
    "capability list query should put document evidence lookup first",
  );
  assert(
    !documentQueryListResult.skillGraph.some((skill) => skill.id === "lily-template-fill"),
    "capability list document query should omit template filling",
  );
  const pptQaListResult = await findBrokerTool(runtime, "lily_capability_list").handler({
    query: "检查这个 PPT 是否有文字溢出、版式问题并导出 QA 报告",
    files: [{ name: "training.pptx" }],
  }, runtime);
  assert(
    pptQaListResult.skillGraph[0]?.id === "lily-ppt-design-qa",
    "capability list query should put PPT design QA first",
  );
  assert(
    !pptQaListResult.skillGraph.some((skill) => skill.id === "anthropics-docx"),
    "capability list PPT QA should omit DOCX tooling",
  );
  const pptExportListResult = await findBrokerTool(runtime, "lily_capability_list").handler({
    query: "把这份 PPT 转成 PDF 并检查版面",
    files: [{ name: "training.pptx" }],
  }, runtime);
  assert(
    pptExportListResult.skillGraph.some((skill) => skill.id === "anthropics-pptx"),
    "capability list PPT export should include PPTX tooling",
  );
  assert(
    !pptExportListResult.skillGraph.some((skill) => skill.id === "lily-pdf-extraction-router"),
    "capability list PPT export should omit PDF extraction routing",
  );
  const spreadsheetListResult = await findBrokerTool(runtime, "lily_capability_list").handler({
    query: "分析这个 Excel 销售数据，生成透视汇总和柱状图",
    files: [{ name: "sales.xlsx" }],
  }, runtime);
  assert(
    spreadsheetListResult.skillGraph[0]?.id === "lily-excel-data-analysis",
    "capability list spreadsheet analysis should put Excel analysis first",
  );
  assert(
    spreadsheetListResult.skillGraph.some((skill) => skill.id === "anthropics-xlsx"),
    "capability list spreadsheet analysis should retain spreadsheet tooling",
  );
  const spreadsheetPackStatusResult = await findBrokerTool(runtime, "lily_capability_list").handler({
    query: "分析这个 Excel 销售数据，生成透视汇总和柱状图",
    files: [{ name: "sales.xlsx" }],
  }, runtime, {
    installedRuntimePackIds: () => new Set(["libreoffice"]),
  });
  assert(
    spreadsheetPackStatusResult.runtimePacks.requiredByRecommendedSkills.some((item) => (
      item.skillId === "lily-excel-data-analysis" &&
      item.required.includes("libreoffice") &&
      item.required.includes("large-document") &&
      item.missing.includes("large-document") &&
      !item.missing.includes("libreoffice")
    )),
    "capability list should explain missing runtime packs for recommended skills",
  );
  assert(
    spreadsheetPackStatusResult.runtimePacks.missing.includes("large-document"),
    "capability list should summarize missing runtime packs for focused recommendations",
  );
  assert(
    spreadsheetPackStatusResult.runtimePacks.missingDetails.some((pack) => (
      pack.id === "large-document" &&
      pack.category === "document" &&
      pack.label?.["zh-CN"] === "大文件文档引擎" &&
      typeof pack.sizeEstimate === "string" &&
      pack.sizeEstimate.length > 0 &&
      pack.installAction?.tool === "runtime_pack_install" &&
      pack.installAction?.args?.packId === "large-document" &&
      pack.installAction?.destructive === true &&
      pack.installAction?.requiresConfirmation === true
    )),
    "capability list should include metadata and install action for missing recommended runtime packs",
  );
  assert(
    spreadsheetPackStatusResult.runtimePacks.installToolAvailable === true,
    "capability list should say when the runtime-pack install tool is available",
  );
  const runtimeInstallListResult = await findBrokerTool(runtime, "lily_capability_list").handler({
    query: "安装处理大型 PDF 的 OCR 和 Docling 依赖包",
  }, runtime);
  assert(
    runtimeInstallListResult.skillGraph[0]?.id === "lily-runtime-packs",
    "capability list runtime install should put runtime packs first",
  );
  assert(
    runtimeInstallListResult.skillGraph.some((skill) => skill.id === "lily-pdf-extraction-router"),
    "capability list runtime install should retain PDF routing context",
  );
  const imageOcrListResult = await findBrokerTool(runtime, "lily_capability_list").handler({
    query: "对这张扫描件做 OCR 并提取文字",
    files: [{ name: "scan.png" }],
  }, runtime);
  assert(
    imageOcrListResult.skillGraph[0]?.id === "lily-runtime-packs",
    "capability list image OCR should put OCR/runtime support first",
  );
  assert(
    !imageOcrListResult.skillGraph.some((skill) => skill.id === "lily-pdf-extraction-router" || skill.id === "anthropics-pdf"),
    "capability list image OCR should omit PDF extraction and PDF tooling",
  );
  const imageCreateListResult = await findBrokerTool(runtime, "lily_capability_list").handler({
    query: "生成一张产品海报图片，适合小红书封面",
  }, runtime);
  assert(
    imageCreateListResult.skillGraph[0]?.id === "lily-creative-director",
    "capability list image generation should put creative direction first",
  );
  assert(
    imageCreateListResult.skillGraph.some((skill) => skill.id === "lily-prompt-enhancer"),
    "capability list image generation should retain prompt enhancement",
  );
  const promptEnhanceListResult = await findBrokerTool(runtime, "lily_capability_list").handler({
    query: "帮我把这个图片生成提示词写得更专业",
  }, runtime);
  assert(
    promptEnhanceListResult.skillGraph[0]?.id === "lily-prompt-enhancer",
    "capability list prompt writing should put prompt enhancement first",
  );
  const browserQaListResult = await findBrokerTool(runtime, "lily_capability_list").handler({
    query: "测试这个网页是否有 console error 和按钮失效问题",
  }, runtime);
  assert(
    browserQaListResult.skillGraph[0]?.id === "lily-browser-qa",
    "capability list web QA should put browser QA first",
  );
  assert(
    !browserQaListResult.skillGraph.some((skill) => skill.id === "lily-web-system-learning"),
    "capability list web QA should omit high-risk learning",
  );
  const browserQaPackStatus = await findBrokerTool(runtime, "lily_capability_list").handler({
    query: "测试这个网页是否有 console error 和按钮失效问题",
  }, runtime, {
    installedRuntimePackIds: () => new Set(),
  });
  assert(
    browserQaPackStatus.runtimePacks.missing.includes("web-automation"),
    "capability list should name the Web Automation pack required by Browser QA",
  );
  const localSmokeListResult = await findBrokerTool(runtime, "lily_capability_list").handler({
    query: "打开 localhost:3000 做前端冒烟测试",
  }, runtime);
  assert(
    localSmokeListResult.skillGraph[0]?.id === "lily-browser-qa",
    "capability list localhost smoke test should put browser QA first",
  );
  const webLearningListResult = await findBrokerTool(runtime, "lily_capability_list").handler({
    query: "学习这个后台系统，以后用自然语言操作",
  }, runtime);
  assert(
    webLearningListResult.skillGraph[0]?.id === "lily-web-system-learning",
    "capability list web learning should put the learning connector first",
  );
  const stockResearchListResult = await findBrokerTool(runtime, "lily_capability_list").handler({
    query: "研究一下英伟达股票，给我估值、风险和引用来源",
  }, runtime);
  assert(
    stockResearchListResult.skillGraph[0]?.id === "lily-stock-research",
    "capability list stock research should put stock research first",
  );
  assert(
    !stockResearchListResult.skillGraph.some((skill) => skill.id === "lily-document-query"),
    "capability list stock research should omit document query without files",
  );
  const researchListResult = await findBrokerTool(runtime, "lily_capability_list").handler({
    query: "帮我做竞品研究，比较三家产品并给证据来源",
  }, runtime);
  assert(
    researchListResult.skillGraph[0]?.id === "lily-research-synthesis",
    "capability list source research should put research synthesis first",
  );
  const skillQualityListResult = await findBrokerTool(runtime, "lily_capability_list").handler({
    query: "检查这个技能是否符合质量门槛和能力契约",
  }, runtime);
  assert(
    skillQualityListResult.skillGraph[0]?.id === "lily-skill-quality-gate",
    "capability list skill review should put skill quality first",
  );
  const intentEvalListResult = await findBrokerTool(runtime, "lily_capability_list").handler({
    query: "评估这句话应该触发哪个意图和技能",
  }, runtime);
  assert(
    intentEvalListResult.skillGraph[0]?.id === "lily-intent-eval",
    "capability list intent routing tests should put intent eval first",
  );
  const pdfReadListResult = await findBrokerTool(runtime, "lily_capability_list").handler({
    query: "读取并总结这个 PDF 文件",
    files: [{ name: "paper.pdf" }],
  }, runtime);
  assert(
    pdfReadListResult.skillGraph[0]?.id === "anthropics-pdf",
    "capability list PDF read/summary should put PDF tooling first",
  );
  const docxReadListResult = await findBrokerTool(runtime, "lily_capability_list").handler({
    query: "读取这个 Word 文档并总结要点",
    files: [{ name: "report.docx" }],
  }, runtime);
  assert(
    docxReadListResult.skillGraph[0]?.id === "anthropics-docx",
    "capability list DOCX read/summary should put DOCX tooling first",
  );
  const evidenceLookupListResult = await findBrokerTool(runtime, "lily_capability_list").handler({
    query: "查询这份合同文档里的付款条件并引用证据",
    files: [{ name: "contract.docx" }],
  }, runtime);
  assert(
    evidenceLookupListResult.skillGraph[0]?.id === "lily-document-query",
    "capability list evidence lookup should still put document query first",
  );
  const mailListResult = await findBrokerTool(runtime, "lily_capability_list").handler({
    query: "给我写一封邮件回复客户，语气专业",
  }, runtime);
  assert(
    mailListResult.skillGraph[0]?.id === "lily-mail-assistant",
    "capability list mail drafting should put mail assistant first",
  );
  const uiQualityListResult = await findBrokerTool(runtime, "lily_capability_list").handler({
    query: "检查这个页面的 UI 质量、间距、层级和视觉一致性",
  }, runtime);
  assert(
    uiQualityListResult.skillGraph[0]?.id === "lily-ui-quality",
    "capability list UI quality review should put UI quality first",
  );
  assert(
    uiQualityListResult.skillGraph.some((skill) => skill.id === "lily-browser-qa"),
    "capability list UI quality review should retain browser QA support",
  );
  const codeRepairListResult = await findBrokerTool(runtime, "lily_capability_list").handler({
    query: "修复这个报错：TypeError cannot read property of undefined",
  }, runtime);
  assert(
    codeRepairListResult.skillGraph[0]?.id === "lily-code-repair",
    "capability list runtime error repair should put code repair first",
  );
  const appBuilderListResult = await findBrokerTool(runtime, "lily_capability_list").handler({
    query: "帮我做一个 CRM 管理后台应用，包含客户列表和统计看板",
  }, runtime);
  assert(
    appBuilderListResult.skillGraph[0]?.id === "lily-app-builder",
    "capability list app creation should put app builder first",
  );
  assert(
    appBuilderListResult.skillGraph.some((skill) => skill.id === "lily-coding-core"),
    "capability list app creation should retain coding core support",
  );
  const codingCoreListResult = await findBrokerTool(runtime, "lily_capability_list").handler({
    query: "实现一个登录表单组件并接入校验逻辑",
  }, runtime);
  assert(
    codingCoreListResult.skillGraph[0]?.id === "lily-coding-core",
    "capability list component implementation should put coding core first",
  );
  const engineeringRulesListResult = await findBrokerTool(runtime, "lily_capability_list").handler({
    query: "按工程规范审查这个实现方案，避免过度设计和能力退化",
  }, runtime);
  assert(
    engineeringRulesListResult.skillGraph[0]?.id === "lily-engineering-rules",
    "capability list engineering discipline review should put engineering rules first",
  );
  const scriptBuilderListResult = await findBrokerTool(runtime, "lily_capability_list").handler({
    query: "写一个脚本批量重命名这些文件",
  }, runtime);
  assert(
    scriptBuilderListResult.skillGraph[0]?.id === "lily-app-builder",
    "capability list script creation should put app builder first",
  );
  const pdfCreateListResult = await findBrokerTool(runtime, "lily_capability_list").handler({
    query: "创建一个新的 PDF 报告并加水印",
  }, runtime);
  assert(
    pdfCreateListResult.skillGraph[0]?.id === "anthropics-pdf",
    "capability list PDF creation should put PDF tooling first",
  );
  assert(
    !pdfCreateListResult.skillGraph.some((skill) => skill.id === "lily-app-builder"),
    "capability list PDF creation should omit app builder",
  );
  const wordCreateListResult = await findBrokerTool(runtime, "lily_capability_list").handler({
    query: "创建一份带目录和页码的 Word 报告",
  }, runtime);
  assert(
    wordCreateListResult.skillGraph[0]?.id === "anthropics-doc-coauthoring",
    "capability list Word report creation should put document coauthoring first",
  );
  const pptCreateListResult = await findBrokerTool(runtime, "lily_capability_list").handler({
    query: "创建一个 PowerPoint 培训课件",
  }, runtime);
  assert(
    pptCreateListResult.skillGraph[0]?.id === "anthropics-pptx",
    "capability list PowerPoint creation should put PPTX tooling first",
  );
  const templateFillListResult = await findBrokerTool(runtime, "lily_capability_list").handler({
    query: "用这个 Word 模板批量填充客户信息生成合同",
    files: [{ name: "contract-template.docx" }],
  }, runtime);
  assert(
    templateFillListResult.skillGraph[0]?.id === "lily-template-fill",
    "capability list template fill should put template filling first",
  );
  const mediaTranscodeListResult = await findBrokerTool(runtime, "lily_capability_list").handler({
    query: "剪辑这个视频并转码成 mp4",
    files: [{ name: "clip.mov" }],
  }, runtime);
  assert(
    mediaTranscodeListResult.skillGraph[0]?.id === "lily-runtime-packs",
    "capability list media transcode should put runtime packs first",
  );
  assert(
    !mediaTranscodeListResult.skillGraph.some((skill) => skill.id === "lily-creative-director"),
    "capability list media transcode should omit creative prompt direction",
  );

  const statusResult = await findBrokerTool(runtime, "lily_capability_status").handler({}, {
    ...runtime,
    activeSkillIds: ["lily-office-intent", "anthropics-xlsx"],
  });
  assert(Array.isArray(statusResult.activeSkillGraph), "capability status should expose active skill graph");
  assert(
    statusResult.activeSkillGraph.some((skill) => skill.id === "anthropics-xlsx"),
    "capability status should include active catalog skills",
  );
  const runtimeDependencyStatus = await findBrokerTool(runtime, "lily_capability_status").handler({}, {
    ...runtime,
    activeSkillIds: ["anthropics-xlsx"],
  }, {
    installedRuntimePackIds: () => new Set(["libreoffice"]),
    runtimePackHealth: async () => ({ ok: true, status: "ok" }),
  });
  assert(
    runtimeDependencyStatus.runtimePacks.requiredByActiveSkills.some((item) => (
      item.skillId === "anthropics-xlsx" &&
      item.required.includes("libreoffice") &&
      item.required.includes("large-document") &&
      item.missing.includes("large-document") &&
      !item.missing.includes("libreoffice")
    )),
    "capability status should explain missing runtime packs for active skills",
  );
  assert(
    runtimeDependencyStatus.runtimePacks.missing.includes("large-document"),
    "capability status should summarize missing runtime packs across active skills",
  );
  assert(
    runtimeDependencyStatus.runtimePacks.missingDetails.some((pack) => (
      pack.id === "large-document" &&
      pack.category === "document" &&
      pack.label?.["zh-CN"] === "大文件文档引擎" &&
      typeof pack.sizeEstimate === "string" &&
      pack.sizeEstimate.length > 0 &&
      pack.installAction?.tool === "runtime_pack_install" &&
      pack.installAction?.args?.packId === "large-document" &&
      pack.installAction?.destructive === true &&
      pack.installAction?.requiresConfirmation === true
    )),
    "capability status should include metadata and install action for missing active-skill runtime packs",
  );
  const unhealthyRuntimeDependencyStatus = await findBrokerTool(runtime, "lily_capability_status").handler({}, {
    ...runtime,
    activeSkillIds: ["anthropics-xlsx"],
  }, {
    installedRuntimePackIds: () => new Set(["libreoffice"]),
    runtimePackHealth: async (id) => (
      id === "libreoffice"
        ? { ok: false, status: "failed", error: "EXECUTABLE_MISSING", checks: [{ id: "libreoffice:soffice", ok: false, error: "EXECUTABLE_MISSING" }] }
        : { ok: true, status: "ok" }
    ),
  });
  assert(
    unhealthyRuntimeDependencyStatus.runtimePacks.missing.includes("libreoffice"),
    "unhealthy installed runtime packs should be treated as missing for active skill readiness",
  );
  assert(
    unhealthyRuntimeDependencyStatus.runtimePacks.missingDetails.some((pack) => (
      pack.id === "libreoffice" &&
      pack.installed === true &&
      pack.health?.ok === false &&
      pack.health?.error === "EXECUTABLE_MISSING" &&
      pack.installAction?.args?.repair === true
    )),
    "capability status should expose why an installed runtime pack is unusable and provide a repair action",
  );
  const mailBridgeBlockedStatus = await findBrokerTool(runtime, "lily_capability_status").handler({}, {
    ...runtime,
    activeSkillIds: ["lily-mail-assistant"],
    connectorStatus: { mailConnected: false },
  });
  assert(!mailBridgeBlockedStatus.tools.includes("mail_search"), "blocked mail tools should remain hidden from available tool names");
  assert(
    mailBridgeBlockedStatus.unavailableTools.some((tool) => tool.name === "mail_search" && tool.reason === "MAIL_BRIDGE_UNAVAILABLE"),
    "capability status should explain when a mail tool is blocked by the mail bridge",
  );
  assert(
    mailBridgeBlockedStatus.unavailableTools.some((tool) => (
      tool.name === "mail_search" &&
      tool.connectorStatusKey === "mailConnected" &&
      tool.connectorStatusValue === false
    )),
    "capability status should name the connector status key that blocks unavailable connector tools",
  );
  assert(
    mailBridgeBlockedStatus.unavailableTools.some((tool) => (
      tool.name === "mail_search" &&
      typeof tool.description === "string" &&
      tool.description.includes("Search a connected mailbox")
    )),
    "capability status should include descriptions for unavailable tools",
  );
  const inactiveMailStatus = await findBrokerTool(runtime, "lily_capability_status").handler({}, {
    ...runtime,
    activeSkillIds: [],
    connectorStatus: { mailConnected: true },
  });
  assert(
    inactiveMailStatus.unavailableTools.some((tool) => tool.name === "mail_search" && tool.reason === "SKILL_NOT_ACTIVE"),
    "capability status should distinguish inactive skills from unavailable connectors",
  );
  assert(
    inactiveMailStatus.unavailableTools.some((tool) => (
      tool.name === "mail_search" &&
      Array.isArray(tool.missingSkillIds) &&
      tool.missingSkillIds.length === 1 &&
      tool.missingSkillIds[0] === "lily-mail-assistant"
    )),
    "capability status should name missing skills for inactive tool gates",
  );

  const browser = { sessionId: "s1", activeSkillIds: ["lily-browser-qa"], runtime: { browserAvailable: true } };
  assert(JSON.stringify(names(browser)) === JSON.stringify([...PLATFORM_TOOLS, "browser_open"].sort()), "browser tool visible when runtime exists");
  const browserRuntimeAvailableStatus = await findBrokerTool(runtime, "lily_capability_status").handler({}, browser);
  assert(
    browserRuntimeAvailableStatus.toolDetails.some((tool) => (
      tool.name === "browser_open" &&
      tool.executionSurface === "browser_runtime" &&
      tool.mcpServerName === "playwright"
    )),
    "browser capability status should direct execution to the registered Playwright MCP server",
  );
  assert(JSON.stringify(names({ ...browser, runtime: { browserAvailable: false } })) === JSON.stringify(PLATFORM_TOOLS), "browser tool hidden when runtime missing");
  const browserRuntimeBlockedStatus = await findBrokerTool(runtime, "lily_capability_status").handler({}, {
    ...browser,
    runtime: { browserAvailable: false },
  });
  assert(
    browserRuntimeBlockedStatus.unavailableTools.some((tool) => tool.name === "browser_open" && tool.reason === "BROWSER_RUNTIME_UNAVAILABLE"),
    "capability status should explain when browser tools are blocked by runtime availability",
  );
  assert(
    browserRuntimeBlockedStatus.unavailableTools.some((tool) => (
      tool.name === "browser_open" &&
      tool.runtimeStatusKey === "browserAvailable" &&
      tool.runtimeStatusValue === false
    )),
    "capability status should name the runtime status key that blocks unavailable runtime tools",
  );

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lily-broker-registry-"));
  const on = path.join(tmp, "learned-on");
  const off = path.join(tmp, "learned-off");
  for (const dir of [on, off]) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "web-system-playbook.json"), "{}");
    fs.writeFileSync(path.join(dir, "capability-map.json"), JSON.stringify({
      systemId: path.basename(dir),
      systemName: path.basename(dir),
      capabilities: [{
        id: "web.query",
        title: "Query",
        risk: "read",
        params: { required: ["q"], properties: { q: { type: "string", label: "Query" } } },
      }],
    }));
  }
  try {
    const learned = {
      sessionId: "s1",
      activeSkillIds: ["learned-on"],
    };
    const deps = { learnedWebSystemDirs: () => [on, off] };
    const learnedNames = names(learned, deps);
    assert(JSON.stringify(learnedNames) === JSON.stringify([...PLATFORM_TOOLS, "learned_on__query"].sort()), `only active learned system visible, got ${learnedNames.join(",")}`);
    assert(findBrokerTool(learned, "learned_on__query", deps).annotations.readOnlyHint === true, "learned read tool carries annotation");
    const learnedCapabilityList = await findBrokerTool(learned, "lily_capability_list", deps).handler({}, learned, deps);
    assert(
      learnedCapabilityList.tools.some((tool) => tool.name === "learned_on__query" && tool.group === "learned-web-system"),
      "capability list should include active learned web-system tools",
    );
    const learnedStatus = await findBrokerTool(learned, "lily_capability_status", deps).handler({}, learned, deps);
    assert(
      learnedStatus.tools.includes("learned_on__query"),
      "capability status should include active learned web-system tool names",
    );
    assert(
      learnedStatus.toolDetails.some((tool) => (
        tool.name === "learned_on__query" &&
        tool.available === true &&
        tool.group === "learned-web-system" &&
        tool.executionSurface === "learned_web_system_mcp" &&
        tool.mcpServerName === "web_learned_on"
      )),
      "capability status should include active learned web-system tool details",
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  console.log("PASS: test-tool-broker-registry (90 tests)");
} catch (err) {
  console.error("FAIL:", err.message);
  process.exit(1);
}
