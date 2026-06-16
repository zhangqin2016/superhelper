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
  classifyTask,
  detectWorkspaceProfile,
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
assert.equal(contract.modelDraft.requested, true);
assert.equal(contract.modelDraft.localFallback.taskType, "runtime_protocol");

const prefixed = withTaskContractPrefix("用户原始问题", contract);
assert(prefixed.includes('title="execution_constraints"'));
assert(prefixed.includes('title="user_original_request"'));
assert(prefixed.includes("<lily_task_contract>"));
assert(prefixed.includes("Platform baseline rules:"));
assert(prefixed.includes("Model task draft:"));
assert(prefixed.includes("task_type: runtime_protocol"));
assert(prefixed.includes("Impact checklist:"));
assert(prefixed.includes("Verification strategy:"));
assert(prefixed.includes("registry_version: local-default"));
assert(prefixed.includes("Highest priority"));
assert(prefixed.includes("用户原始问题"));

const plain = withTaskContractPrefix("你好", buildTaskContract({ text: "你好" }));
assert.equal(plain, "你好");

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
