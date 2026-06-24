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

fs.rmSync(tmp, { recursive: true, force: true });
console.log("skill-capability-contracts: ok", bundled.skills.length);
