#!/usr/bin/env node
import fs from "node:fs";
import module from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const require = module.createRequire(import.meta.url);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lily-skill-catalog-"));

delete process.env.LILY_SERVICE_API_BASE_URL;
delete process.env.SERVICE_API_BASE_URL;
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

const skillManager = require(path.join(ROOT, "src/main/skill-manager.js"));
const skillPresets = require(path.join(ROOT, "src/main/skill-presets.js"));
const skillRegistry = require(path.join(ROOT, "src/main/skill-registry.js"));
fs.mkdirSync(tmp, { recursive: true });
fs.writeFileSync(
  path.join(tmp, "skills-state.json"),
  JSON.stringify({
    schemaVersion: 1,
    registryUrl: "https://stale-user-registry.example.com/registry.json",
    skills: {},
  }),
);
skillManager.bootstrapSkills();

const mandatory = skillManager.MANDATORY_PLATFORM_SKILL_IDS;
const expectedMandatory = [
  "lily-workbench-rules",
  "lily-context-rules",
  "lily-task-execution-rules",
];
for (const skillId of expectedMandatory) {
  if (!mandatory.includes(skillId)) {
    throw new Error(`expected ${skillId} in MANDATORY_PLATFORM_SKILL_IDS`);
  }
  const disableMandatory = skillManager.setSkillEnabled(skillId, false);
  if (disableMandatory.ok) {
    throw new Error(`${skillId} should not be disableable`);
  }
  if (disableMandatory.error !== "MANDATORY_SKILL") {
    throw new Error(`expected MANDATORY_SKILL for ${skillId}, got ${disableMandatory.error}`);
  }
}
const sessionIds = skillManager.resolveSessionSkillIds({ enabledSkillIds: [] });
for (const skillId of expectedMandatory) {
  if (!sessionIds.includes(skillId)) {
    throw new Error(`${skillId} should merge into empty session selection`);
  }
}
const globalGuide = fs.readFileSync(path.join(tmp, "lily-config", "AGENT.md"), "utf8");
function firstGuideIndex(headings) {
  const indexes = headings
    .map((heading) => globalGuide.indexOf(heading))
    .filter((index) => index >= 0);
  return indexes.length ? Math.min(...indexes) : -1;
}
const productRulesIndex = firstGuideIndex([
  "## 工作原则",
  "## Work Principles",
]);
const contextRulesIndex = firstGuideIndex([
  "## 上下文理解",
  "## Context Understanding",
]);
const taskRulesIndex = firstGuideIndex([
  "## 任务执行",
  "## Task Execution",
]);
if (!(productRulesIndex > -1 && contextRulesIndex > productRulesIndex && taskRulesIndex > contextRulesIndex)) {
  throw new Error("mandatory rule guides should be injected in priority order");
}
const bundledRegistry = skillRegistry.loadBundledRegistry();
if (!bundledRegistry.skills.some((s) => s.id === "lily-engineering-rules")) {
  throw new Error("registry should include lily-engineering-rules");
}
if (!skillPresets.SKILL_PRESETS.find((p) => p.id === "dev-starter")?.skillIds.includes("lily-engineering-rules")) {
  throw new Error("dev-starter preset should include lily-engineering-rules");
}

const result = await skillManager.checkRegistryUpdates({ fetch: false });
if (!result.ok) {
  throw new Error(`bundled skill catalog failed: ${JSON.stringify(result)}`);
}
if (!result.bundledCatalog) {
  throw new Error("expected bundled catalog");
}
if ((result.available || []).length < 100) {
  throw new Error(`expected 100+ available skills, got ${result.available?.length || 0}`);
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log("skill-catalog: ok", result.available.length, "available");

const bundled = skillRegistry.loadBundledRegistry();
if (!bundled || (bundled.skills || []).length < 100) {
  throw new Error("bundled registry missing or too small");
}

const emptyService = {
  schemaVersion: 1,
  skills: [],
  sourceUrl: "https://service.example.com/api/plugins/registry",
  categories: [],
};
const emptyMerged = skillRegistry.mergeRegistries(emptyService, bundled);
if (!emptyMerged?.bundledFallback) {
  throw new Error("empty service registry should fall back to bundled catalog");
}
if ((emptyMerged.skills || []).length < 100) {
  throw new Error(`empty service merge expected 100+ skills, got ${emptyMerged.skills?.length || 0}`);
}

const serviceWithOne = {
  schemaVersion: 1,
  skills: [
    {
      id: "corp-only-skill",
      name: "Corp Skill",
      latestVersion: "1.0.0",
      sourceType: "zip",
      downloadUrl: "https://cdn.example.com/corp.skillpack.zip",
      sha256: "a".repeat(64),
    },
  ],
  sourceUrl: "https://service.example.com/api/plugins/registry",
  categories: [{ id: "dev", label: "Engineering" }],
};
const mixedMerged = skillRegistry.mergeRegistries(serviceWithOne, bundled);
if (!mixedMerged.skills.some((skill) => skill.id === "corp-only-skill")) {
  throw new Error("merged registry should keep service skill");
}
if (!mixedMerged.skills.some((skill) => skill.id === bundled.skills[0].id)) {
  throw new Error("merged registry should supplement bundled skills");
}
if (!mixedMerged.bundledSupplement) {
  throw new Error("mixed registry should mark bundled supplement");
}

const tmpService = fs.mkdtempSync(path.join(os.tmpdir(), "lily-skill-service-"));
const serviceClientPath = require.resolve(path.join(ROOT, "src/main/service-client.js"));
const skillManagerPath = require.resolve(path.join(ROOT, "src/main/skill-manager.js"));
delete require.cache[skillManagerPath];
require.cache[serviceClientPath] = {
  id: serviceClientPath,
  filename: serviceClientPath,
  loaded: true,
  exports: {
    getServiceSettings: () => ({
      ok: true,
      apiBaseUrl: "https://service.example.com",
      configurable: false,
    }),
    skillRegistry: async () => ({
      ok: true,
      json: {
        schemaVersion: 1,
        publisher: "Test Service",
        skills: [],
        categories: [],
      },
    }),
    reportSkillEvent: async () => ({ ok: true }),
  },
};
const skillManagerWithService = require(skillManagerPath);
fs.mkdirSync(tmpService, { recursive: true });
fs.writeFileSync(
  path.join(tmpService, "skills-state.json"),
  JSON.stringify({ schemaVersion: 1, skills: {} }),
);
process.resourcesPath = ROOT;
require.cache[electronPath].exports.app.getPath = (name) => {
  if (name === "userData") return tmpService;
  if (name === "home") return os.homedir();
  return os.tmpdir();
};
skillManagerWithService.bootstrapSkills();
const serviceResult = await skillManagerWithService.checkRegistryUpdates({ fetch: true });
if (!serviceResult.ok) {
  throw new Error(`service fallback failed: ${JSON.stringify(serviceResult)}`);
}
if ((serviceResult.available || []).length < 100) {
  throw new Error(
    `empty service should still expose bundled catalog, got ${serviceResult.available?.length || 0}`,
  );
}
if (!serviceResult.bundledCatalog) {
  throw new Error("empty service fallback should mark bundledCatalog");
}
const categoryIds = new Set((serviceResult.categories || []).map((cat) => cat.id));
if (!categoryIds.has("design") || categoryIds.size < 6) {
  throw new Error(
    `service fallback should keep bundled category tabs, got: ${[...categoryIds].join(",")}`,
  );
}

fs.rmSync(tmpService, { recursive: true, force: true });
delete require.cache[serviceClientPath];
delete require.cache[skillManagerPath];
console.log("skill-catalog: service fallback ok", serviceResult.available.length, "available");
