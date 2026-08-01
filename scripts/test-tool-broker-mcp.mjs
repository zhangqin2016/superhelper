#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const require = createRequire(import.meta.url);
const { createToolBrokerMcpServer } = require("../src/main/mcp/tool-broker-mcp.js");

// Deterministic character-worlds gating: the draft tool honors the env kill
// switch before any policy resolution, so pin it here (spawned stdio brokers
// inherit it via the env spreads below) instead of depending on the machine's
// real remote-config cache. Draft-enabled behavior is covered end-to-end in
// test-character-agent-draft.mjs.
process.env.LILY_CHARACTER_WORLDS = "0";

async function clientForServer(server) {
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  const client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(ct);
  return client;
}

{
  let context = {
    sessionId: "s1",
    activeSkillIds: ["lily-runtime-packs", "lily-mail-assistant"],
    connectorStatus: { mailConnected: false },
  };
  const server = await createToolBrokerMcpServer({ contextProvider: async () => context });
  const client = await clientForServer(server);

  const { tools } = await client.listTools();
  assert.deepEqual(
    tools.map((tool) => tool.name).sort(),
    ["lily_capability_list", "lily_capability_status", "lily_intent_contract_commit", "runtime_pack_install", "runtime_pack_list"],
    "tools/list always exposes platform capabilities",
  );
  assert.ok(!tools.some((tool) => tool.name.startsWith("mail_")), "mail tools hidden when bridge is unavailable");

  const intentResult = await client.callTool({
    name: "lily_intent_contract_commit",
    arguments: {
      objective: "fix the existing login flow",
      deliverables: ["verified fix"],
      successCriteria: ["regression test passes"],
    },
  });
  const intentBody = JSON.parse(intentResult.content[0].text);
  assert.equal(intentBody.ok, true, "intent contract candidate should travel through the real MCP surface");
  assert.equal(intentBody.intentContract.objective, "fix the existing login flow");

  const capabilityResult = await client.callTool({ name: "lily_capability_list", arguments: {} });
  const capabilityBody = JSON.parse(capabilityResult.content[0].text);
  assert.equal(capabilityBody.ok, true, "capability list call succeeds through MCP");
  assert.ok(
    capabilityBody.skillGraph.some((skill) => skill.id === "anthropics-xlsx" && skill.requiredRuntimePacks.includes("libreoffice")),
    "capability list exposes catalog skill graph through MCP",
  );
  assert.equal(capabilityBody.runtimePacks.evaluated, false, "unfocused capability list marks runtime pack status as not evaluated through MCP");
  const focusedCapabilityResult = await client.callTool({
    name: "lily_capability_list",
    arguments: { query: "提取 PDF 表格", files: [{ name: "contract.pdf" }] },
  });
  const focusedCapabilityBody = JSON.parse(focusedCapabilityResult.content[0].text);
  assert.equal(focusedCapabilityBody.runtimePacks.evaluated, true, "focused capability list evaluates runtime pack status through MCP");
  assert.ok(
    focusedCapabilityBody.skillGraph.some((skill) => skill.id === "anthropics-pdf"),
    "focused capability list exposes matching PDF skill through MCP",
  );
  assert.ok(
    !focusedCapabilityBody.skillGraph.some((skill) => skill.id === "anthropics-xlsx"),
    "focused capability list omits unrelated spreadsheet skill through MCP",
  );
  assert.ok(
    !focusedCapabilityBody.skillGraph.some((skill) => skill.id === "lily-mail-assistant"),
    "focused capability list omits active but unrelated mail skill through MCP",
  );
  const capabilityStatusResult = await client.callTool({ name: "lily_capability_status", arguments: {} });
  const capabilityStatusBody = JSON.parse(capabilityStatusResult.content[0].text);
  assert.ok(!capabilityStatusBody.tools.includes("mail_search"), "capability status keeps unavailable mail tools out of available names through MCP");
  assert.ok(
    capabilityStatusBody.unavailableTools.some((tool) => tool.name === "mail_search" && tool.reason === "MAIL_BRIDGE_UNAVAILABLE"),
    "capability status explains unavailable mail tools through MCP",
  );
  assert.ok(
    capabilityStatusBody.unavailableTools.some((tool) => (
      tool.name === "mail_search" &&
      tool.connectorStatusKey === "mailConnected" &&
      tool.connectorStatusValue === false
    )),
    "capability status names connector status keys through MCP",
  );
  assert.ok(
    capabilityStatusBody.unavailableTools.some((tool) => (
      tool.name === "mail_search" &&
      typeof tool.description === "string" &&
      tool.description.includes("Search a connected mailbox")
    )),
    "capability status includes unavailable tool descriptions through MCP",
  );
  context = { ...context, connectorStatus: { mailConnected: true } };
  const connectedStatusResult = await client.callTool({ name: "lily_capability_status", arguments: {} });
  const connectedStatusBody = JSON.parse(connectedStatusResult.content[0].text);
  assert.ok(
    connectedStatusBody.toolDetails.some((tool) => (
      tool.name === "mail_search" &&
      tool.available === true &&
      tool.brokerHandlerAvailable === false &&
      tool.brokerHandlerError === "MAIL_BRIDGE_UNAVAILABLE" &&
      tool.executionSurface === "mail_mcp"
    )),
    "capability status discloses visible tools whose broker handler is not wired through MCP",
  );
  context = { ...context, connectorStatus: { mailConnected: false } };
  const focusedFormResult = await client.callTool({
    name: "lily_capability_list",
    arguments: { query: "填写 PDF 表单并校验必填字段", files: [{ name: "visa-form.pdf" }] },
  });
  const focusedFormBody = JSON.parse(focusedFormResult.content[0].text);
  assert.ok(
    focusedFormBody.skillGraph.some((skill) => skill.id === "lily-pdf-form"),
    "focused capability list exposes matching PDF form skill through MCP",
  );
  const focusedDocumentQueryResult = await client.callTool({
    name: "lily_capability_list",
    arguments: { query: "查询这份合同文档里的付款条件并引用证据", files: [{ name: "contract.docx" }] },
  });
  const focusedDocumentQueryBody = JSON.parse(focusedDocumentQueryResult.content[0].text);
  assert.equal(
    focusedDocumentQueryBody.skillGraph[0]?.id,
    "lily-document-query",
    "focused capability list puts document evidence lookup first through MCP",
  );
  assert.ok(
    !focusedDocumentQueryBody.skillGraph.some((skill) => skill.id === "lily-template-fill"),
    "focused capability list omits template filling for document evidence lookup through MCP",
  );
  const focusedPptQaResult = await client.callTool({
    name: "lily_capability_list",
    arguments: { query: "检查这个 PPT 是否有文字溢出、版式问题并导出 QA 报告", files: [{ name: "training.pptx" }] },
  });
  const focusedPptQaBody = JSON.parse(focusedPptQaResult.content[0].text);
  assert.equal(
    focusedPptQaBody.skillGraph[0]?.id,
    "lily-ppt-design-qa",
    "focused capability list puts PPT design QA first through MCP",
  );
  assert.ok(
    !focusedPptQaBody.skillGraph.some((skill) => skill.id === "anthropics-docx"),
    "focused capability list omits DOCX tooling for PPT QA through MCP",
  );
  const focusedSpreadsheetResult = await client.callTool({
    name: "lily_capability_list",
    arguments: { query: "分析这个 Excel 销售数据，生成透视汇总和柱状图", files: [{ name: "sales.xlsx" }] },
  });
  const focusedSpreadsheetBody = JSON.parse(focusedSpreadsheetResult.content[0].text);
  assert.equal(
    focusedSpreadsheetBody.skillGraph[0]?.id,
    "lily-excel-data-analysis",
    "focused capability list puts Excel analysis first through MCP",
  );
  assert.ok(
    focusedSpreadsheetBody.skillGraph.some((skill) => skill.id === "anthropics-xlsx"),
    "focused capability list retains spreadsheet tooling through MCP",
  );
  const focusedRuntimeResult = await client.callTool({
    name: "lily_capability_list",
    arguments: { query: "安装处理大型 PDF 的 OCR 和 Docling 依赖包" },
  });
  const focusedRuntimeBody = JSON.parse(focusedRuntimeResult.content[0].text);
  assert.equal(
    focusedRuntimeBody.skillGraph[0]?.id,
    "lily-runtime-packs",
    "focused capability list puts runtime packs first through MCP",
  );
  assert.ok(
    focusedRuntimeBody.skillGraph.some((skill) => skill.id === "lily-pdf-extraction-router"),
    "focused capability list retains PDF routing context for runtime install through MCP",
  );
  const focusedImageOcrResult = await client.callTool({
    name: "lily_capability_list",
    arguments: { query: "对这张扫描件做 OCR 并提取文字", files: [{ name: "scan.png" }] },
  });
  const focusedImageOcrBody = JSON.parse(focusedImageOcrResult.content[0].text);
  assert.equal(
    focusedImageOcrBody.skillGraph[0]?.id,
    "lily-runtime-packs",
    "focused capability list puts image OCR runtime support first through MCP",
  );
  assert.ok(
    !focusedImageOcrBody.skillGraph.some((skill) => skill.id === "lily-pdf-extraction-router" || skill.id === "anthropics-pdf"),
    "focused capability list omits PDF routing for image OCR through MCP",
  );
  const focusedImageCreateResult = await client.callTool({
    name: "lily_capability_list",
    arguments: { query: "生成一张产品海报图片，适合小红书封面" },
  });
  const focusedImageCreateBody = JSON.parse(focusedImageCreateResult.content[0].text);
  assert.equal(
    focusedImageCreateBody.skillGraph[0]?.id,
    "lily-creative-director",
    "focused capability list puts creative direction first through MCP",
  );
  assert.ok(
    focusedImageCreateBody.skillGraph.some((skill) => skill.id === "lily-prompt-enhancer"),
    "focused capability list retains prompt enhancement through MCP",
  );
  const focusedPromptResult = await client.callTool({
    name: "lily_capability_list",
    arguments: { query: "帮我把这个图片生成提示词写得更专业" },
  });
  const focusedPromptBody = JSON.parse(focusedPromptResult.content[0].text);
  assert.equal(
    focusedPromptBody.skillGraph[0]?.id,
    "lily-prompt-enhancer",
    "focused capability list puts prompt enhancement first through MCP",
  );
  const focusedBrowserQaResult = await client.callTool({
    name: "lily_capability_list",
    arguments: { query: "测试这个网页是否有 console error 和按钮失效问题" },
  });
  const focusedBrowserQaBody = JSON.parse(focusedBrowserQaResult.content[0].text);
  assert.equal(
    focusedBrowserQaBody.skillGraph[0]?.id,
    "lily-browser-qa",
    "focused capability list puts browser QA first through MCP",
  );
  assert.ok(
    !focusedBrowserQaBody.skillGraph.some((skill) => skill.id === "lily-web-system-learning"),
    "focused capability list omits high-risk learning for web QA through MCP",
  );
  const focusedWebLearningResult = await client.callTool({
    name: "lily_capability_list",
    arguments: { query: "学习这个后台系统，以后用自然语言操作" },
  });
  const focusedWebLearningBody = JSON.parse(focusedWebLearningResult.content[0].text);
  assert.equal(
    focusedWebLearningBody.skillGraph[0]?.id,
    "lily-web-system-learning",
    "focused capability list puts web learning first through MCP",
  );
  const focusedStockResult = await client.callTool({
    name: "lily_capability_list",
    arguments: { query: "研究一下英伟达股票，给我估值、风险和引用来源" },
  });
  const focusedStockBody = JSON.parse(focusedStockResult.content[0].text);
  assert.equal(
    focusedStockBody.skillGraph[0]?.id,
    "lily-stock-research",
    "focused capability list puts stock research first through MCP",
  );
  assert.ok(
    !focusedStockBody.skillGraph.some((skill) => skill.id === "lily-document-query"),
    "focused capability list omits document query for stock research without files",
  );
  const focusedResearchResult = await client.callTool({
    name: "lily_capability_list",
    arguments: { query: "帮我做竞品研究，比较三家产品并给证据来源" },
  });
  const focusedResearchBody = JSON.parse(focusedResearchResult.content[0].text);
  assert.equal(
    focusedResearchBody.skillGraph[0]?.id,
    "lily-research-synthesis",
    "focused capability list puts source research first through MCP",
  );
  const focusedIntentResult = await client.callTool({
    name: "lily_capability_list",
    arguments: { query: "评估这句话应该触发哪个意图和技能" },
  });
  const focusedIntentBody = JSON.parse(focusedIntentResult.content[0].text);
  assert.equal(
    focusedIntentBody.skillGraph[0]?.id,
    "lily-intent-eval",
    "focused capability list puts intent eval first through MCP",
  );
  const focusedPdfReadResult = await client.callTool({
    name: "lily_capability_list",
    arguments: { query: "读取并总结这个 PDF 文件", files: [{ name: "paper.pdf" }] },
  });
  const focusedPdfReadBody = JSON.parse(focusedPdfReadResult.content[0].text);
  assert.equal(
    focusedPdfReadBody.skillGraph[0]?.id,
    "anthropics-pdf",
    "focused capability list puts PDF tooling first for read/summary through MCP",
  );
  const focusedDocxReadResult = await client.callTool({
    name: "lily_capability_list",
    arguments: { query: "读取这个 Word 文档并总结要点", files: [{ name: "report.docx" }] },
  });
  const focusedDocxReadBody = JSON.parse(focusedDocxReadResult.content[0].text);
  assert.equal(
    focusedDocxReadBody.skillGraph[0]?.id,
    "anthropics-docx",
    "focused capability list puts DOCX tooling first for read/summary through MCP",
  );
  const focusedEvidenceResult = await client.callTool({
    name: "lily_capability_list",
    arguments: { query: "查询这份合同文档里的付款条件并引用证据", files: [{ name: "contract.docx" }] },
  });
  const focusedEvidenceBody = JSON.parse(focusedEvidenceResult.content[0].text);
  assert.equal(
    focusedEvidenceBody.skillGraph[0]?.id,
    "lily-document-query",
    "focused capability list keeps document query first for evidence lookup through MCP",
  );
  const focusedMailResult = await client.callTool({
    name: "lily_capability_list",
    arguments: { query: "给我写一封邮件回复客户，语气专业" },
  });
  const focusedMailBody = JSON.parse(focusedMailResult.content[0].text);
  assert.equal(
    focusedMailBody.skillGraph[0]?.id,
    "lily-mail-assistant",
    "focused capability list puts mail assistant first through MCP",
  );
  const focusedUiResult = await client.callTool({
    name: "lily_capability_list",
    arguments: { query: "检查这个页面的 UI 质量、间距、层级和视觉一致性" },
  });
  const focusedUiBody = JSON.parse(focusedUiResult.content[0].text);
  assert.equal(
    focusedUiBody.skillGraph[0]?.id,
    "lily-ui-quality",
    "focused capability list puts UI quality first through MCP",
  );
  assert.ok(
    focusedUiBody.skillGraph.some((skill) => skill.id === "lily-browser-qa"),
    "focused capability list retains browser QA for UI quality through MCP",
  );
  const focusedRepairResult = await client.callTool({
    name: "lily_capability_list",
    arguments: { query: "修复这个报错：TypeError cannot read property of undefined" },
  });
  const focusedRepairBody = JSON.parse(focusedRepairResult.content[0].text);
  assert.equal(
    focusedRepairBody.skillGraph[0]?.id,
    "lily-code-repair",
    "focused capability list puts code repair first through MCP",
  );
  const focusedAppResult = await client.callTool({
    name: "lily_capability_list",
    arguments: { query: "帮我做一个 CRM 管理后台应用，包含客户列表和统计看板" },
  });
  const focusedAppBody = JSON.parse(focusedAppResult.content[0].text);
  assert.equal(
    focusedAppBody.skillGraph[0]?.id,
    "lily-app-builder",
    "focused capability list puts app builder first through MCP",
  );
  assert.ok(
    focusedAppBody.skillGraph.some((skill) => skill.id === "lily-coding-core"),
    "focused capability list retains coding core for app creation through MCP",
  );
  const focusedCodingResult = await client.callTool({
    name: "lily_capability_list",
    arguments: { query: "实现一个登录表单组件并接入校验逻辑" },
  });
  const focusedCodingBody = JSON.parse(focusedCodingResult.content[0].text);
  assert.equal(
    focusedCodingBody.skillGraph[0]?.id,
    "lily-coding-core",
    "focused capability list puts coding core first through MCP",
  );
  const focusedEngineeringResult = await client.callTool({
    name: "lily_capability_list",
    arguments: { query: "按工程规范审查这个实现方案，避免过度设计和能力退化" },
  });
  const focusedEngineeringBody = JSON.parse(focusedEngineeringResult.content[0].text);
  assert.equal(
    focusedEngineeringBody.skillGraph[0]?.id,
    "lily-engineering-rules",
    "focused capability list puts engineering rules first through MCP",
  );
  const focusedScriptResult = await client.callTool({
    name: "lily_capability_list",
    arguments: { query: "写一个脚本批量重命名这些文件" },
  });
  const focusedScriptBody = JSON.parse(focusedScriptResult.content[0].text);
  assert.equal(
    focusedScriptBody.skillGraph[0]?.id,
    "lily-app-builder",
    "focused capability list puts app builder first for script creation through MCP",
  );
  const focusedPdfCreateResult = await client.callTool({
    name: "lily_capability_list",
    arguments: { query: "创建一个新的 PDF 报告并加水印" },
  });
  const focusedPdfCreateBody = JSON.parse(focusedPdfCreateResult.content[0].text);
  assert.equal(
    focusedPdfCreateBody.skillGraph[0]?.id,
    "anthropics-pdf",
    "focused capability list puts PDF tooling first for PDF creation through MCP",
  );
  assert.ok(
    !focusedPdfCreateBody.skillGraph.some((skill) => skill.id === "lily-app-builder"),
    "focused capability list omits app builder for PDF creation through MCP",
  );
  const focusedWordCreateResult = await client.callTool({
    name: "lily_capability_list",
    arguments: { query: "创建一份带目录和页码的 Word 报告" },
  });
  const focusedWordCreateBody = JSON.parse(focusedWordCreateResult.content[0].text);
  assert.equal(
    focusedWordCreateBody.skillGraph[0]?.id,
    "anthropics-doc-coauthoring",
    "focused capability list puts document coauthoring first for Word report creation through MCP",
  );
  const focusedPptCreateResult = await client.callTool({
    name: "lily_capability_list",
    arguments: { query: "创建一个 PowerPoint 培训课件" },
  });
  const focusedPptCreateBody = JSON.parse(focusedPptCreateResult.content[0].text);
  assert.equal(
    focusedPptCreateBody.skillGraph[0]?.id,
    "anthropics-pptx",
    "focused capability list puts PPTX tooling first for PowerPoint creation through MCP",
  );
  const focusedTemplateResult = await client.callTool({
    name: "lily_capability_list",
    arguments: { query: "用这个 Word 模板批量填充客户信息生成合同", files: [{ name: "contract-template.docx" }] },
  });
  const focusedTemplateBody = JSON.parse(focusedTemplateResult.content[0].text);
  assert.equal(
    focusedTemplateBody.skillGraph[0]?.id,
    "lily-template-fill",
    "focused capability list puts template filling first through MCP",
  );
  const focusedMediaResult = await client.callTool({
    name: "lily_capability_list",
    arguments: { query: "剪辑这个视频并转码成 mp4", files: [{ name: "clip.mov" }] },
  });
  const focusedMediaBody = JSON.parse(focusedMediaResult.content[0].text);
  assert.equal(
    focusedMediaBody.skillGraph[0]?.id,
    "lily-runtime-packs",
    "focused capability list puts runtime packs first for media transcode through MCP",
  );
  assert.ok(
    !focusedMediaBody.skillGraph.some((skill) => skill.id === "lily-creative-director"),
    "focused capability list omits creative prompt direction for media transcode through MCP",
  );

  context = { ...context, activeSkillIds: [] };
  const inactiveStatusResult = await client.callTool({ name: "lily_capability_status", arguments: {} });
  const inactiveStatusBody = JSON.parse(inactiveStatusResult.content[0].text);
  assert.ok(
    inactiveStatusBody.unavailableTools.some((tool) => (
      tool.name === "mail_search" &&
      tool.reason === "SKILL_NOT_ACTIVE" &&
      Array.isArray(tool.missingSkillIds) &&
      tool.missingSkillIds[0] === "lily-mail-assistant"
    )),
    "capability status names missing skills for inactive tools through MCP",
  );
  const result = await client.callTool({ name: "runtime_pack_list", arguments: {} });
  const body = JSON.parse(result.content[0].text);
  assert.equal(body.ok, true, "platform tools remain callable after optional skills change");
  await client.close();
}

{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lily-broker-mcp-learned-"));
  const learnedDir = path.join(tmp, "learned-on");
  fs.mkdirSync(learnedDir, { recursive: true });
  fs.writeFileSync(path.join(learnedDir, "web-system-playbook.json"), "{}");
  fs.writeFileSync(path.join(learnedDir, "capability-map.json"), JSON.stringify({
    systemId: "learned-on",
    systemName: "Learned On",
    capabilities: [{
      id: "web.query",
      title: "Query",
      risk: "read",
      params: { required: ["q"], properties: { q: { type: "string", label: "Query" } } },
    }],
  }));
  try {
    const server = await createToolBrokerMcpServer({
      context: { sessionId: "s1", activeSkillIds: ["learned-on"] },
      registryDeps: { learnedWebSystemDirs: () => [learnedDir] },
    });
    const client = await clientForServer(server);
    const { tools } = await client.listTools();
    assert.ok(tools.some((tool) => tool.name === "learned_on__query"), "MCP tools/list exposes active learned web-system tools");

    const capabilityResult = await client.callTool({ name: "lily_capability_list", arguments: {} });
    const capabilityBody = JSON.parse(capabilityResult.content[0].text);
    assert.ok(
      capabilityBody.tools.some((tool) => tool.name === "learned_on__query" && tool.group === "learned-web-system"),
      "MCP capability list includes active learned web-system tools",
    );

    const statusResult = await client.callTool({ name: "lily_capability_status", arguments: {} });
    const statusBody = JSON.parse(statusResult.content[0].text);
    assert.ok(statusBody.tools.includes("learned_on__query"), "MCP capability status includes active learned web-system tool names");
    assert.ok(
      statusBody.toolDetails.some((tool) => (
        tool.name === "learned_on__query" &&
        tool.available === true &&
        tool.group === "learned-web-system" &&
        tool.executionSurface === "learned_web_system_mcp" &&
        tool.mcpServerName === "web_learned_on"
      )),
      "MCP capability status includes active learned web-system tool details",
    );
    await client.close();
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

{
  const server = await createToolBrokerMcpServer({
    context: { sessionId: "s1", activeSkillIds: ["anthropics-xlsx"] },
    registryDeps: { installedRuntimePackIds: () => new Set(["libreoffice"]) },
  });
  const client = await clientForServer(server);
  const statusResult = await client.callTool({ name: "lily_capability_status", arguments: {} });
  const statusBody = JSON.parse(statusResult.content[0].text);
  assert.ok(
    statusBody.runtimePacks.requiredByActiveSkills.some((item) => (
      item.skillId === "anthropics-xlsx" &&
      item.required.includes("libreoffice") &&
      item.required.includes("large-document") &&
      item.missing.includes("large-document") &&
      !item.missing.includes("libreoffice")
    )),
    "MCP capability status explains missing runtime packs for active skills",
  );
  assert.ok(statusBody.runtimePacks.missing.includes("large-document"), "MCP capability status summarizes missing runtime packs");
  assert.ok(
    statusBody.runtimePacks.missingDetails.some((pack) => (
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
    "MCP capability status includes metadata and install action for missing runtime packs",
  );
  await client.close();
}

{
  const server = await createToolBrokerMcpServer({
    context: { sessionId: "s1", activeSkillIds: [] },
    registryDeps: { installedRuntimePackIds: () => new Set(["libreoffice"]) },
  });
  const client = await clientForServer(server);
  const capabilityResult = await client.callTool({
    name: "lily_capability_list",
    arguments: {
      query: "分析这个 Excel 销售数据，生成透视汇总和柱状图",
      files: [{ name: "sales.xlsx" }],
    },
  });
  const capabilityBody = JSON.parse(capabilityResult.content[0].text);
  assert.equal(capabilityBody.runtimePacks.evaluated, true, "focused capability list evaluates runtime pack gap for recommendations");
  assert.ok(
    capabilityBody.runtimePacks.requiredByRecommendedSkills.some((item) => (
      item.skillId === "lily-excel-data-analysis" &&
      item.required.includes("libreoffice") &&
      item.required.includes("large-document") &&
      item.missing.includes("large-document") &&
      !item.missing.includes("libreoffice")
    )),
    "MCP capability list explains missing runtime packs for recommended skills",
  );
  assert.ok(capabilityBody.runtimePacks.missing.includes("large-document"), "MCP capability list summarizes missing recommended runtime packs");
  assert.ok(
    capabilityBody.runtimePacks.missingDetails.some((pack) => (
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
    "MCP capability list includes metadata and install action for missing recommended runtime packs",
  );
  assert.equal(
    capabilityBody.runtimePacks.installToolAvailable,
    true,
    "MCP capability list says when runtime-pack install tool is available",
  );
  await client.close();
}

{
  const server = await createToolBrokerMcpServer({
    context: { ok: false, error: "SESSION_NOT_FOUND" },
  });
  const client = await clientForServer(server);
  const { tools } = await client.listTools();
  assert.deepEqual(tools, [], "failed context registers no tools");
  await client.close();
}

{
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(process.cwd(), "src/main/mcp/tool-broker-stdio.js")],
    env: { ...process.env, LILY_TOOL_BROKER_CONTEXT: "" },
  });
  const client = new Client({ name: "stdio-platform-test", version: "1.0.0" });
  await client.connect(transport);
  const { tools } = await client.listTools();
  assert.deepEqual(
    tools.map((tool) => tool.name).sort(),
    ["lily_capability_list", "lily_capability_status", "runtime_pack_install", "runtime_pack_list"],
    "stdio broker without session context exposes only platform capabilities",
  );
  const statusResult = await client.callTool({ name: "lily_capability_status", arguments: {} });
  const statusBody = JSON.parse(statusResult.content[0].text);
  assert.ok(
    statusBody.unavailableTools.some((tool) => (
      tool.name === "mail_search" &&
      tool.reason === "SESSION_REQUIRED" &&
      tool.requiresSession === true &&
      tool.sessionAvailable === false
    )),
    "stdio platform-only status explains session-gated tools",
  );
  assert.ok(
    statusBody.toolDetails.some((tool) => (
      tool.name === "runtime_pack_list" &&
      tool.requiresSession === false &&
      tool.sessionAvailable === false &&
      tool.available === true
    )),
    "stdio platform-only status keeps platform tools available without session",
  );
  await client.close();
}

{
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(process.cwd(), "src/main/mcp/tool-broker-stdio.js")],
    env: { ...process.env, LILY_TOOL_BROKER_CONTEXT: JSON.stringify({ sessionId: "s1", activeSkillIds: ["lily-runtime-packs"] }) },
  });
  const client = new Client({ name: "stdio-test", version: "1.0.0" });
  await client.connect(transport);
  const { tools } = await client.listTools();
  assert.deepEqual(
    tools.map((tool) => tool.name).sort(),
    ["lily_capability_list", "lily_capability_status", "lily_intent_contract_commit", "runtime_pack_install", "runtime_pack_list"],
    "stdio broker reads explicit context and exposes platform capabilities",
  );
  await client.close();
}

console.log("PASS: test-tool-broker-mcp (73 tests)");
