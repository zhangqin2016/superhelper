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
const isolatedServiceClientPath = path.join(ROOT, "src/main/service-client.js");
require.cache[isolatedServiceClientPath] = {
  id: isolatedServiceClientPath,
  filename: isolatedServiceClientPath,
  loaded: true,
  exports: {
    getServiceSettings() {
      return { ok: true, apiBaseUrl: "", configurable: false };
    },
    reportSkillEvent() {
      return Promise.resolve({ ok: true, skipped: true });
    },
  },
};
const isolatedRemoteConfigPath = path.join(ROOT, "src/main/remote-config.js");
require.cache[isolatedRemoteConfigPath] = {
  id: isolatedRemoteConfigPath,
  filename: isolatedRemoteConfigPath,
  loaded: true,
  exports: {
    getRemoteEffectiveConfigSync() {
      return null;
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
    skills: {
      "anthropics-algorithmic-art": {
        id: "anthropics-algorithmic-art",
        enabled: true,
        source: "remote",
        installedVersion: "1.0.0",
      },
      "marketing-referrals": {
        id: "marketing-referrals",
        enabled: true,
        source: "remote",
        installedVersion: "1.0.0",
      },
      "learned-demo-oa": {
        id: "learned-demo-oa",
        enabled: false,
        source: "learned",
        installedVersion: "0.1.0",
        enabledProjectIds: ["p1"],
      },
    },
  }),
);
for (const skillId of ["anthropics-algorithmic-art", "marketing-referrals", "learned-demo-oa"]) {
  const skillDir = path.join(tmp, "lily-config", "skills", skillId);
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(path.join(skillDir, "SKILL.md"), `# ${skillId}\n`, "utf8");
  fs.writeFileSync(
    path.join(skillDir, "skill.manifest.json"),
    JSON.stringify({
      schemaVersion: 1,
      id: skillId,
      name: skillId,
      description: "",
      version: "1.0.0",
      ...(skillId === "learned-demo-oa"
        ? { origin: "workspace", workspaceOnly: true, category: "workspace", publisher: "Workspace" }
        : {}),
    }, null, 2),
    "utf8",
  );
}
fs.mkdirSync(path.join(tmp, "skills-cache"), { recursive: true });
fs.writeFileSync(
  path.join(tmp, "skills-cache", "registry.json"),
  JSON.stringify({
    fetchedAt: "2026-01-01T00:00:00.000Z",
    sourceUrl: skillRegistry.BUNDLED_REGISTRY_SOURCE,
    schemaVersion: 1,
    updatedAt: "2026-01-01T00:00:00.000Z",
    publisher: "stale bundled catalog",
    categories: [{ id: "design", label: "Design" }],
    skills: [
      {
        id: "anthropics-algorithmic-art",
        name: "Algorithmic Art",
        latestVersion: "1.0.0",
        sourceType: "github",
        github: {
          repo: "anthropics/skills",
          path: "skills/algorithmic-art",
          ref: "main",
        },
      },
    ],
  }),
);
const bootstrapResult = skillManager.bootstrapSkills();

const mandatory = skillManager.MANDATORY_PLATFORM_SKILL_IDS;
const expectedMandatory = [
  "lily-workbench-rules",
  "lily-intent-router",
  "lily-context-rules",
  "lily-engineering-rules",
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
if (fs.existsSync(path.join(tmp, "lily-config", "CLAUDE.md"))) {
  throw new Error("AGENT guide generation must not create legacy CLAUDE.md mirrors");
}
if (!globalGuide.includes("Universal Operating Discipline") && !globalGuide.includes("通用执行纪律")) {
  throw new Error("AGENT guide must include universal operating discipline");
}
if (!globalGuide.includes("Prove root cause before repairing") && !globalGuide.includes("先证明根因再修复")) {
  throw new Error("AGENT guide must require root-cause proof before repair");
}
if (!globalGuide.includes("chat-native capability contracts") && !globalGuide.includes("聊天原生能力合同")) {
  throw new Error("AGENT guide must prefer chat-native capability contracts over UI-first workflows");
}
if (!globalGuide.includes("Slow is not failure") && !globalGuide.includes("慢不是失败")) {
  throw new Error("AGENT guide must forbid downgrading a long-running task just because it is slow");
}
if (
  (!globalGuide.includes("Do not run native `skill <id>`") &&
    !globalGuide.includes("禁止对这些平台能力执行原生 `skill <id>`")) ||
  !globalGuide.includes("anthropics-*")
) {
  throw new Error("AGENT guide must prevent all Lily platform catalog skills from being invoked through OpenCode's native skill tool");
}
if (!globalGuide.includes("not OpenCode native skills") && !globalGuide.includes("不是 OpenCode 原生 skill")) {
  throw new Error("AGENT guide must distinguish Lily capability guides from OpenCode native skills");
}
const subagentGuide = skillManager.buildAgentSubagentPersona("en");
if (!subagentGuide.includes("Lily Subagent Rules") || !subagentGuide.includes("Do not start another Task subagent")) {
  throw new Error(`subagent persona must carry Lily subtask rules: ${subagentGuide}`);
}
if (
  !subagentGuide.includes("not OpenCode native skills") ||
  !subagentGuide.includes("Do not run native `skill <id>`") ||
  !subagentGuide.includes("anthropics-*")
) {
  throw new Error("subagent persona must prevent all Lily platform catalog skills from being invoked through OpenCode's native skill tool");
}
if (!subagentGuide.includes("capability used") || !subagentGuide.includes("evidence")) {
  throw new Error(`subagent persona must return capability/evidence handoff: ${subagentGuide}`);
}
const guidePath = path.join(tmp, "lily-config", "AGENT.md");
fs.writeFileSync(guidePath, "# User AGENT additions\n\nKeep this custom rule.\n", "utf8");
skillManager.mergeAgentGuide();
skillManager.mergeAgentGuide();
const mergedCustomGuide = fs.readFileSync(guidePath, "utf8");
if (!mergedCustomGuide.includes("Keep this custom rule.")) {
  throw new Error("AGENT guide merge must preserve user-authored content");
}
if (!mergedCustomGuide.includes("Universal Operating Discipline") && !mergedCustomGuide.includes("通用执行纪律")) {
  throw new Error("AGENT guide merge must still include the full Lily managed guide");
}
if ((mergedCustomGuide.match(/Keep this custom rule\./g) || []).length !== 1) {
  throw new Error("AGENT guide merge should not duplicate preserved user content");
}
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
const intentRulesIndex = firstGuideIndex([
  "## 意图识别与任务分流",
  "## 意图识别与技能路由",
  "## Intent Routing",
  "## Intent routing & skill selection",
]);
const contextRulesIndex = firstGuideIndex([
  "## 上下文理解",
  "## Context Understanding",
]);
const taskRulesIndex = firstGuideIndex([
  "## 任务执行",
  "## Task Execution",
]);
const engineeringRulesIndex = firstGuideIndex([
  "## 工程协作规则",
  "## Engineering Rules",
]);
if (!(
  productRulesIndex > -1 &&
  intentRulesIndex > productRulesIndex &&
  contextRulesIndex > intentRulesIndex &&
  engineeringRulesIndex > contextRulesIndex &&
  taskRulesIndex > engineeringRulesIndex
)) {
  throw new Error("mandatory rule guides should be injected in priority order");
}
const bundledRegistry = skillRegistry.loadBundledRegistry();
if (!bundledRegistry.skills.some((s) => s.id === "lily-coding-core")) {
  throw new Error("registry should include lily-coding-core");
}
if (!bundledRegistry.skills.some((s) => s.id === "lily-office-intent")) {
  throw new Error("registry should include lily-office-intent");
}
if (!bundledRegistry.skills.some((s) => s.id === "lily-ui-quality")) {
  throw new Error("registry should include lily-ui-quality");
}
if (!bundledRegistry.skills.some((s) => s.id === "lily-browser-qa")) {
  throw new Error("registry should include lily-browser-qa");
}
if (!bundledRegistry.skills.some((s) => s.id === "lily-creative-director")) {
  throw new Error("registry should include lily-creative-director");
}
for (const skillId of [
  "lily-app-builder",
  "lily-code-repair",
  "lily-research-synthesis",
  "lily-image-qa",
  "lily-prompt-enhancer",
  "lily-web-system-learning",
  "lily-pdf-extraction-router",
  "lily-excel-data-analysis",
  "lily-ppt-design-qa",
  "lily-document-query",
  "lily-skill-quality-gate",
  "lily-intent-eval",
]) {
  if (!bundledRegistry.skills.some((s) => s.id === skillId)) {
    throw new Error(`registry should include ${skillId}`);
  }
}
const registryById = new Map((bundledRegistry.skills || []).map((skill) => [skill.id, skill]));
for (const skillId of ["lily-stock-research", "lily-skill-quality-gate", "lily-intent-eval"]) {
  const skill = registryById.get(skillId);
  if (!skill?.defaultEligible) {
    throw new Error(`${skillId} must be default eligible so core non-high-risk capabilities are not silently unavailable`);
  }
}
for (const skillId of ["lily-web-system-learning", "lily-mail-assistant"]) {
  const skill = registryById.get(skillId);
  if (skill?.defaultEligible) {
    throw new Error(`${skillId} is high-risk/on-demand and must not be auto-enabled by default`);
  }
}
for (const skill of bundledRegistry.skills || []) {
  if (skill.defaultEligible === false && skill.riskLevel !== "high") {
    throw new Error(`${skill.id} is ${skill.riskLevel || "unknown"} risk but defaultEligible=false; add an on-demand enabler or make it default`);
  }
}
if (!skillPresets.SKILL_PRESETS.find((p) => p.id === "dev-starter")?.skillIds.includes("lily-coding-core")) {
  throw new Error("dev-starter preset should include lily-coding-core");
}
if (!skillPresets.SKILL_PRESETS.find((p) => p.id === "dev-starter")?.skillIds.includes("lily-app-builder")) {
  throw new Error("dev-starter preset should include lily-app-builder");
}
if (!skillPresets.SKILL_PRESETS.find((p) => p.id === "dev-starter")?.skillIds.includes("lily-code-repair")) {
  throw new Error("dev-starter preset should include lily-code-repair");
}
if (!skillPresets.SKILL_PRESETS.find((p) => p.id === "dev-starter")?.skillIds.includes("lily-ui-quality")) {
  throw new Error("dev-starter preset should include lily-ui-quality");
}
if (!skillPresets.SKILL_PRESETS.find((p) => p.id === "dev-starter")?.skillIds.includes("lily-browser-qa")) {
  throw new Error("dev-starter preset should include lily-browser-qa");
}
if (skillPresets.SKILL_PRESETS.find((p) => p.id === "dev-starter")?.skillIds.includes("lily-creative-director")) {
  throw new Error("dev-starter preset should not include lily-creative-director");
}
if (!skillPresets.SKILL_PRESETS.find((p) => p.id === "creative-starter")?.skillIds.includes("lily-creative-director")) {
  throw new Error("creative-starter preset should include lily-creative-director");
}

const result = await skillManager.checkRegistryUpdates({ fetch: false });
if (!result.ok) {
  throw new Error(`bundled skill catalog failed: ${JSON.stringify(result)}`);
}
if (!result.bundledCatalog) {
  throw new Error("expected bundled catalog");
}
if ((result.available || []).length !== 28) {
  throw new Error(`expected 28 curated available skills, got ${result.available?.length || 0}`);
}
if (!result.available.find((skill) => skill.id === "lily-stock-research")) {
  throw new Error("curated catalog should include the stock research skill used by the stock app");
}
if (!result.available.find((skill) => skill.id === "lily-mail-assistant")) {
  throw new Error("curated catalog should include the mail assistant connector skill");
}
for (const staleId of ["anthropics-algorithmic-art", "marketing-referrals"]) {
  if (!(bootstrapResult.pruned || []).includes(staleId)) {
    throw new Error(`expected stale installed skill ${staleId} to be pruned on bootstrap`);
  }
  if (skillManager.listSkillsPublic().some((skill) => skill.id === staleId)) {
    throw new Error(`stale installed skill ${staleId} should not remain visible`);
  }
  if (fs.existsSync(path.join(tmp, "lily-config", "skills", staleId))) {
    throw new Error(`stale installed skill directory ${staleId} should be removed`);
  }
}
if ((bootstrapResult.pruned || []).includes("learned-demo-oa")) {
  throw new Error("learned workspace skills must not be pruned by registry refresh");
}
const learnedSkill = skillManager.listSkillsPublic().find((skill) => skill.id === "learned-demo-oa");
if (!learnedSkill || learnedSkill.source !== "learned" || learnedSkill.origin !== "workspace") {
  throw new Error(`learned workspace skill should survive registry refresh: ${JSON.stringify(learnedSkill)}`);
}
if (!fs.existsSync(path.join(tmp, "lily-config", "skills", "learned-demo-oa"))) {
  throw new Error("learned workspace skill directory should survive registry refresh");
}
const projectBoundIds = skillManager.resolveSessionSkillIds({ projectId: "p1", enabledSkillIds: null });
if (!projectBoundIds.includes("learned-demo-oa")) {
  throw new Error("learned workspace skill should auto-enable for new chats in its bound project");
}
// An explicit per-conversation selection is authoritative: a workspace skill the
// user left unchecked must NOT be silently re-added (otherwise the "本对话技能"
// checkbox lies and the assistant keeps seeing a system turned off for this chat).
const customProjectBoundIds = skillManager.resolveSessionSkillIds({ projectId: "p1", enabledSkillIds: [] });
if (customProjectBoundIds.includes("learned-demo-oa")) {
  throw new Error("explicit selection must be authoritative — an unchecked workspace skill must not be re-added");
}
// ...but a workspace skill the user explicitly keeps checked is honored.
const customKeepWsIds = skillManager.resolveSessionSkillIds({ projectId: "p1", enabledSkillIds: ["learned-demo-oa"] });
if (!customKeepWsIds.includes("learned-demo-oa")) {
  throw new Error("an explicitly selected workspace skill should be present");
}
const otherProjectIds = skillManager.resolveSessionSkillIds({ projectId: "p2", enabledSkillIds: null });
if (otherProjectIds.includes("learned-demo-oa")) {
  throw new Error("learned workspace skill should not auto-enable in unrelated projects");
}
const exportsForP1 = skillManager.listWorkspaceSkillExports("p1");
const exportsForP2 = skillManager.listWorkspaceSkillExports("p2");
if (!exportsForP1.some((skill) => skill.id === "learned-demo-oa")) {
  throw new Error("workspace skill export should include skills bound to the selected project");
}
if (exportsForP2.some((skill) => skill.id === "learned-demo-oa")) {
  throw new Error("workspace skill export should not leak skills from another project");
}
const draftDir = path.join(tmp, "draft-web-skill");
fs.mkdirSync(path.join(draftDir, "scripts"), { recursive: true });
fs.writeFileSync(
  path.join(draftDir, "SKILL.md"),
  'run "{{NODE_BIN}}" "{{WEB_SYSTEM_EXECUTOR}}" --playbook "{{WEB_SYSTEM_PLAYBOOK}}"\n',
  "utf8",
);
fs.writeFileSync(
  path.join(draftDir, "skill.manifest.json"),
  JSON.stringify({
    schemaVersion: 1,
    id: "demo-web",
    name: "Demo Web",
    description: "",
    version: "1.0.0",
    origin: "workspace",
    workspaceOnly: true,
    placeholders: {
      "{{WEB_SYSTEM_EXECUTOR}}": "scripts/execute_web_playbook.cjs",
      "{{WEB_SYSTEM_PLAYBOOK}}": "web-system-playbook.json",
    },
  }, null, 2),
  "utf8",
);
fs.writeFileSync(path.join(draftDir, "scripts/execute_web_playbook.cjs"), "console.log('ok')\n", "utf8");
fs.writeFileSync(path.join(draftDir, "web-system-playbook.json"), "{}\n", "utf8");
const learnedId = skillManager.registerLearnedSkillDir(draftDir, { id: "demo-web", version: "1.0.0" }, { projectId: "p1" });
if (learnedId !== "learned-demo-web") {
  throw new Error(`learned skill should be normalized with learned- prefix, got ${learnedId}`);
}
const installedMd = fs.readFileSync(path.join(tmp, "lily-config", "skills", "learned-demo-web", "SKILL.md"), "utf8");
if (installedMd.includes("{{WEB_SYSTEM") || installedMd.includes("{{NODE_BIN}}")) {
  throw new Error(`learned skill placeholders should be resolved at install time: ${installedMd}`);
}
if (!installedMd.includes(path.join(tmp, "lily-config", "skills", "learned-demo-web", "scripts", "execute_web_playbook.cjs"))) {
  throw new Error(`learned skill should resolve executor to its installed absolute path: ${installedMd}`);
}

// Regression: the user must be able to uninstall a skill they learned. The bug
// was canUninstall=false (no button) + an uninstall guard that rejected any
// non-"remote" source, so learned skills were impossible to remove.
const learnedBeforeUninstall = skillManager.listSkillsPublic().find((s) => s.id === "learned-demo-web");
if (!learnedBeforeUninstall || learnedBeforeUninstall.canUninstall !== true) {
  throw new Error(`learned skill must report canUninstall=true, got ${JSON.stringify(learnedBeforeUninstall)}`);
}
const learnedUninstall = skillManager.uninstallRemoteSkill("learned-demo-web");
if (!learnedUninstall || learnedUninstall.ok !== true) {
  throw new Error(`learned skill uninstall should succeed, got ${JSON.stringify(learnedUninstall)}`);
}
if (fs.existsSync(path.join(tmp, "lily-config", "skills", "learned-demo-web"))) {
  throw new Error("learned skill directory should be removed after uninstall");
}
if (skillManager.listSkillsPublic().some((s) => s.id === "learned-demo-web")) {
  throw new Error("learned skill should be gone from the skills list after uninstall");
}
for (const skill of result.available || []) {
  if (/^(marketing|pm|tob|superpowers)-/.test(skill.id)) {
    throw new Error(`curated catalog should not expose low-signal skill ${skill.id}`);
  }
  if (/^Lily\s/.test(skill.name) || ["Docx", "Xlsx", "Pdf", "Pptx"].includes(skill.name)) {
    throw new Error(`curated catalog should expose user-facing skill names, got ${skill.id}: ${skill.name}`);
  }
}
for (const rawDevSkillId of [
  "lily-engineering-rules",
  "anthropics-frontend-design",
  "anthropics-webapp-testing",
]) {
  if ((result.available || []).some((skill) => skill.id === rawDevSkillId)) {
    throw new Error(`default catalog should expose lily-coding-core instead of raw skill ${rawDevSkillId}`);
  }
}
const installedDocx = await skillManager.installFromRegistry("anthropics-docx");
if (!installedDocx.ok) {
  throw new Error(`expected anthropics-docx install to succeed: ${JSON.stringify(installedDocx)}`);
}
const publicDocx = skillManager.listSkillsPublic().find((skill) => skill.id === "anthropics-docx");
if (publicDocx?.category !== "office") {
  throw new Error(`installed registry skill should keep category metadata, got ${publicDocx?.category || "empty"}`);
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log("skill-catalog: ok", result.available.length, "available");

const bundled = skillRegistry.loadBundledRegistry();
if (!bundled || (bundled.skills || []).length !== 29) {
  throw new Error(`bundled registry should contain 29 curated skills, got ${bundled?.skills?.length || 0}`);
}
if (!bundled.skills.find((skill) => skill.id === "lily-stock-research")) {
  throw new Error("bundled registry should include lily-stock-research");
}
if (!bundled.skills.find((skill) => skill.id === "lily-mail-assistant")) {
  throw new Error("bundled registry should include lily-mail-assistant");
}
if (!bundled.skills.find((skill) => skill.id === "lily-engineering-rules")) {
  throw new Error("bundled registry should include lily-engineering-rules");
}

const emptyService = {
  schemaVersion: 1,
  skills: [],
  sourceUrl: "https://service.example.com/api/skills/registry",
  categories: [],
};
const emptyMerged = skillRegistry.mergeRegistries(emptyService, bundled);
if (!emptyMerged?.bundledFallback) {
  throw new Error("empty service registry should fall back to bundled catalog");
}
if ((emptyMerged.skills || []).length !== 29) {
  throw new Error(`empty service merge expected 29 curated skills, got ${emptyMerged.skills?.length || 0}`);
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
  sourceUrl: "https://service.example.com/api/skills/registry",
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
if ((serviceResult.available || []).length !== 28) {
  throw new Error(
    `empty service should still expose curated bundled catalog, got ${serviceResult.available?.length || 0}`,
  );
}
if (!serviceResult.available.find((skill) => skill.id === "lily-stock-research")) {
  throw new Error("empty service fallback should include lily-stock-research");
}
if (!serviceResult.available.find((skill) => skill.id === "lily-mail-assistant")) {
  throw new Error("empty service fallback should include lily-mail-assistant");
}
if (!serviceResult.bundledCatalog) {
  throw new Error("empty service fallback should mark bundledCatalog");
}
const categoryIds = new Set((serviceResult.categories || []).map((cat) => cat.id));
if (
  !categoryIds.has("office") ||
  !categoryIds.has("dev") ||
  !categoryIds.has("design") ||
  !categoryIds.has("media") ||
  !categoryIds.has("research") ||
  !categoryIds.has("quality") ||
  categoryIds.size !== 6
) {
  throw new Error(
    `service fallback should keep curated category tabs, got: ${[...categoryIds].join(",")}`,
  );
}

fs.rmSync(tmpService, { recursive: true, force: true });
delete require.cache[serviceClientPath];
delete require.cache[skillManagerPath];
console.log("skill-catalog: service fallback ok", serviceResult.available.length, "available");

const tmpServiceCurated = fs.mkdtempSync(path.join(os.tmpdir(), "lily-skill-service-curated-"));
delete require.cache[skillManagerPath];
const originalFetch = global.fetch;
const curatedSkill = {
  id: "corp-default-skill",
  name: "Corp Default Skill",
  latestVersion: "1.0.0",
  sourceType: "zip",
  downloadUrl: "https://cdn.example.com/corp-default.skillpack.zip",
  sha256: "b".repeat(64),
  category: "coding",
  categoryLabel: "编程创作",
  capabilityLayer: "workflow",
  riskLevel: "low",
  defaultEligible: true,
  featured: true,
};
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
    reportSkillEvent: async () => ({ ok: true }),
  },
};
global.fetch = async (url) => {
  if (String(url) !== "https://service.example.com/api/skills/registry") {
    throw new Error(`unexpected fetch ${url}`);
  }
  return {
    ok: true,
    status: 200,
    json: async () => ({
      schemaVersion: 1,
      publisher: "Test Service",
      registryUrl: "https://service.example.com/api/skills/registry",
      skills: [curatedSkill],
      categories: [{ id: "coding", label: "编程创作" }],
    }),
  };
};
require.cache[electronPath].exports.app.getPath = (name) => {
  if (name === "userData") return tmpServiceCurated;
  if (name === "home") return os.homedir();
  return os.tmpdir();
};
const skillManagerCurated = require(skillManagerPath);
const skillInstaller = require(path.join(ROOT, "src/main/skill-installer.js"));
skillInstaller.installFromRegistryEntry = async (entry) => {
  const dir = skillManagerCurated.installedSkillDir(entry.id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "SKILL.md"), `# ${entry.name}\n`, "utf8");
  fs.writeFileSync(
    path.join(dir, "skill.manifest.json"),
    JSON.stringify({
      schemaVersion: 1,
      id: entry.id,
      name: "Stale Manifest Name",
      description: "Stale manifest description",
      version: entry.latestVersion,
    }, null, 2),
    "utf8",
  );
  const state = skillManagerCurated.loadSkillsState();
  state.skills[entry.id] = {
    id: entry.id,
    enabled: true,
    source: "remote",
    installedVersion: entry.latestVersion,
    sha256: entry.sha256,
  };
  skillManagerCurated.saveSkillsState();
  return { ok: true, id: entry.id, version: entry.latestVersion };
};

skillManagerCurated.bootstrapSkills();
const curatedResult = await skillManagerCurated.checkRegistryUpdates({ fetch: true });
if (!curatedResult.serviceCatalog || !curatedResult.bundledCatalog) {
  throw new Error("service registry should stay authoritative while bundled catalog fills missing built-ins");
}
if (!curatedResult.available.find((skill) => skill.id === curatedSkill.id)) {
  throw new Error("curated service registry should keep service skills");
}
if (!curatedResult.available.find((skill) => skill.id === "lily-web-system-learning")) {
  throw new Error("service registry should be supplemented with bundled-only skills");
}
const curatedAvailable = curatedResult.available.find((skill) => skill.id === curatedSkill.id);
if (!curatedAvailable?.defaultEligible || curatedAvailable.capabilityLayer !== "workflow") {
  throw new Error("curated skill metadata should be preserved for UI and auto-sync");
}
const syncResult = await skillManagerCurated.syncServiceSkillPackages({ fetch: true });
if (!syncResult.ok || !syncResult.installed.includes(curatedSkill.id)) {
  throw new Error(`defaultEligible service skill should auto-install: ${JSON.stringify(syncResult)}`);
}
const installedCurated = skillManagerCurated.listSkillsPublic().find((skill) => skill.id === curatedSkill.id);
if (!installedCurated?.enabled || !installedCurated.defaultEligible || installedCurated.category !== "coding") {
  throw new Error("auto-synced skill should be installed, enabled, and keep service metadata");
}
if (installedCurated.name !== curatedSkill.name) {
  throw new Error(`remote installed skill should prefer registry display name, got ${installedCurated.name}`);
}

curatedSkill.latestVersion = "1.0.1";
const curatedDir = skillManagerCurated.installedSkillDir(curatedSkill.id);
const curatedManifestPath = path.join(curatedDir, "skill.manifest.json");
fs.writeFileSync(
  curatedManifestPath,
  JSON.stringify({
    schemaVersion: 1,
    id: curatedSkill.id,
    name: "Bundled Stale Skill",
    description: "Stale bundled manifest description",
    version: "1.0.0",
  }, null, 2),
  "utf8",
);
const staleState = skillManagerCurated.loadSkillsState();
staleState.skills[curatedSkill.id] = {
  id: curatedSkill.id,
  enabled: true,
  source: "bundled",
  installedVersion: "1.0.0",
};
skillManagerCurated.saveSkillsState();
const bundledSourceSync = await skillManagerCurated.syncServiceSkillPackages({ fetch: true });
if (!bundledSourceSync.ok || !bundledSourceSync.updated.includes(curatedSkill.id)) {
  throw new Error(`defaultEligible service skill should update stale bundled installs: ${JSON.stringify(bundledSourceSync)}`);
}
const updatedBundledSource = skillManagerCurated.listSkillsPublic().find((skill) => skill.id === curatedSkill.id);
if (updatedBundledSource?.version !== "1.0.1" || updatedBundledSource.source !== "remote") {
  throw new Error(`stale bundled service skill should become remote 1.0.1: ${JSON.stringify(updatedBundledSource)}`);
}
fs.rmSync(tmpServiceCurated, { recursive: true, force: true });
global.fetch = originalFetch;
delete require.cache[serviceClientPath];
delete require.cache[skillManagerPath];
console.log("skill-catalog: curated service registry ok", curatedResult.available.length, "available");
