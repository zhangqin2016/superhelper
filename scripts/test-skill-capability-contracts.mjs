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
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lily-skill-contracts-"));

process.resourcesPath = ROOT;
const electronPath = require.resolve("electron");
require.cache[electronPath] = {
  id: electronPath,
  filename: electronPath,
  loaded: true,
  exports: {
    app: {
      isPackaged: false,
      getPath(name) {
        if (name === "userData") return tmp;
        if (name === "home") return os.homedir();
        return os.tmpdir();
      },
      getVersion: () => "0.1.0",
    },
  },
};

const skillRegistry = require(path.join(ROOT, "src/main/skill-registry.js"));
const {
  isActionableSkillCapabilityContract,
} = require(path.join(ROOT, "src/main/skill-capability-contract.js"));

const bundled = skillRegistry.loadBundledRegistry();
assert.ok(bundled, "bundled registry should load");

function readSkill(skillId) {
  return fs.readFileSync(path.join(ROOT, "resources", "skills-catalog", skillId, "SKILL.md"), "utf8");
}

function assertSkillText(skillId, pattern, message) {
  assert.match(readSkill(skillId), pattern, `${skillId}: ${message}`);
}

const capabilities = bundled.capabilities || {};
assert.equal(Object.keys(capabilities).length, bundled.skills.length, "every bundled skill needs a capability map entry");

for (const skill of bundled.skills) {
  assert.ok(skill.capability, `${skill.id} should expose a normalized capability contract`);
  assert.equal(
    isActionableSkillCapabilityContract(skill.capability),
    true,
    `${skill.id} should have an actionable capability contract`,
  );
  assert.equal(
    skill.capability.risk.level,
    skill.riskLevel,
    `${skill.id} capability risk should match registry risk`,
  );
  if (skill.riskLevel === "high") {
    assert.notEqual(
      skill.capability.risk.confirmation,
      "none",
      `${skill.id} high-risk capability must require user confirmation`,
    );
  }
  if (skill.capability.kind !== "router") {
    assert.equal(
      skill.capability.verification.required,
      true,
      `${skill.id} should define required verification instead of relying on prose`,
    );
    assert.ok(
      skill.capability.verification.methods.length > 0,
      `${skill.id} should define concrete verification methods`,
    );
  }
}

const webLearning = bundled.skills.find((skill) => skill.id === "lily-web-system-learning");
assert.equal(webLearning.capability.kind, "connector");
assert.ok(webLearning.capability.primaryTools.includes("mcp.tool_broker"));
assert.ok(webLearning.capability.failure.recovery.includes("stop_runtime_script_generation"));

const officeRouter = bundled.skills.find((skill) => skill.id === "lily-office-intent");
assert.equal(officeRouter.capability.kind, "router");
assert.ok(officeRouter.capability.intents.includes("office.route"));

for (const skillId of ["lily-runtime-packs", "lily-office-intent", "lily-web-system-learning"]) {
  assertSkillText(
    skillId,
    /chat-native|natural language|natural-language|聊天原生|自然语言/i,
    "operational skills must start from chat/native language, not a separate UI workflow",
  );
  assertSkillText(
    skillId,
    /fail[- ]open|degrade|fallback|partial|失败打开|回退|部分/i,
    "operational skills must describe fail-open or partial-result recovery",
  );
  assertSkillText(
    skillId,
    /lily_process_jobs/,
    "long operational work must route through the generic process job supervisor",
  );
  assertSkillText(
    skillId,
    /job_status|job_logs/,
    "long operational work must be observable through generic job status/logs",
  );
}

assertSkillText(
  "lily-runtime-packs",
  /do not run live pip\/npm installs|do not install libraries directly|do not run ad-hoc `pip install`/i,
  "runtime packs must prohibit ad-hoc package installs when a Lily pack exists",
);
assertSkillText(
  "lily-office-intent",
  /Do not block the conversation|must not be read wholesale|Unsupported Document/i,
  "office routing must keep document work non-blocking and recover from generic Read failure",
);
assertSkillText(
  "lily-web-system-learning",
  /Do not use ad-hoc|do not open a browser during normal use|SPECIAL_BROWSER_CONTEXT_REQUIRED/i,
  "web learning must avoid ad-hoc browser loops and normal-use browser popups",
);

fs.rmSync(tmp, { recursive: true, force: true });
console.log("skill-capability-contracts: ok", bundled.skills.length);
