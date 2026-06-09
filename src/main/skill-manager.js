"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { PROJECT_ROOT, userDataPath, agentConfigDir, agentGuidePath, sessionGuideDir } = require("./config");
const { syncEngineGuideMirror } = require("./agent-guide-mirror");
const { ensureRuntimeNodeShim, resolveRuntimeNodePath } = require("./runtime-node");
const { compareSemver, isAppVersionCompatible } = require("./skill-version");
const skillRegistry = require("./skill-registry");
const skillInstaller = require("./skill-installer");
const skillPresets = require("./skill-presets");
const { copyDirRecursiveShipSafe } = require("./ship-ignore");

const MANDATORY_PLATFORM_SKILL_IDS = [
  "lily-workbench-rules",
  "lily-context-rules",
  "lily-task-execution-rules",
];

const BUNDLED_SKILL_IDS = [
  "lily-workbench-rules",
  "lily-context-rules",
  "lily-task-execution-rules",
  "lily-vision",
  "lily-image-generation",
  "lily-video-generation",
  "lily-speech-generation",
  "websearch",
  "webfetch",
];

const PROTECTED_BUNDLED_IDS = new Set(BUNDLED_SKILL_IDS);

/** @type {{ schemaVersion: number, skills: Record<string, { id: string, enabled: boolean, source: string, installedVersion?: string, bundledVersion?: string }> } | null} */
let skillsStateCache = null;

function skillsStatePath() {
  return userDataPath("skills-state.json");
}

function bundledResourceCandidates(relativePath) {
  const candidates = [];
  if (typeof process.resourcesPath === "string" && process.resourcesPath.length > 0) {
    candidates.push(path.join(process.resourcesPath, relativePath));
  }
  candidates.push(path.join(PROJECT_ROOT, relativePath));
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
  copyDirRecursiveShipSafe(source, target);
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
    if (MANDATORY_PLATFORM_SKILL_IDS.includes(skillId) && entry.enabled === false) {
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
  if (MANDATORY_PLATFORM_SKILL_IDS.includes(skillId)) return true;
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

/**
 * Sync i18n fields from the bundled manifest into the installed manifest.
 * This ensures manifest additions (like name_i18n, description_i18n, guideMd_i18n)
 * reach already-installed copies without a full re-install or version bump.
 */
function syncManifestI18nFromBundled(skillId) {
  const installedDir = installedSkillDir(skillId);
  const installedPath = path.join(installedDir, "skill.manifest.json");
  if (!fs.existsSync(installedPath)) return;

  const bundled = readBundledManifest(skillId);
  const installed = readInstalledManifest(skillId);
  if (!bundled || !installed) return;

  let changed = false;
  for (const field of ["name", "description", "guideMd"]) {
    const i18nKey = field + "_i18n";
    const bundledI18n = bundled[i18nKey];
    if (!bundledI18n || typeof bundledI18n !== "object") continue;
    const installedI18n = installed[i18nKey];
    if (
      !installedI18n ||
      typeof installedI18n !== "object" ||
      Object.keys(installedI18n).length === 0
    ) {
      installed[i18nKey] = { ...bundledI18n };
      changed = true;
    }
  }

  if (changed) {
    try {
      fs.writeFileSync(installedPath, JSON.stringify(installed, null, 2), "utf8");
    } catch {
      // non-fatal
    }
  }
}

function ensureBundledPresent() {
  ensureSkillsStateDefaults();
  const installed = [];
  for (const skillId of BUNDLED_SKILL_IDS) {
    syncManifestI18nFromBundled(skillId);
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
  let ids;
  if (!session || session.enabledSkillIds == null) {
    ids = getGloballyEnabledSkillIds().filter((id) => installed.has(id));
  } else if (!Array.isArray(session.enabledSkillIds)) {
    ids = getGloballyEnabledSkillIds().filter((id) => installed.has(id));
  } else {
    ids = session.enabledSkillIds.filter((id) => installed.has(id));
  }
  const merged = new Set(ids);
  for (const skillId of MANDATORY_PLATFORM_SKILL_IDS) {
    if (installed.has(skillId)) merged.add(skillId);
  }
  return [...merged];
}

function isSessionSkillCustomized(session) {
  return session != null && session.enabledSkillIds != null && Array.isArray(session.enabledSkillIds);
}

const AGENT_GUIDE_I18N = {
  "zh-CN": {
    title: "智能工作台全局说明",
    identity: "你是智能工作台（Lily Workbench）助手。不要自称 Claude、Claude Code 或 Anthropic 产品。",
    gatewayNote: "本应用对接的是用户配置的模型/API 网关，不使用 Claude/Anthropic 服务。",
    vendorDisclaimer: "只有在用户明确讨论第三方技术、兼容协议、代码变量或排障时，才可客观提及相关名称。",
    faqTitle: "身份问答（必读）",
    faqTrigger: "当用户问「你是谁」「你叫什么」「介绍一下你自己」或类似问题时：",
    faqAnswer1: "- 只回答：智能工作台助手（或 Lily Workbench 助手）。",
    faqAnswer2: "- 说明你是帮助用户在本机项目中完成写作、查资料、读文件、识图等任务的桌面助手。",
    faqAnswer3: "- 禁止说自己是 Claude、Claude Code、Anthropic 的产品或模型。",
    faqAnswer4: "- 若用户追问底层服务，说明本应用对接的是用户配置的模型/API 网关，不使用 Claude/Anthropic 服务。",
  },
  en: {
    title: "Lily Workbench Global Instructions",
    identity: "You are the Lily Workbench assistant. Do NOT call yourself Claude, Claude Code, or an Anthropic product.",
    gatewayNote: "This application connects to user-configured model/API gateways, NOT Claude/Anthropic services.",
    vendorDisclaimer: "Only mention third-party names objectively when the user explicitly discusses related technology, compatibility protocols, code variables, or troubleshooting.",
    faqTitle: "Identity Q&A (Required)",
    faqTrigger: "When the user asks \"Who are you?\", \"What's your name?\", \"Tell me about yourself\", or similar questions:",
    faqAnswer1: "- Only answer: Lily Workbench assistant.",
    faqAnswer2: "- Explain that you are a desktop assistant helping users with writing, research, file reading, image recognition, and other tasks in their local projects.",
    faqAnswer3: "- Do NOT say you are Claude, Claude Code, or an Anthropic product or model.",
    faqAnswer4: "- If the user asks about the underlying service, explain the application connects to user-configured model/API gateways, not Claude/Anthropic services.",
  },
  ar: {
    title: "تعليمات Lily Workbench العامة",
    identity: "أنت مساعد Lily Workbench. لا تسمِّ نفسك Claude أو Claude Code أو منتج Anthropic.",
    gatewayNote: "يتصل هذا التطبيق ببوابات النماذج/واجهات برمجة التطبيقات التي يكوّنها المستخدم، وليس خدمات Claude/Anthropic.",
    vendorDisclaimer: "لا تذكر أسماء الطرف الثالث إلا بشكل موضوعي عندما يناقش المستخدم صراحةً التقنية ذات الصلة أو بروتوكولات التوافق أو متغيرات الكود أو استكشاف الأخطاء.",
    faqTitle: "أسئلة الهوية (مطلوب)",
    faqTrigger: "عندما يسأل المستخدم \"من أنت؟\" أو \"ما اسمك؟\" أو \"أخبرني عن نفسك\" أو أسئلة مشابهة:",
    faqAnswer1: "- أجب فقط: مساعد Lily Workbench.",
    faqAnswer2: "- اشرح أنك مساعد مكتبي يساعد المستخدمين في الكتابة والبحث وقراءة الملفات والتعرف على الصور ومهام أخرى في مشاريعهم المحلية.",
    faqAnswer3: "- لا تقل أنك Claude أو Claude Code أو منتج أو نموذج من Anthropic.",
    faqAnswer4: "- إذا سأل المستخدم عن الخدمة الأساسية، اشرح أن التطبيق يتصل ببوابات النماذج/واجهات برمجة التطبيقات التي يكوّنها المستخدم، وليس خدمات Claude/Anthropic.",
  },
};

function buildAgentGuideContent(enabledSkills, locale) {
  const loc = locale || getActiveLocale() || "en";
  const guide = AGENT_GUIDE_I18N[loc] || AGENT_GUIDE_I18N["en"];
  const sections = [
    `# ${guide.title}`,
    "",
    guide.identity,
    guide.gatewayNote,
    guide.vendorDisclaimer,
    "",
    `## ${guide.faqTitle}`,
    "",
    guide.faqTrigger,
    guide.faqAnswer1,
    guide.faqAnswer2,
    guide.faqAnswer3,
    guide.faqAnswer4,
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

/** Bump when static AGENT.md header changes so cached session guides refresh. */
const AGENT_GUIDE_STATIC_VERSION = 4;

/** @type {Map<string, string>} sessionId → sorted skill id signature */
const sessionGuideWriteCache = new Map();

function getActiveLocale() {
  try {
    return require("./locale-settings").getLocale();
  } catch {
    return "en";
  }
}

function sessionGuideWriteSignature(session) {
  const skillSig = resolveSessionSkillIds(session).slice().sort().join("\0");
  const locale = getActiveLocale();
  return `${AGENT_GUIDE_STATIC_VERSION}\0${locale}\0${skillSig}`;
}

function writeSessionAgentGuide(sessionId, session) {
  ensureRuntimeNodeShim();
  const configDir = sessionGuideDir(sessionId);
  const signature = sessionGuideWriteSignature(session);
  if (sessionGuideWriteCache.get(sessionId) === signature) {
    return configDir;
  }
  const skillIds = resolveSessionSkillIds(session);
  const skills = getSkillsForIds(skillIds);
  fs.mkdirSync(configDir, { recursive: true });
  ensureSessionConfigBridge(configDir);
  const guidePath = path.join(configDir, "AGENT.md");
  const locale = getActiveLocale();
  fs.writeFileSync(guidePath, buildAgentGuideContent(skills, locale), "utf8");
  syncEngineGuideMirror(guidePath, configDir);
  sessionGuideWriteCache.set(sessionId, signature);
  return configDir;
}

function listSkillsForSessionPublic(session) {
  const installed = listSkillsPublic();
  const effectiveIds = new Set(resolveSessionSkillIds(session));
  const customized = isSessionSkillCustomized(session);
  return {
    customized,
    effectiveIds: [...effectiveIds],
    skills: installed
      .filter((skill) => !MANDATORY_PLATFORM_SKILL_IDS.includes(skill.id))
      .map((skill) => ({
      id: skill.id,
      name: skill.name,
      description: skill.description,
      category: skill.category || null,
      categoryLabel: skill.categoryLabel || null,
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
  if (!manifest) return null;
  const locale = getActiveLocale();
  const i18n = manifest.guideMd_i18n;
  if (i18n && i18n[locale]) return i18n[locale];
  return manifest.guideMd || manifest.claudeMd || null;
}

/**
 * Resolve a locale-aware field from a manifest.
 * Checks `field_i18n[locale]` first, falls back to `field`, then `defaultValue`.
 */
function resolveLocalized(manifest, field, defaultValue) {
  if (!manifest) return defaultValue;
  let locale;
  try {
    locale = getActiveLocale();
  } catch {
    return manifest[field] || defaultValue;
  }
  const i18n = manifest[field + "_i18n"];
  if (i18n && typeof i18n === "object" && i18n[locale]) return i18n[locale];
  return manifest[field] || defaultValue;
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
  const locale = getActiveLocale();
  fs.writeFileSync(guidePath, buildAgentGuideContent(enabled, locale), "utf8");
  syncEngineGuideMirror(guidePath, configDir);
}

function getDisallowedTools() {
  return ["WebSearch", "WebFetch"];
}

function getServiceRegistryUrl() {
  try {
    const service = require("./service-client").getServiceSettings();
    const remoteConfig = require("./remote-config").getRemoteEffectiveConfigSync();
    const configured = String(remoteConfig?.tools?.pluginRegistryUrl || "").trim();
    if (configured) {
      if (/^https?:\/\//i.test(configured)) return configured;
      if (configured.startsWith("/") && service?.apiBaseUrl) return `${service.apiBaseUrl}${configured}`;
    }
    if (service?.apiBaseUrl) return `${service.apiBaseUrl}/api/plugins/registry`;
  } catch {
    // fall back to bundled catalog
  }
  return "";
}

async function fetchServiceRegistry() {
  const sourceUrl = getServiceRegistryUrl();
  if (!sourceUrl) return { ok: false, error: "NO_SERVICE_URL" };

  let json = null;
  try {
    const response = await fetch(sourceUrl, {
      headers: { "Content-Type": "application/json" },
    });
    json = await response.json().catch(() => null);
    if (!response.ok || !json) {
      return { ok: false, error: "SERVICE_REQUEST_FAILED", status: response.status };
    }
  } catch (error) {
    return { ok: false, error: "SERVICE_REQUEST_FAILED", detail: error?.message || String(error) };
  }

  const parsed = skillRegistry.parseRegistryJson(json);
  if (!parsed.ok) return parsed;

  const fetchedAt = skillRegistry.cacheRegistry(parsed.registry, sourceUrl);
  const state = loadSkillsState();
  state.serviceRegistryUrl = sourceUrl;
  saveSkillsState();
  return { ok: true, registry: { ...parsed.registry, fetchedAt, sourceUrl } };
}

function skillToPublic(skillId, entry, manifest, registryEntry) {
  const installedVersion = entry?.installedVersion || manifest?.version || "0.0.0";
  const latestVersion = registryEntry?.latestVersion || null;
  const updateAvailable =
    latestVersion && compareSemver(latestVersion, installedVersion) > 0;
  const platformMandatory = MANDATORY_PLATFORM_SKILL_IDS.includes(skillId);

  return {
    id: skillId,
    name: resolveLocalized(manifest, "name", registryEntry?.name || skillId),
    description: resolveLocalized(manifest, "description", registryEntry?.description || ""),
    version: installedVersion,
    latestVersion,
    source: entry?.source || (registryEntry ? "remote" : "local"),
    enabled: platformMandatory ? true : entry?.enabled !== false,
    permissions: {
      network: Boolean(manifest?.permissions?.network ?? registryEntry?.permissions?.network),
      filesystem: manifest?.permissions?.filesystem || "none",
    },
    canDisable: !platformMandatory && Boolean(manifest || entry),
    platformMandatory,
    canRestore: PROTECTED_BUNDLED_IDS.has(skillId),
    canUninstall: entry?.source === "remote",
    updateAvailable,
    changelog: registryEntry?.changelog || "",
    category: registryEntry?.category || null,
    categoryLabel: registryEntry?.categoryLabel || null,
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

function finalizeResolvedRegistry(registry, { serviceUrl = "", fromService = false } = {}) {
  const supplemented = skillRegistry.supplementRegistryWithBundled(registry);
  if (!supplemented) {
    return { ok: false, error: "NOT_FOUND", detail: "Built-in skill directory not available" };
  }
  return {
    ok: true,
    registry: {
      ...supplemented,
      serviceCatalog: fromService && Boolean(registry?.skills?.length),
      bundledCatalogFallback: Boolean(
        supplemented.bundledFallback || supplemented.bundledSupplement,
      ),
      serviceRegistryUrl: serviceUrl || null,
    },
  };
}

async function resolveRegistry({ fetch = true } = {}) {
  const serviceUrl = getServiceRegistryUrl();
  if (serviceUrl) {
    if (fetch) {
      const service = await fetchServiceRegistry();
      if (service.ok) {
        return finalizeResolvedRegistry(service.registry, {
          serviceUrl,
          fromService: true,
        });
      }
    } else {
      const cached = skillRegistry.loadCachedRegistry();
      if (cached?.sourceUrl === serviceUrl) {
        return finalizeResolvedRegistry(cached, {
          serviceUrl,
          fromService: true,
        });
      }
    }
  }

  const bundled = fetch
    ? skillRegistry.ensureBundledRegistryCached()
    : skillRegistry.loadCachedRegistry() || skillRegistry.ensureBundledRegistryCached();
  return finalizeResolvedRegistry(bundled);
}

async function checkRegistryUpdates({ fetch = true } = {}) {
  const serviceRegistryUrl = getServiceRegistryUrl();
  const resolved = await resolveRegistry({ fetch });
  if (!resolved.ok) {
    if (!fetch) {
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
        presets: listSkillPresetsPublic(),
        featuredSkillIds: skillPresets.FEATURED_SKILL_IDS,
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

  const sortedAvailable = sortAvailableSkills(available);

  return {
    ok: true,
    registryUrl: registry.sourceUrl || serviceRegistryUrl || skillRegistry.BUNDLED_REGISTRY_SOURCE,
    publisher: registry.publisher || "",
    fetchedAt: registry.fetchedAt || state.registryCachedAt,
    installed,
    available: sortedAvailable,
    updates,
    updatesCount: updates.length,
    categories: skillRegistry.categoriesForRegistry(registry),
    remoteIndexes: registry.remoteIndexes || [],
    presets: listSkillPresetsPublic(),
    featuredSkillIds: skillPresets.FEATURED_SKILL_IDS,
    bundledCatalog:
      registry.sourceUrl === skillRegistry.BUNDLED_REGISTRY_SOURCE ||
      Boolean(registry.bundledCatalogFallback),
    serviceCatalog:
      Boolean(registry.serviceCatalog) || registry.sourceUrl === serviceRegistryUrl,
  };
}

function sortAvailableSkills(available) {
  const featured = new Set(skillPresets.FEATURED_SKILL_IDS);
  return [...(available || [])].sort((a, b) => {
    const aFeatured = featured.has(a.id) ? 0 : 1;
    const bFeatured = featured.has(b.id) ? 0 : 1;
    if (aFeatured !== bFeatured) return aFeatured - bFeatured;
    return String(a.name || a.id).localeCompare(String(b.name || b.id), "zh-CN");
  });
}

function listSkillPresetsPublic() {
  ensureSkillsStateDefaults();
  return skillPresets.listPresetProgress({
    isInstalled: (skillId) => Boolean(readInstalledManifest(skillId)),
    isEnabled: (skillId) => isSkillEnabled(skillId),
  });
}

const SKILL_PRESET_GUIDE_STATUSES = new Set(["applied", "dismissed", "deferred"]);

function normalizeSkillPresetGuideStatus(raw) {
  if (typeof raw !== "string" || !SKILL_PRESET_GUIDE_STATUSES.has(raw)) return null;
  return raw;
}

function getSkillPresetGuideState() {
  ensureSkillsStateDefaults();
  const state = loadSkillsState();
  const status = normalizeSkillPresetGuideStatus(state.meta?.skillPresetGuide);
  const guidePresetId = skillPresets.GUIDE_PRESET_ID;
  const guidePreset = listSkillPresetsPublic().find((p) => p.id === guidePresetId);
  const guidePresetComplete = Boolean(guidePreset?.complete);
  const shouldShow =
    !guidePresetComplete && status !== "applied" && status !== "dismissed";
  return {
    shouldShow,
    status,
    guidePresetId,
    guidePresetComplete,
    guidePreset,
  };
}

function setSkillPresetGuideStatus(status) {
  const normalized = normalizeSkillPresetGuideStatus(status);
  if (!normalized) {
    return { ok: false, error: "INVALID_STATUS" };
  }
  ensureSkillsStateDefaults();
  const state = loadSkillsState();
  if (!state.meta || typeof state.meta !== "object") {
    state.meta = {};
  }
  state.meta.skillPresetGuide = normalized;
  saveSkillsState();
  return { ok: true, status: normalized, guide: getSkillPresetGuideState() };
}

async function applySkillPreset(presetId) {
  const preset = skillPresets.getPresetById(presetId);
  if (!preset) {
    return { ok: false, error: "NOT_FOUND" };
  }

  const resolved = await resolveRegistry({
    fetch: Boolean(getServiceRegistryUrl()),
  });
  if (!resolved.ok) return resolved;

  const registry = resolved.registry;
  const skillIds = skillPresets.filterSkillIdsInRegistry(registry, preset.skillIds);
  if (skillIds.length === 0) {
    return { ok: false, error: "PRESET_EMPTY" };
  }

  const installed = [];
  const enabled = [];
  const failed = [];

  for (const skillId of skillIds) {
    if (!readInstalledManifest(skillId)) {
      const entry = skillRegistry.findRegistryEntry(registry, skillId);
      if (!entry) {
        failed.push({ id: skillId, error: "NOT_FOUND" });
        continue;
      }
      const installResult = await skillInstaller.installFromRegistryEntry(entry);
      if (!installResult.ok) {
        failed.push({ id: skillId, error: installResult.error || "INSTALL_FAILED" });
        continue;
      }
      installed.push(skillId);
      reportSkillEvent("install", skillId, installResult.version, { presetId });
    }

    const enableResult = setSkillEnabled(skillId, true);
    if (enableResult.ok) {
      enabled.push(skillId);
    } else {
      failed.push({ id: skillId, error: enableResult.error || "ENABLE_FAILED" });
    }
  }

  mergeAgentGuide();

  return {
    ok: enabled.length > 0,
    presetId,
    installed,
    enabled,
    failed,
    presets: listSkillPresetsPublic(),
    skills: listSkillsPublic(),
  };
}

async function installOrUpdateFromRegistry(skillId, version) {
  const resolved = await resolveRegistry({
    fetch: Boolean(getServiceRegistryUrl()),
  });
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

async function installFromRegistry(skillId, version) {
  const result = await installOrUpdateFromRegistry(skillId, version);
  if (result.ok) {
    reportSkillEvent("install", result.id, result.version, { requestedVersion: version || null });
  }
  return result;
}

async function updateFromRegistry(skillId) {
  const result = await installOrUpdateFromRegistry(skillId);
  if (result.ok) reportSkillEvent("update", result.id, result.version);
  return result;
}

function uninstallRemoteSkill(skillId) {
  const result = skillInstaller.uninstallRemoteSkill(skillId);
  if (!result.ok) return result;
  reportSkillEvent("uninstall", skillId, null);
  return { ok: true, skills: listSkillsPublic() };
}

function reportSkillEvent(eventType, pluginId, pluginVersion, metadata = {}) {
  require("./service-client")
    .reportSkillEvent({ eventType, pluginId, pluginVersion, metadata })
    .catch((err) => console.warn("[skills-report]", err?.message || err));
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
  if (MANDATORY_PLATFORM_SKILL_IDS.includes(skillId) && !enabled) {
    return { ok: false, error: "MANDATORY_SKILL" };
  }
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
  reportSkillEvent(Boolean(enabled) ? "enable" : "disable", skillId, state.skills[skillId]?.installedVersion || null);
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
  MANDATORY_PLATFORM_SKILL_IDS,
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
  getServiceRegistryUrl,
  checkRegistryUpdates,
  listSkillPresetsPublic,
  getSkillPresetGuideState,
  setSkillPresetGuideStatus,
  applySkillPreset,
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
