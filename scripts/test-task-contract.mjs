#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import module from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const require = module.createRequire(import.meta.url);
const {
  DEFAULT_TASK_INTELLIGENCE_REGISTRY,
  buildTaskContract,
  buildWorkspaceGroundingPolicy,
  classifyTask,
  detectWorkspaceProfile,
  extractNegativeConstraints,
  loadTaskIntelligenceRegistry,
  mergeTaskIntelligenceRegistry,
  withTaskContractPrefix,
} = require(path.join(ROOT, "src/main/task-contract.js"));

const remoteConfigPath = require.resolve(path.join(ROOT, "src/main/remote-config.js"));

function withRemoteTaskIntelligence(taskIntelligence, fn) {
  const previous = require.cache[remoteConfigPath];
  require.cache[remoteConfigPath] = {
    id: remoteConfigPath,
    filename: remoteConfigPath,
    loaded: true,
    exports: {
      getRemoteEffectiveConfigSync() {
        return { taskIntelligence };
      },
    },
  };
  try {
    return fn();
  } finally {
    if (previous) {
      require.cache[remoteConfigPath] = previous;
    } else {
      delete require.cache[remoteConfigPath];
    }
  }
}

assert.equal(classifyTask({ text: "你好" }).active, false, "casual chat should not get heavy process");
const colloquialProgram = buildTaskContract({ text: "给我写一个牛逼的程序" });
assert.equal(colloquialProgram.active, true, "colloquial program creation must receive the coding execution contract");
assert.equal(colloquialProgram.taskType, "code_change");
assert.equal(colloquialProgram.semanticIntent?.domain, "programming");
assert.equal(colloquialProgram.semanticIntent?.operation, "implement");
assert.equal(colloquialProgram.modelDraft.localFallback.outputMode, "workspace_change");
assert(colloquialProgram.intentContract.deliverables.includes("requested_workspace_change"));
for (const text of ["继续", "就行", "好", "然后呢", "继续说", "展开", "继续讲", "可以", "嗯"]) {
  assert.equal(
    classifyTask({ text }).active,
    false,
    `short follow-up ${text} should stay lightweight`,
  );
}
for (const text of ["继续这个流程", "继续实现", "继续任务", "继续执行"]) {
  assert.equal(
    classifyTask({ text }).active,
    false,
    `underspecified continuation ${text} should not create a heavy task contract by itself`,
  );
}
const concreteContinuation = classifyTask({ text: "继续 imsdk 流程" });
assert.equal(concreteContinuation.active, true, "continuations with concrete code terms must stay observable");
assert(concreteContinuation.categories.includes("code"));
withRemoteTaskIntelligence(
  { lowInformationContinuation: { terms: ["稍后"], genericObjects: ["这个流程"] } },
  () => {
    assert.equal(
      classifyTask({ text: "稍后这个流程" }).active,
      false,
      "low-information continuation vocabulary should be configurable",
    );
  },
);

const runtime = classifyTask({ text: "切换会话后队列任务展示乱了，帮我修复" });
assert.equal(runtime.active, true);
assert.equal(runtime.kind, "runtime");
assert.equal(runtime.taskType, "runtime_protocol");
assert(runtime.categories.includes("runtime"));
assert(runtime.categories.includes("bugfix"));

const release = classifyTask({ text: "打包新版本并推送到七牛和服务器" });
assert.equal(release.active, true);
assert.equal(release.kind, "release");
assert.equal(release.taskType, "release_deploy");

const negatedSchedule = classifyTask({ text: "知识方案里需要有逐小时预报，不是创建定时任务" });
assert.equal(negatedSchedule.categories.includes("runtime"), false, "negated scheduled-task wording must not activate runtime task contract");
const negatedConstraints = extractNegativeConstraints("知识方案里需要有逐小时预报，不是创建定时任务");
assert(negatedConstraints.some((item) => item.intent === "scheduled_task_creation"), "scheduled-task negation should become a blocked intent");

const imageRecognition = classifyTask({ text: "帮我识别这张图片里的内容" });
assert.equal(
  imageRecognition.categories.includes("agent_quality"),
  false,
  "generic image recognition must not be routed as platform agent-quality work",
);
assert.equal(imageRecognition.active, true, "image work should get a lightweight media evidence contract");
assert.equal(imageRecognition.kind, "content_extraction");
assert.equal(imageRecognition.taskType, "content_extraction");
assert.equal(imageRecognition.contentIntent.operation, "extract");
assert.deepEqual(extractNegativeConstraints("帮我识别这张图片里的内容"), [], "识别 must not be parsed as the negation 别");

const documentQuestion = buildTaskContract({
  text: "分析这个 PDF 文档",
  project: { path: ROOT },
});
assert.equal(documentQuestion.active, true, "document work should get an evidence contract");
assert.equal(documentQuestion.kind, "content_extraction");
assert.equal(documentQuestion.taskType, "content_extraction");
assert(documentQuestion.evidencePolicy.requiredEvidenceKinds.includes("source_content"));
assert(documentQuestion.evidencePolicy.allowedSources.includes("document_evidence"));
assert(documentQuestion.intentContract.deliverables.includes("extracted_or_explained_source_content"));

const detailedFollowUp = buildTaskContract({
  text: "再详细点",
  messages: [{
    role: "assistant",
    record: {
      meta: {
        taskContract: documentQuestion,
        evidenceSummary: {
          hasSourceContentEvidence: true,
          sourceContentCoverage: { status: "complete", sourceCount: 1, observedCount: 1, complete: true },
        },
      },
    },
  }],
});
assert.equal(detailedFollowUp.taskType, "content_extraction", "source-content follow-ups should inherit the prior semantic task");
assert.equal(detailedFollowUp.intentContract.relation, "refine");
assert.equal(detailedFollowUp.contentIntent.operation, "understand");
assert.equal(detailedFollowUp.priorSourceContentEvidence?.sourceCount, 1, "only proven prior source context should carry forward");

const mediaRepair = buildTaskContract({
  text: "修复这张图片",
  project: { path: ROOT },
});
assert.equal(mediaRepair.active, true, "media repair should not collapse into generic bugfix");
assert.equal(mediaRepair.kind, "media");
assert.equal(mediaRepair.taskType, "media_generation");
assert(!mediaRepair.evidencePolicy.requiredEvidenceKinds.includes("file_write"));
assert(mediaRepair.evidencePolicy.allowedSources.includes("generated_or_modified_file"));

const genericTaskWord = classifyTask({ text: "这个任务是记录今天做了导入 Excel 的优化" });
assert.equal(
  genericTaskWord.categories.includes("runtime"),
  false,
  "the generic word 任务/工作 context must not route ordinary work notes into runtime protocol",
);

const quality = classifyTask({ text: "再次全面检查笨的原因，让小模型有大智慧" });
assert.equal(quality.active, true);
assert.equal(quality.kind, "agent_quality");
assert.equal(quality.taskType, "agent_quality");

const topTierContinuation = classifyTask({ text: "继续按顶级设计 系统更聪明" });
assert.equal(topTierContinuation.active, true, "goalful continuation should not be flattened into casual chat");
assert.equal(topTierContinuation.kind, "architecture_audit");
assert.equal(topTierContinuation.taskType, "architecture_audit");

const finalShapePush = classifyTask({ text: "全部推进最终形态，把系统智能度补齐" });
assert.equal(finalShapePush.active, true, "final-shape intelligence requests should activate agent-quality work");
assert.equal(finalShapePush.kind, "agent_quality");
assert.equal(finalShapePush.taskType, "agent_quality");

const architectureAudit = classifyTask({ text: "分析我们系统有哪些比较笨的地方" });
assert.equal(architectureAudit.active, true, "system weakness analysis should activate a grounded architecture audit");
assert.equal(architectureAudit.kind, "architecture_audit");
assert.equal(architectureAudit.taskType, "architecture_audit");
assert(architectureAudit.categories.includes("architecture_audit"));

const architectureAuditContract = buildTaskContract({
  text: "分析我们系统有哪些比较笨的地方",
  project: { path: ROOT },
});
assert.equal(architectureAuditContract.active, true);
assert.equal(architectureAuditContract.taskType, "architecture_audit");
assert.equal(architectureAuditContract.workspaceGroundingPolicy.required, true);
assert.equal(architectureAuditContract.evidencePolicy.required, true);
assert(architectureAuditContract.evidencePolicy.requiredEvidenceKinds.includes("file_search"));
assert(architectureAuditContract.evidencePolicy.requiredEvidenceKinds.includes("file_read"));
assert(architectureAuditContract.checklist.some((item) => item.includes("natural-language")));
const qualityContract = buildTaskContract({
  text: "再次全面检查笨的原因，让小模型有大智慧",
  project: { path: ROOT },
});
assert.equal(qualityContract.taskType, "agent_quality");
assert(qualityContract.checklist.some((item) => item.includes("deterministic intent routing")));
assert(qualityContract.verificationStrategy.includes("routing_contract"));
assert.equal(qualityContract.workspaceGroundingPolicy.required, true);
assert.equal(qualityContract.workspaceGroundingPolicy.mode, "reuse_existing_workspace");
assert.equal(qualityContract.workspaceGroundingPolicy.allowNewTopLevel, false);

const finalShapeContract = buildTaskContract({
  text: "全部推进最终形态，把系统智能度补齐",
  project: { path: ROOT },
});
assert.equal(finalShapeContract.taskType, "agent_quality");
assert(finalShapeContract.evidencePolicy.requiredEvidenceKinds.includes("file_search"));
assert(finalShapeContract.evidencePolicy.requiredEvidenceKinds.includes("file_read"));
assert(finalShapeContract.checklist.some((item) => item.includes("deterministic intent routing")));

const imsdkAnalysis = buildTaskContract({
  text: "分析 imsdk 流转流程",
  project: { path: ROOT },
});
assert.equal(imsdkAnalysis.active, true, "source flow analysis should activate a code contract");
assert.equal(imsdkAnalysis.taskType, "code_change");
assert.equal(imsdkAnalysis.sourceCoveragePolicy.required, true);
assert(imsdkAnalysis.sourceCoveragePolicy.explicitTerms.some((term) => term.toLowerCase() === "imsdk"));
assert(!imsdkAnalysis.sourceCoveragePolicy.explicitTerms.some((term) => term.toLowerCase() === "cst"));
assert(
  !imsdkAnalysis.evidencePolicy.requiredEvidenceKinds.includes("file_search"),
  "source search is claim-triggered by turn policy, not forced on every code task",
);

const imsdkWhat = buildTaskContract({
  text: "imsdk 是什么",
  project: { path: ROOT },
});
assert.equal(imsdkWhat.active, true, "technical SDK inquiries should use codebase evidence");
assert.equal(imsdkWhat.taskType, "code_change");
assert(imsdkWhat.sourceCoveragePolicy.explicitTerms.some((term) => term.toLowerCase() === "imsdk"));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lily-task-contract-"));
fs.mkdirSync(path.join(tmp, "src/main"), { recursive: true });
fs.mkdirSync(path.join(tmp, "src/renderer"), { recursive: true });
fs.mkdirSync(path.join(tmp, "server/src"), { recursive: true });
fs.mkdirSync(path.join(tmp, "web"), { recursive: true });
fs.writeFileSync(path.join(tmp, "package.json"), JSON.stringify({ name: "anything" }), "utf8");
fs.writeFileSync(path.join(tmp, "src/main.js"), "", "utf8");
fs.writeFileSync(path.join(tmp, "src/preload.js"), "", "utf8");
const profile = detectWorkspaceProfile(tmp);
assert.equal(profile.type, "desktop-fullstack");
assert(profile.signals.includes("electron"));
assert(profile.signals.includes("server"));
assert(profile.signals.includes("web"));
assert(profile.hints.some((hint) => hint.includes("Desktop main process")));

const contract = buildTaskContract({
  text: "修复 Claude CLI event 处理重复的问题",
  project: { path: tmp },
});
assert.equal(contract.active, true);
assert.equal(contract.schemaVersion, 5);
assert.equal(contract.taskType, "runtime_protocol");
assert.equal(contract.workspaceProfile, "desktop-fullstack");
assert(contract.workspaceSignals.includes("electron"));
assert(contract.checklist.some((item) => item.toLowerCase().includes("protocol")));
assert(contract.platformRules.some((item) => item.includes("Preserve the user's original request")));
assert(contract.verificationStrategy.includes("event_ordering"));
assert(contract.evidencePolicy.required, "bug/runtime work should require evidence");
assert(contract.evidencePolicy.allowedSources.includes("code_file_reference"));
assert(contract.evidencePolicy.allowedSources.includes("test_or_command_output"));
assert(contract.workspaceGroundingPolicy.required, "runtime work should require workspace grounding");
assert.equal(contract.workspaceGroundingPolicy.allowNewTopLevel, false);
assert(contract.workspaceGroundingPolicy.requiredEvidence.includes("workspace_tree_or_manifest"));
assert.equal(contract.modelDraft.requested, true);
assert.equal(contract.modelDraft.localFallback.taskType, "runtime_protocol");
assert.equal(contract.modelDraft.localFallback.relation, "new");
assert(contract.modelDraft.localFallback.deliverables.includes("verified_runtime_behavior"));
assert(contract.modelDraft.localFallback.successCriteria.includes("event_ordering"));

const scheduleContract = buildTaskContract({
  text: "知识方案里需要有逐小时预报，不是创建定时任务",
  project: { path: tmp },
});
assert.equal(scheduleContract.active, false, "schedule-content negation should not force a heavy engineering contract");
assert(scheduleContract.negativeConstraints.some((item) => item.intent === "scheduled_task_creation"));

const prefixed = withTaskContractPrefix("用户原始问题", contract);
assert(prefixed.includes('title="execution_constraints"'));
assert(prefixed.includes('title="user_original_request"'));
assert(prefixed.includes("<lily_task_contract>"));
assert(prefixed.includes("Platform baseline rules:"));
assert(prefixed.includes("User negative constraints and blocked intents:"));
assert(prefixed.includes("Evidence gate:"));
assert(prefixed.includes("Host-resolved intent contract:"));
assert(prefixed.includes('"relation":"new"'));
assert(prefixed.includes("Unsupported factual claims must be downgraded"));
assert(prefixed.includes("Source coverage gate:"));
assert(prefixed.includes("Workspace grounding gate:"));
assert(prefixed.includes("allow_new_top_level: no"));
assert(prefixed.includes("Model task draft:"));
assert(prefixed.includes("task_type: runtime_protocol"));
assert(prefixed.includes("Impact checklist:"));
assert(prefixed.includes("Verification strategy:"));
assert(prefixed.includes("registry_version: local-default"));
assert(prefixed.includes("Highest priority"));
assert(prefixed.includes("用户原始问题"));

const negatedPrefixed = withTaskContractPrefix(
  "知识方案里需要有逐小时预报，不是创建定时任务",
  {
    ...contract,
    negativeConstraints: negatedConstraints,
    blockedIntents: ["scheduled_task_creation"],
  },
);
assert(negatedPrefixed.includes("Blocked intents: scheduled_task_creation"));

const plain = withTaskContractPrefix("你好", buildTaskContract({ text: "你好" }));
assert.equal(plain, "你好");

const isolatedNewTask = buildTaskContract({
  text: "做个复杂的前端展示系统",
  messages: [
    { role: "user", text: "设计一个充电桩运营能力测试任务" },
    { role: "assistant", text: "已在 output/ev-charging-test 生成数据与仪表盘。" },
  ],
});
assert.equal(isolatedNewTask.intentContract.relation, "new");
const isolatedNewTaskPrompt = withTaskContractPrefix("做个复杂的前端展示系统", isolatedNewTask);
assert.match(
  isolatedNewTaskPrompt,
  /New-task isolation boundary:/,
  "a new task must be explicitly isolated from completed work in the engine prompt",
);
assert.match(
  isolatedNewTaskPrompt,
  /Do not reuse or modify prior task-specific artifacts/,
  "a new task must not silently repurpose an earlier task's files or output directory",
);

const releaseContract = buildTaskContract({
  text: "发布新版本并检查线上是否生效",
  project: { path: tmp },
});
assert.equal(releaseContract.evidencePolicy.required, true);
assert(releaseContract.evidencePolicy.allowedSources.includes("artifact_or_version_manifest"));
assert(releaseContract.evidencePolicy.allowedSources.includes("live_service_check"));

const greenfieldContract = buildTaskContract({
  text: "从零创建一个全新的股票分析应用代码",
  project: { path: tmp },
});
assert.equal(greenfieldContract.workspaceGroundingPolicy.required, true);
assert.equal(greenfieldContract.workspaceGroundingPolicy.mode, "greenfield_allowed");
assert.equal(greenfieldContract.workspaceGroundingPolicy.allowNewTopLevel, true);
assert.equal(
  buildWorkspaceGroundingPolicy({
    text: "做一个导入 Excel 的优化",
    classification: { active: true, categories: ["code"], taskType: "code_change" },
    profile: { type: "node", signals: ["node"] },
  }).allowNewTopLevel,
  false,
);

const mergedRegistry = mergeTaskIntelligenceRegistry(DEFAULT_TASK_INTELLIGENCE_REGISTRY, {
  version: "remote-test",
  categories: {
    ui: { terms: ["花屏"] },
  },
  workspaceProfiles: [
    {
      id: "custom-erp",
      markerFiles: ["erp.marker"],
      hints: ["ERP modules: apps/erp/"],
    },
  ],
  verificationStrategies: {
    ui_change: ["Remote visual regression check"],
  },
  checklists: {
    byCategory: {
      ui: ["Remote UI checklist item"],
    },
  },
});
assert.equal(mergedRegistry.remoteVersion, "remote-test");
assert(mergedRegistry.categories.ui.terms.includes("花屏"), "remote category terms should be merged");
assert(mergedRegistry.categories.ui.terms.includes("按钮"), "local category terms should remain available");
assert(mergedRegistry.workspaceProfiles.some((item) => item.id === "custom-erp"));
assert(mergedRegistry.verificationStrategies.ui_change.includes("Remote visual regression check"));
assert(mergedRegistry.checklists.byCategory.ui.includes("Remote UI checklist item"));

withRemoteTaskIntelligence(
  {
    version: "remote-live-test",
    categories: {
      ui: { terms: ["花屏"] },
    },
    workspaceProfiles: [
      {
        id: "custom-erp",
        markerFiles: ["erp.marker"],
        hints: ["ERP modules: apps/erp/"],
      },
    ],
    verificationStrategies: {
      ui_change: ["Remote visual regression check"],
    },
    checklists: {
      byCategory: {
        ui: ["Remote UI checklist item"],
      },
    },
  },
  () => {
    const remoteClassification = classifyTask({ text: "页面花屏了" });
    assert.equal(remoteClassification.active, true);
    assert(remoteClassification.categories.includes("ui"));

    const remoteTmp = fs.mkdtempSync(path.join(os.tmpdir(), "lily-task-contract-remote-"));
    fs.writeFileSync(path.join(remoteTmp, "erp.marker"), "", "utf8");
    const remoteProfile = detectWorkspaceProfile(remoteTmp);
    assert.equal(remoteProfile.type, "custom-erp");
    assert(remoteProfile.signals.includes("custom-erp"));
    assert(remoteProfile.hints.includes("ERP modules: apps/erp/"));

    const remoteContract = buildTaskContract({ text: "页面花屏了", project: { path: remoteTmp } });
    assert.equal(remoteContract.registryVersion, "remote-live-test");
    assert(remoteContract.checklist.includes("Remote UI checklist item"));
    assert(remoteContract.verificationStrategy.includes("Remote visual regression check"));
  },
);

withRemoteTaskIntelligence(
  {
    version: "server-empty-default",
    fileExtensions: [],
    priority: [],
    activatingCategories: [],
    categories: {},
    workspaceProfiles: [],
    checklists: {
      base: [],
      byCategory: {},
    },
  },
  () => {
    const defaultBackstop = classifyTask({ text: "修复 bug" });
    assert.equal(defaultBackstop.active, true, "empty server config must not disable local default intelligence");
    assert.equal(defaultBackstop.kind, "bugfix");
  },
);

withRemoteTaskIntelligence({ enabled: false }, () => {
  const registry = loadTaskIntelligenceRegistry();
  assert.equal(registry.enabled, true, "remote config must not disable the local task-intelligence baseline");
  assert.equal(registry.remoteEnhancementsEnabled, false);
  assert.equal(classifyTask({ text: "修复 bug" }).active, true, "remote disable must fail open to local intelligence");
});

withRemoteTaskIntelligence({ schemaVersion: 999, categories: { remote_only: { terms: ["remote-only"] } } }, () => {
  const registry = loadTaskIntelligenceRegistry();
  assert.equal(registry.remoteEnhancementsEnabled, false, "unknown remote schema must be ignored");
  assert.equal(classifyTask({ text: "修复 bug" }).active, true, "unknown remote schema must preserve local intelligence");
  assert.equal(registry.categories.remote_only, undefined);
});

// Reply-shape rule: an active task contract must tell the model that its reply
// is the deliverable and that objective/plan/work-state tracking stays internal
// (no status-report recap) — while KEEPING the evidence-grounding discipline.
{
  const contract = buildTaskContract({
    text: "修复 turn 渲染的 bug 并验证",
    files: [],
    session: { id: "s-contract" },
    project: { path: ROOT },
  });
  assert.equal(contract.active, true, "an operational task should produce an active contract");
  const prefixed = withTaskContractPrefix("继续", contract);
  assert.match(prefixed, /Your reply IS the answer or deliverable/, "contract must state the reply is the deliverable, not a status tracker");
  assert.match(prefixed, /never render them back as your reply/, "contract must forbid mirroring internal tracking back as the reply");
  assert.match(prefixed, /Work State \/ Completed \/ Active \/ Blocked \/ Next Move/, "contract must name the exact status-report sections to avoid");
  assert.match(prefixed, /Do not restate or re-send the previous turn's conclusion as a recap/, "contract must forbid re-sending the prior conclusion on continuation");
  // No regression: evidence-grounding discipline is preserved (not weakened).
  assert.match(prefixed, /Unsupported factual claims must be downgraded to uncertainty/, "evidence grounding discipline must remain");
  assert.match(prefixed, /do NOT append a blanket evidence disclaimer/, "grounded answers must not get a blanket evidence disclaimer");
  // Fail-open: a non-active contract injects nothing (today's behavior).
  assert.equal(withTaskContractPrefix("hi", { active: false }), "hi", "inactive contract must not alter the prompt");
}

console.log("task-contract: ok");
