"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { PROJECT_ROOT, userDataPath, agentConfigDir, agentGuidePath, sessionGuideDir } = require("./config");
const { syncEngineGuideMirror } = require("./agent-guide-mirror");
const { ensureRuntimeNodeShim, resolveRuntimeNodePath } = require("./runtime-node");
const { compareSemver, isAppVersionCompatible } = require("./skill-version");
const skillRegistry = require("./skill-registry");
const skillInstaller = require("./skill-installer");

const BUNDLED_SKILL_IDS = ["lily-vision", "websearch", "webfetch"];

const PROTECTED_BUNDLED_IDS = new Set(BUNDLED_SKILL_IDS);

/** @type {{ schemaVersion: number, skills: Record<string, { id: string, enabled: boolean, source: string, installedVersion?: string, bundledVersion?: string }> } | null} */
let skillsStateCache = null;

function skillsStatePath() {
  return userDataPath("skills-state.json");
}

function bundledResourceCandidates(relativePath) {
  const candidates = [
    path.join(process.resourcesPath, relativePath),
    path.join(PROJECT_ROOT, relativePath),
  ];
  return candidates.find((p) => fs.existsSync(p)) || null;
}

function bundledSkillSource(skillId) {
  return bundledResourceCandidates(path.join("resources", "skills", skillId));
}

function installedSkillDir(skillId) {
  return path.join(agentConfigDir(), "skills", skillId);
}

function readJsonFile(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function copyDirRecursive(source, target) {
  fs.mkdirSync(target, { recursive: true });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const src = path.join(source, entry.name);
    const dst = path.join(target, entry.name);
    if (entry.isDirectory()) {
      copyDirRecursive(src, dst);
    } else {
      fs.copyFileSync(src, dst);
      if (
        process.platform !== "win32" &&
        (entry.name.endsWith(".js") || entry.name.endsWith(".cjs"))
      ) {
        fs.chmodSync(dst, 0o755);
      }
    }
  }
}

function applyPlaceholders(content, replacements) {
  let out = content;
  for (const [from, to] of Object.entries(replacements)) {
    out = out.replaceAll(from, to);
  }
  return out;
}

function loadManifestFromDir(skillDir) {
  const manifestPath = path.join(skillDir, "skill.manifest.json");
  if (!fs.existsSync(manifestPath)) return null;
  const raw = readJsonFile(manifestPath);
  if (!raw || raw.schemaVersion !== 1 || !raw.id) return null;
  return raw;
}

function readBundledManifest(skillId) {
  const source = bundledSkillSource(skillId);
  if (!source) return null;
  return loadManifestFromDir(source);
}

function readInstalledManifest(skillId) {
  return loadManifestFromDir(installedSkillDir(skillId));
}

function buildReplacements(skillDir, manifest) {
  ensureRuntimeNodeShim();
  const nodeBin = resolveRuntimeNodePath();
  const replacements = {
    "{{NODE_BIN}}": nodeBin,
    "{{SKILL_DIR}}": skillDir,
    "{{USER_DATA}}": userDataPath(),
  };
  const custom = manifest?.placeholders;
  if (custom && typeof custom === "object") {
    for (const [key, relPath] of Object.entries(custom)) {
      replacements[key] = path.join(skillDir, relPath);
    }
  }
  return replacements;
}

function loadSkillsState() {
  if (skillsStateCache) return skillsStateCache;
  const filePath = skillsStatePath();
  let parsed = readJsonFile(filePath);
  if (
    !parsed ||
    parsed.schemaVersion !== 1 ||
    !parsed.skills ||
    typeof parsed.skills !== "object" ||
    Array.isArray(parsed.skills)
  ) {
    parsed = { schemaVersion: 1, skills: {} };
  }
  skillsStateCache = parsed;
  return parsed;
}

function saveSkillsState() {
  const state = loadSkillsState();
  const dir = path.dirname(skillsStatePath());
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(skillsStatePath(), JSON.stringify(state, null, 2), "utf8");
}

function ensureSkillsStateDefaults() {
  const state = loadSkillsState();
  let changed = false;
  for (const skillId of BUNDLED_SKILL_IDS) {
    const manifest = readBundledManifest(skillId);
    if (!manifest) continue;
    if (!state.skills[skillId]) {
      state.skills[skillId] = {
        id: skillId,
        enabled: true,
        source: "bundled",
        installedVersion: manifest.version,
        bundledVersion: manifest.version,
      };
      changed = true;
      continue;
    }
    const entry = state.skills[skillId];
    if (entry.bundledVersion !== manifest.version) {
      entry.bundledVersion = manifest.version;
      changed = true;
    }
    if (entry.enabled === undefined) {
      entry.enabled = true;
      changed = true;
    }
    if (!entry.source) {
      entry.source = "bundled";
      changed = true;
    }
  }
  if (changed) saveSkillsState();
}

function isSkillEnabled(skillId) {
  ensureSkillsStateDefaults();
  const entry = loadSkillsState().skills[skillId];
  if (!entry) return false;
  return entry.enabled !== false;
}

function installSkillFromSource(skillId, { force = false } = {}) {
  const source = bundledSkillSource(skillId);
  const target = installedSkillDir(skillId);
  const manifestPath = path.join(target, "skill.manifest.json");

  if (!source) {
    return { id: skillId, installed: false };
  }

  if (!force && fs.existsSync(manifestPath)) {
    return { id: skillId, installed: true, skillDir: target };
  }

  if (force && fs.existsSync(target)) {
    fs.rmSync(target, { recursive: true, force: true });
  }

  copyDirRecursive(source, target);

  const manifest = loadManifestFromDir(target);
  if (!manifest) {
    return { id: skillId, installed: false };
  }

  const replacements = buildReplacements(target, manifest);

  const skillMdPath = path.join(target, "SKILL.md");
  if (fs.existsSync(skillMdPath)) {
    const skillMd = applyPlaceholders(fs.readFileSync(skillMdPath, "utf8"), replacements);
    fs.writeFileSync(skillMdPath, skillMd, "utf8");
  }

  const state = loadSkillsState();
  const now = new Date().toISOString();
  if (!state.skills[skillId]) {
    state.skills[skillId] = {
      id: skillId,
      enabled: true,
      source: "bundled",
      installedAt: now,
    };
  }
  state.skills[skillId].installedVersion = manifest.version;
  state.skills[skillId].bundledVersion = manifest.version;
  state.skills[skillId].source = "bundled";
  state.skills[skillId].updatedAt = now;
  saveSkillsState();

  return { id: skillId, installed: true, skillDir: target, version: manifest.version };
}

function ensureBundledPresent() {
  ensureSkillsStateDefaults();
  const installed = [];
  for (const skillId of BUNDLED_SKILL_IDS) {
    const bundledManifest = readBundledManifest(skillId);
    const installedManifest = readInstalledManifest(skillId);
    const needsUpgrade =
      Boolean(bundledManifest) &&
      Boolean(installedManifest) &&
      compareSemver(bundledManifest.version, installedManifest.version) > 0;
    installed.push(installSkillFromSource(skillId, { force: needsUpgrade }));
  }
  return installed;
}

function getEnabledInstalledSkills() {
  return getSkillsForIds(getGloballyEnabledSkillIds());
}

function getAllInstalledSkillIds() {
  ensureSkillsStateDefaults();
  const ids = new Set();
  for (const skillId of Object.keys(loadSkillsState().skills)) {
    if (readInstalledManifest(skillId)) ids.add(skillId);
  }
  for (const skillId of BUNDLED_SKILL_IDS) {
    if (readInstalledManifest(skillId)) ids.add(skillId);
  }
  return [...ids];
}

function getGloballyEnabledSkillIds() {
  ensureSkillsStateDefaults();
  const ids = [];
  for (const skillId of getAllInstalledSkillIds()) {
    if (isSkillEnabled(skillId)) ids.push(skillId);
  }
  return ids;
}

function getSkillsForIds(skillIds) {
  const skills = [];
  for (const skillId of skillIds || []) {
    const skillDir = installedSkillDir(skillId);
    const manifest = loadManifestFromDir(skillDir);
    if (!manifest) continue;
    skills.push({ id: skillId, skillDir, manifest });
  }
  skills.sort(
    (a, b) =>
      (manifestGuide(a.manifest)?.priority ?? 100) -
      (manifestGuide(b.manifest)?.priority ?? 100),
  );
  return skills;
}

function sameIdSet(a, b) {
  const sa = new Set(a || []);
  const sb = new Set(b || []);
  if (sa.size !== sb.size) return false;
  for (const id of sa) {
    if (!sb.has(id)) return false;
  }
  return true;
}

function resolveSessionSkillIds(session) {
  const installed = new Set(getAllInstalledSkillIds());
  if (!session || session.enabledSkillIds == null) {
    return getGloballyEnabledSkillIds().filter((id) => installed.has(id));
  }
  if (!Array.isArray(session.enabledSkillIds)) {
    return getGloballyEnabledSkillIds().filter((id) => installed.has(id));
  }
  return session.enabledSkillIds.filter((id) => installed.has(id));
}

function isSessionSkillCustomized(session) {
  return session != null && session.enabledSkillIds != null && Array.isArray(session.enabledSkillIds);
}

function buildAgentGuideContent(enabledSkills) {
  const sections = [
    "# 智能工作台全局说明",
    "",
    "你是智能工作台（Lily Workbench）助手。不要自称 Claude，不要提及 Anthropic。",
    "",
    "## 身份问答（必读）",
    "",
    "当用户问「你是谁」「你叫什么」「介绍一下你自己」或类似问题时：",
    "- 只回答：智能工作台助手（或 Lily Workbench 助手）。",
    "- 说明你是帮助用户在本机项目中完成写作、查资料、读文件、识图等任务的桌面助手。",
    "- 禁止说自己是 Claude、Claude Code、Anthropic 的产品或模型。",
    "- 若用户追问底层技术，可笼统说「由大语言模型驱动」，不要透露上游厂商或产品名。",
    "",
  ];
  let lastTitle = null;

  for (const skill of enabledSkills) {
    const guide = manifestGuide(skill.manifest);
    const bodyTemplate = guide?.body;
    const title = guide?.title;
    if (!bodyTemplate || !title) continue;

    const replacements = buildReplacements(skill.skillDir, skill.manifest);
    let body = applyPlaceholders(bodyTemplate, replacements);

    if (lastTitle === title) {
      sections.push(body, "");
    } else {
      sections.push(`## ${title}`, "", body, "");
      lastTitle = title;
    }
  }

  return sections.join("\n").trim() + "\n";
}

function writeSessionAgentGuide(sessionId, session) {
  ensureRuntimeNodeShim();
  const skillIds = resolveSessionSkillIds(session);
  const skills = getSkillsForIds(skillIds);
  const configDir = sessionGuideDir(sessionId);
  fs.mkdirSync(configDir, { recursive: true });
  ensureSessionConfigBridge(configDir);
  const guidePath = path.join(configDir, "AGENT.md");
  fs.writeFileSync(guidePath, buildAgentGuideContent(skills), "utf8");
  syncEngineGuideMirror(guidePath, configDir);
  return configDir;
}

function listSkillsForSessionPublic(session) {
  const installed = listSkillsPublic();
  const effectiveIds = new Set(resolveSessionSkillIds(session));
  const customized = isSessionSkillCustomized(session);
  return {
    customized,
    effectiveIds: [...effectiveIds],
    skills: installed.map((skill) => ({
      id: skill.id,
      name: skill.name,
      description: skill.description,
      globallyEnabled: skill.enabled,
      sessionEnabled: effectiveIds.has(skill.id),
    })),
  };
}

function normalizeSessionSkillSelection(enabledSkillIds) {
  if (enabledSkillIds == null) return null;
  const installed = new Set(getAllInstalledSkillIds());
  const normalized = [...new Set((enabledSkillIds || []).filter((id) => installed.has(id)))];
  if (sameIdSet(normalized, getGloballyEnabledSkillIds())) {
    return null;
  }
  return normalized;
}

function syncInheritedSessionGuides(sessionManager) {
  if (!sessionManager || typeof sessionManager.iterateSessions !== "function") return;
  for (const session of sessionManager.iterateSessions()) {
    if (isSessionSkillCustomized(session)) continue;
    writeSessionAgentGuide(session.id, session);
  }
}

function manifestGuide(manifest) {
  return manifest?.guideMd || manifest?.claudeMd || null;
}

/** Link global skills/settings into per-session CLAUDE_CONFIG_DIR for engine discovery. */
function ensureSessionConfigBridge(configDir) {
  const globalRoot = agentConfigDir();
  const links = [
    { rel: "skills", type: "dir" },
    { rel: "settings.json", type: "file" },
  ];
  for (const { rel, type } of links) {
    const src = path.join(globalRoot, rel);
    const dest = path.join(configDir, rel);
    if (!fs.existsSync(src) || fs.existsSync(dest)) continue;
    try {
      if (type === "dir") {
        const symlinkType = process.platform === "win32" ? "junction" : "dir";
        fs.symlinkSync(src, dest, symlinkType);
      } else {
        fs.symlinkSync(src, dest, "file");
      }
    } catch {
      // Non-fatal: AGENT.md still carries inlined guide with absolute script paths.
    }
  }
}

function mergeAgentGuide() {
  ensureRuntimeNodeShim();
  const configDir = agentConfigDir();
  fs.mkdirSync(configDir, { recursive: true });

  const enabled = getEnabledInstalledSkills();
  const guidePath = agentGuidePath();
  fs.writeFileSync(guidePath, buildAgentGuideContent(enabled), "utf8");
  syncEngineGuideMirror(guidePath, configDir);
}

function getDisallowedTools() {
  return ["WebSearch", "WebFetch"];
}

function getRegistryUrl() {
  const state = loadSkillsState();
  return state.registryUrl || "";
}

function setRegistryUrl(url) {
  const trimmed = String(url || "").trim();
  if (trimmed && !skillRegistry.isValidRegistryUrl(trimmed)) {
    return { ok: false, error: "INVALID_URL" };
  }
  const state = loadSkillsState();
  state.registryUrl = trimmed || null;
  saveSkillsState();
  return { ok: true, registryUrl: trimmed };
}

function skillToPublic(skillId, entry, manifest, registryEntry) {
  const installedVersion = entry?.installedVersion || manifest?.version || "0.0.0";
  const latestVersion = registryEntry?.latestVersion || null;
  const updateAvailable =
    latestVersion && compareSemver(latestVersion, installedVersion) > 0;

  return {
    id: skillId,
    name: manifest?.name || registryEntry?.name || skillId,
    description: manifest?.description || "",
    version: installedVersion,
    latestVersion,
    source: entry?.source || (registryEntry ? "remote" : "local"),
    enabled: entry?.enabled !== false,
    permissions: {
      network: Boolean(manifest?.permissions?.network ?? registryEntry?.permissions?.network),
      filesystem: manifest?.permissions?.filesystem || "none",
    },
    canDisable: Boolean(manifest || entry),
    canRestore: PROTECTED_BUNDLED_IDS.has(skillId),
    canUninstall: entry?.source === "remote",
    updateAvailable,
    changelog: registryEntry?.changelog || "",
  };
}

function availableSkillToPublic(registryEntry, installedVersion) {
  const updateAvailable =
    installedVersion && compareSemver(registryEntry.latestVersion, installedVersion) > 0;

  return {
    id: registryEntry.id,
    name: registryEntry.name,
    description: registryEntry.description || registryEntry.changelog || "",
    version: installedVersion || null,
    latestVersion: registryEntry.latestVersion,
    source: "remote",
    enabled: false,
    permissions: { network: true, filesystem: "none" },
    canDisable: false,
    canRestore: false,
    canUninstall: false,
    canInstall: !installedVersion || updateAvailable,
    updateAvailable: Boolean(updateAvailable),
    changelog: registryEntry.changelog || "",
    minAppVersion: registryEntry.minAppVersion,
    compatible: isAppVersionCompatible(registryEntry.minAppVersion),
    category: registryEntry.category || null,
    categoryLabel: registryEntry.categoryLabel || null,
    publisher: registryEntry.publisher || null,
    sourceType: registryEntry.sourceType || "zip",
  };
}

async function resolveRegistry({ fetch = true } = {}) {
  const userUrl = getRegistryUrl();
  if (userUrl) {
    if (fetch) {
      return skillRegistry.fetchRegistry(userUrl);
    }
    const cached = skillRegistry.loadCachedRegistry();
    if (!cached || cached.sourceUrl !== userUrl) {
      return { ok: false, error: "NETWORK", detail: "尚无缓存，请先检查更新" };
    }
    return { ok: true, registry: cached };
  }

  const bundled = fetch
    ? skillRegistry.ensureBundledRegistryCached()
    : skillRegistry.loadCachedRegistry() || skillRegistry.ensureBundledRegistryCached();
  if (!bundled) {
    return { ok: false, error: "NOT_FOUND", detail: "内置技能目录不可用" };
  }
  return { ok: true, registry: bundled };
}

async function checkRegistryUpdates({ fetch = true } = {}) {
  const registryUrl = getRegistryUrl();
  const resolved = await resolveRegistry({ fetch });
  if (!resolved.ok) {
    if (!registryUrl && !fetch) {
      return {
        ok: true,
        registryUrl: "",
        publisher: "",
        installed: listSkillsPublic(),
        available: [],
        updates: [],
        updatesCount: 0,
        categories: [],
        remoteIndexes: [],
        bundledCatalog: true,
      };
    }
    return resolved;
  }

  const registry = resolved.registry;

  ensureSkillsStateDefaults();
  const state = loadSkillsState();
  const registryById = Object.fromEntries(registry.skills.map((s) => [s.id, s]));

  const installed = [];
  const updates = [];

  for (const skill of listSkillsPublic()) {
    const reg = registryById[skill.id];
    const enriched = skillToPublic(
      skill.id,
      state.skills[skill.id],
      readInstalledManifest(skill.id) || readBundledManifest(skill.id),
      reg,
    );
    installed.push(enriched);
    if (enriched.updateAvailable) {
      updates.push(enriched);
    }
  }

  const available = [];
  for (const regEntry of registry.skills) {
    if (PROTECTED_BUNDLED_IDS.has(regEntry.id)) continue;
    if (!isAppVersionCompatible(regEntry.minAppVersion)) continue;
    if (readInstalledManifest(regEntry.id)) continue;
    available.push(availableSkillToPublic(regEntry, null));
  }

  const fetchedAt =
    registry.fetchedAt ||
    skillRegistry.loadCachedRegistry()?.fetchedAt ||
    new Date().toISOString();
  state.registryCachedAt = fetchedAt;
  saveSkillsState();

  return {
    ok: true,
    registryUrl: registryUrl || skillRegistry.BUNDLED_REGISTRY_SOURCE,
    publisher: registry.publisher || "",
    fetchedAt: registry.fetchedAt || state.registryCachedAt,
    installed,
    available,
    updates,
    updatesCount: updates.length,
    categories: registry.categories || [],
    remoteIndexes: registry.remoteIndexes || [],
    bundledCatalog: !registryUrl,
  };
}

async function installFromRegistry(skillId, version) {
  const resolved = await resolveRegistry({ fetch: true });
  if (!resolved.ok) return resolved;

  const registry = resolved.registry;

  const entry = skillRegistry.findRegistryEntry(registry, skillId, version);
  if (!entry) {
    return { ok: false, error: "NOT_FOUND" };
  }

  const result = await skillInstaller.installFromRegistryEntry(entry);
  if (!result.ok) return result;
  return { ok: true, skills: listSkillsPublic(), id: result.id, version: result.version };
}

async function updateFromRegistry(skillId) {
  return installFromRegistry(skillId);
}

function uninstallRemoteSkill(skillId) {
  const result = skillInstaller.uninstallRemoteSkill(skillId);
  if (!result.ok) return result;
  return { ok: true, skills: listSkillsPublic() };
}

function listSkillsPublic() {
  ensureSkillsStateDefaults();
  ensureBundledPresent();

  const state = loadSkillsState();
  if (!state.skills || typeof state.skills !== "object") {
    state.skills = {};
    saveSkillsState();
  }
  const cached = skillRegistry.loadCachedRegistry();
  const registryById =
    cached && skillRegistry.registrySourceMatches(state, cached)
      ? Object.fromEntries((cached.skills || []).map((s) => [s.id, s]))
      : {};
  const skills = [];

  for (const skillId of BUNDLED_SKILL_IDS) {
    const bundled = readBundledManifest(skillId);
    const installed = readInstalledManifest(skillId);
    const entry = state.skills[skillId];
    if (!bundled) continue;

    const manifest = installed || bundled;
    skills.push(skillToPublic(skillId, entry, manifest, registryById[skillId]));
  }

  for (const [skillId, entry] of Object.entries(state.skills)) {
    if (BUNDLED_SKILL_IDS.includes(skillId)) continue;
    const manifest = readInstalledManifest(skillId);
    if (!manifest) continue;
    skills.push(skillToPublic(skillId, entry, manifest, registryById[skillId]));
  }

  return skills;
}

function bootstrapSkills() {
  ensureSkillsStateDefaults();
  skillRegistry.ensureBundledRegistryCached();
  const installed = ensureBundledPresent();
  mergeAgentGuide();
  return { installed };
}

function setSkillEnabled(skillId, enabled) {
  ensureSkillsStateDefaults();
  const state = loadSkillsState();
  if (!state.skills[skillId] && !BUNDLED_SKILL_IDS.includes(skillId)) {
    return { ok: false, error: "NOT_FOUND" };
  }
  if (!state.skills[skillId]) {
    const manifest = readBundledManifest(skillId);
    if (!manifest) return { ok: false, error: "NOT_FOUND" };
    state.skills[skillId] = {
      id: skillId,
      enabled: Boolean(enabled),
      source: "bundled",
      installedVersion: manifest.version,
      bundledVersion: manifest.version,
    };
  } else {
    state.skills[skillId].enabled = Boolean(enabled);
  }
  saveSkillsState();
  mergeAgentGuide();
  return { ok: true, skills: listSkillsPublic() };
}

function setSkillEnabledWithSessions(skillId, enabled, sessionManager) {
  const result = setSkillEnabled(skillId, enabled);
  if (result.ok && sessionManager) {
    syncInheritedSessionGuides(sessionManager);
  }
  return result;
}

function restoreBundledSkill(skillId) {
  if (!PROTECTED_BUNDLED_IDS.has(skillId)) {
    return { ok: false, error: "BUNDLED_PROTECTED" };
  }
  const result = installSkillFromSource(skillId, { force: true });
  if (!result.installed) {
    return { ok: false, error: "NOT_FOUND" };
  }
  mergeAgentGuide();
  return { ok: true, skills: listSkillsPublic() };
}

function refreshSkillsConfig() {
  mergeAgentGuide();
  return { ok: true, skills: listSkillsPublic() };
}

module.exports = {
  BUNDLED_SKILL_IDS,
  PROTECTED_BUNDLED_IDS,
  bootstrapSkills,
  listSkillsPublic,
  listSkillsForSessionPublic,
  setSkillEnabled,
  setSkillEnabledWithSessions,
  restoreBundledSkill,
  refreshSkillsConfig,
  mergeAgentGuide,
  getDisallowedTools,
  ensureBundledPresent,
  getRegistryUrl,
  setRegistryUrl,
  checkRegistryUpdates,
  installFromRegistry,
  updateFromRegistry,
  uninstallRemoteSkill,
  loadSkillsState,
  saveSkillsState,
  applyPlaceholders,
  buildReplacements,
  readInstalledManifest,
  installedSkillDir,
  writeSessionAgentGuide,
  resolveSessionSkillIds,
  normalizeSessionSkillSelection,
  syncInheritedSessionGuides,
  getGloballyEnabledSkillIds,
};
