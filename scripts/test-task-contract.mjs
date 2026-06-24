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

const imsdkAnalysis = buildTaskContract({
  text: "分析 imsdk 流转流程",
  project: { path: ROOT },
});
assert.equal(imsdkAnalysis.active, true, "source flow analysis should activate a code contract");
assert.equal(imsdkAnalysis.taskType, "code_change");
assert.equal(imsdkAnalysis.sourceCoveragePolicy.required, true);
assert(imsdkAnalysis.sourceCoveragePolicy.explicitTerms.some((term) => term.toLowerCase() === "imsdk"));
assert(!imsdkAnalysis.sourceCoveragePolicy.explicitTerms.some((term) => term.toLowerCase() === "cst"));

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
assert.equal(contract.schemaVersion, 1);
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
  assert.equal(loadTaskIntelligenceRegistry().enabled, false);
  assert.equal(classifyTask({ text: "修复 bug" }).active, false, "remote kill switch should disable task contract");
});

console.log("task-contract: ok");
