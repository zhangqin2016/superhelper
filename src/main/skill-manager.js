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
const learnedContext = require("./learned-context");
const { buildCrystallizationSection } = require("./learned-skills");

const {
  BUNDLED_SKILL_IDS,
  MANDATORY_PLATFORM_SKILL_IDS,
  PROTECTED_BUNDLED_IDS,
  loadSkillsState,
  saveSkillsState,
  ensureSkillsStateDefaults,
  isSkillEnabled,
  readJsonFile,
  readBundledManifest,
  readInstalledManifest,
  loadManifestFromDir,
  installedSkillDir,
  bundledSkillSource,
  skillsStatePath,
  applyPlaceholders,
  buildReplacements,
  copyDirRecursive,
} = require("./skills-state");

const SKILL_ID_RE = /^[a-z][a-z0-9-]{1,99}$/;
const INLINE_GUIDE_SKILL_IDS = new Set([
  ...MANDATORY_PLATFORM_SKILL_IDS,
  "websearch",
  "webfetch",
]);

function isWorkspaceSkillEntry(_skillId, entry, manifest) {
  return Boolean(
    entry?.source === "learned" ||
    manifest?.origin === "workspace" ||
    manifest?.workspaceOnly === true ||
    manifest?.publisher === "Workspace"
  );
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
    // Update when missing/empty OR when the bundled content actually changed —
    // platform guide edits (these manifests are ours, not user-editable) must
    // reach already-installed copies on the next launch without a version bump.
    // The old code only filled when missing, so every guide edit silently stayed
    // in the repo and never reached the running app.
    if (
      !installedI18n ||
      typeof installedI18n !== "object" ||
      Object.keys(installedI18n).length === 0 ||
      JSON.stringify(installedI18n) !== JSON.stringify(bundledI18n)
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

function pruneInstalledSkillsNotInRegistry(registry) {
  if (!registry || !Array.isArray(registry.skills)) {
    return [];
  }

  ensureSkillsStateDefaults();
  const allowedIds = new Set(registry.skills.map((skill) => skill.id));
  for (const skillId of PROTECTED_BUNDLED_IDS) {
    allowedIds.add(skillId);
  }

  const state = loadSkillsState();
  const pruned = [];
  for (const skillId of Object.keys(state.skills || {})) {
    if (allowedIds.has(skillId)) continue;
    const entry = state.skills[skillId] || {};
    const manifest = readInstalledManifest(skillId);
    if (isWorkspaceSkillEntry(skillId, entry, manifest)) continue;
    const skillDir = installedSkillDir(skillId);
    if (fs.existsSync(skillDir)) {
      fs.rmSync(skillDir, { recursive: true, force: true });
    }
    delete state.skills[skillId];
    pruned.push(skillId);
  }

  if (pruned.length > 0) {
    saveSkillsState();
    mergeAgentGuide();
  }
  return pruned;
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

/**
 * Enabled skills that can be (re)installed from the registry — the correct set
 * for a pack's `requiredSkills` dependency list. Excludes workspace/learned
 * skills: those travel INSIDE the pack and are not in any registry, so declaring
 * them as a dependency would make the importer try to fetch them and abort the
 * whole import when the fetch fails.
 */
function getEnabledRegistrySkillIds() {
  ensureSkillsStateDefaults();
  const state = loadSkillsState();
  const ids = [];
  for (const skillId of getGloballyEnabledSkillIds()) {
    const entry = state.skills[skillId] || {};
    const manifest = readInstalledManifest(skillId);
    if (isWorkspaceSkillEntry(skillId, entry, manifest)) continue;
    ids.push(skillId);
  }
  return ids;
}

function normalizeProjectId(projectId) {
  return String(projectId || "").trim();
}

function uniqueStrings(values) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map((value) => String(value || "").trim())
    .filter(Boolean))];
}

function isSkillEnabledForProject(entry, projectId) {
  const pid = normalizeProjectId(projectId);
  if (!pid) return false;
  const disabledProjectIds = new Set(uniqueStrings(entry?.disabledProjectIds));
  if (disabledProjectIds.has(pid)) return false;
  return uniqueStrings(entry?.enabledProjectIds).includes(pid);
}

function getWorkspaceEnabledSkillIds(projectId) {
  const pid = normalizeProjectId(projectId);
  if (!pid) return [];
  ensureSkillsStateDefaults();
  const installed = new Set(getAllInstalledSkillIds());
  const state = loadSkillsState();
  const ids = [];
  for (const [skillId, entry] of Object.entries(state.skills || {})) {
    if (!installed.has(skillId)) continue;
    const manifest = readInstalledManifest(skillId);
    if (!manifest || !isWorkspaceSkillEntry(skillId, entry, manifest)) continue;
    if (isSkillEnabledForProject(entry, pid)) ids.push(skillId);
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
  let merged;
  if (isSessionSkillCustomized(session)) {
    // The conversation has an explicit skill selection ("本对话技能"). It is
    // authoritative: exactly what the user left checked. We deliberately do NOT
    // re-merge project-bound workspace skills here — doing so silently undid
    // unchecking a workspace skill, so the checkbox lied and the assistant kept
    // "seeing" a system the user turned off for this chat.
    merged = new Set(session.enabledSkillIds.filter((id) => installed.has(id)));
  } else {
    // Fresh chat (no explicit selection): default to globally-enabled skills plus
    // this project's workspace skills, so new chats in a workspace get its learned
    // capabilities without manual setup. Once the user customizes, the branch
    // above takes over and this auto-merge no longer overrides their choice.
    merged = new Set(getGloballyEnabledSkillIds().filter((id) => installed.has(id)));
    for (const skillId of getWorkspaceEnabledSkillIds(session?.projectId)) {
      if (installed.has(skillId)) merged.add(skillId);
    }
  }
  // Platform-mandatory skills are always on (and are hidden from the panel).
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
    responseLanguage: "回复语言必须跟随用户最新一条消息的主要语言；如果用户明确指定回复语言，则按用户指定执行。界面语言只在无法判断用户语言时作为兜底。不要把技能说明、工具输出、文件内容、路径、历史消息或应用界面语言误当成用户本轮想要的回复语言。",
    faqTitle: "身份问答（必读）",
    faqTrigger: "当用户问「你是谁」「你叫什么」「介绍一下你自己」或类似问题时：",
    faqAnswer1: "- 只回答：智能工作台助手（或 Lily Workbench 助手）。",
    faqAnswer2: "- 说明你是帮助用户在本机项目中完成写作、查资料、读文件、识图等任务的桌面助手。",
    faqAnswer3: "- 禁止说自己是 Claude、Claude Code、Anthropic 的产品或模型。",
    faqAnswer4: "- 若用户追问底层服务，说明本应用对接的是用户配置的模型/API 网关，不使用 Claude/Anthropic 服务。",
    envTitle: "依赖与能力探测（重要）",
    envNote: [
      "命令 `python3` 和 `node` 指向本应用提供的基础运行时。不要假设某个文档、图片、浏览器或音视频库一定已存在；使用前先用 `python3 -c \"import ...\"`、`node -e \"require.resolve(...)\"` 或 `command -v ...` 做轻量探测。",
      "处理 Excel/CSV、Word/PPT、PDF、图片、网页自动化或音视频任务时，优先探测当前能力；探测成功就直接使用，探测失败再判断是否有对应依赖包。",
      "不要把内置 Read 工具当作 PDF/Office 内容解析器。若 Read 对 PDF 返回 Unsupported Document，只说明该工具不支持；应改用 Lily 文档预处理、文档索引，或用当前 Python 能力（pdfplumber/PyMuPDF/RapidOCR/Office 库）做确定性提取。",
      "缺失的标准能力应通过「依赖包」技能（lily-runtime-packs）安装或修复：文档处理（libreoffice、pro-pdf、pandoc）、图片处理（pillow、opencv、rapidocr、rembg）、浏览器自动化（web-automation）、音视频处理（ffmpeg）。",
      "不要在普通用户任务里临时 `pip install` / `npm install` / `playwright install` 来修平台能力；依赖包由 Lily CDN 提供预构建版本并校验安装。没有对应依赖包时，如实说明当前平台缺失能力。",
      "安装依赖包后不需要新开会话，后续工具进程会通过 PATH、PYTHONPATH、NODE_PATH 或专用环境变量自动识别。",
    ],
  },
  en: {
    title: "Lily Workbench Global Instructions",
    identity: "You are the Lily Workbench assistant. Do NOT call yourself Claude, Claude Code, or an Anthropic product.",
    gatewayNote: "This application connects to user-configured model/API gateways, NOT Claude/Anthropic services.",
    vendorDisclaimer: "Only mention third-party names objectively when the user explicitly discusses related technology, compatibility protocols, code variables, or troubleshooting.",
    responseLanguage: "Reply in the primary language of the user's latest message. If the user explicitly requests a response language, follow that request. Use the app interface language only as a fallback when the user's language cannot be determined. Do not let skill instructions, tool output, file content, paths, history, or the app interface language change the response language.",
    faqTitle: "Identity Q&A (Required)",
    faqTrigger: "When the user asks \"Who are you?\", \"What's your name?\", \"Tell me about yourself\", or similar questions:",
    faqAnswer1: "- Only answer: Lily Workbench assistant.",
    faqAnswer2: "- Explain that you are a desktop assistant helping users with writing, research, file reading, image recognition, and other tasks in their local projects.",
    faqAnswer3: "- Do NOT say you are Claude, Claude Code, or an Anthropic product or model.",
    faqAnswer4: "- If the user asks about the underlying service, explain the application connects to user-configured model/API gateways, not Claude/Anthropic services.",
    envTitle: "Dependencies and Capability Probing (Important)",
    envNote: [
      "The `python3` and `node` commands point to the app-provided base runtimes. Do not assume a specific document, image, browser, or media library exists; probe first with `python3 -c \"import ...\"`, `node -e \"require.resolve(...)\"`, or `command -v ...`.",
      "For Excel/CSV, Word/PPT, PDF, image, browser automation, or media work, first check the current capability. If the probe succeeds, use it directly; if it fails, decide whether a matching dependency pack exists.",
      "Do not treat the built-in Read tool as a PDF/Office content parser. If Read returns Unsupported Document for a PDF, that only means the tool cannot parse it; switch to Lily document pre-send extraction, the document index, or deterministic Python extraction with available pdfplumber/PyMuPDF/RapidOCR/Office libraries.",
      "Missing standard capabilities should be installed or repaired through the Dependency Packs skill (lily-runtime-packs): document processing (libreoffice, pro-pdf, pandoc), image processing (pillow, opencv, rapidocr, rembg), browser automation (web-automation), and media processing (ffmpeg).",
      "Do not run ad-hoc `pip install`, `npm install`, or `playwright install` during ordinary user tasks to repair platform capabilities. Dependency packs are prebuilt Lily CDN artifacts with checksum verification. If no matching pack exists, say the current platform lacks that capability.",
      "After a dependency pack is installed, the current session can keep going; later tool processes pick it up through PATH, PYTHONPATH, NODE_PATH, or dedicated environment variables.",
    ],
  },
  ar: {
    title: "تعليمات Lily Workbench العامة",
    identity: "أنت مساعد Lily Workbench. لا تسمِّ نفسك Claude أو Claude Code أو منتج Anthropic.",
    gatewayNote: "يتصل هذا التطبيق ببوابات النماذج/واجهات برمجة التطبيقات التي يكوّنها المستخدم، وليس خدمات Claude/Anthropic.",
    vendorDisclaimer: "لا تذكر أسماء الطرف الثالث إلا بشكل موضوعي عندما يناقش المستخدم صراحةً التقنية ذات الصلة أو بروتوكولات التوافق أو متغيرات الكود أو استكشاف الأخطاء.",
    responseLanguage: "استخدم اللغة الأساسية في آخر رسالة من المستخدم للرد. إذا طلب المستخدم لغة رد صراحةً، فاتبع طلبه. استخدم لغة الواجهة فقط كخيار احتياطي عندما لا يمكن تحديد لغة المستخدم. لا تجعل تعليمات المهارات أو مخرجات الأدوات أو محتوى الملفات أو المسارات أو السجل أو لغة واجهة التطبيق تغيّر لغة الرد.",
    faqTitle: "أسئلة الهوية (مطلوب)",
    faqTrigger: "عندما يسأل المستخدم \"من أنت؟\" أو \"ما اسمك؟\" أو \"أخبرني عن نفسك\" أو أسئلة مشابهة:",
    faqAnswer1: "- أجب فقط: مساعد Lily Workbench.",
    faqAnswer2: "- اشرح أنك مساعد مكتبي يساعد المستخدمين في الكتابة والبحث وقراءة الملفات والتعرف على الصور ومهام أخرى في مشاريعهم المحلية.",
    faqAnswer3: "- لا تقل أنك Claude أو Claude Code أو منتج أو نموذج من Anthropic.",
    faqAnswer4: "- إذا سأل المستخدم عن الخدمة الأساسية، اشرح أن التطبيق يتصل ببوابات النماذج/واجهات برمجة التطبيقات التي يكوّنها المستخدم، وليس خدمات Claude/Anthropic.",
    envTitle: "التبعيات وفحص القدرات (مهم)",
    envNote: [
      "يشير الأمران `python3` و`node` إلى بيئات التشغيل الأساسية التي يوفّرها التطبيق. لا تفترض أن مكتبة مستندات أو صور أو متصفح أو وسائط محددة موجودة؛ افحص أولاً باستخدام `python3 -c \"import ...\"` أو `node -e \"require.resolve(...)\"` أو `command -v ...`.",
      "لمهام Excel/CSV وWord/PPT وPDF والصور وأتمتة المتصفح والوسائط، افحص القدرة الحالية أولاً. إذا نجح الفحص فاستخدمها مباشرة، وإذا فشل فحدّد هل توجد حزمة تبعية مناسبة.",
      "لا تستخدم أداة Read المدمجة كمحلل لمحتوى PDF أو Office. إذا أعادت Read رسالة Unsupported Document لملف PDF فهذا يعني أن الأداة لا تستطيع تحليله فقط؛ انتقل إلى استخراج Lily قبل الإرسال، أو فهرس المستندات، أو استخراج Python الحتمي باستخدام pdfplumber/PyMuPDF/RapidOCR ومكتبات Office المتاحة.",
      "يجب تثبيت أو إصلاح القدرات القياسية المفقودة عبر مهارة حزم التبعيات (lily-runtime-packs): معالجة المستندات (libreoffice وpro-pdf وpandoc)، معالجة الصور (pillow وopencv وrapidocr وrembg)، أتمتة المتصفح (web-automation)، ومعالجة الوسائط (ffmpeg).",
      "لا تشغّل `pip install` أو `npm install` أو `playwright install` أثناء مهام المستخدم العادية لإصلاح قدرات المنصة. حزم التبعيات ملفات Lily CDN مسبقة البناء مع تحقق checksum. إذا لم توجد حزمة مناسبة، فاذكر أن المنصة الحالية تفتقد تلك القدرة.",
      "بعد تثبيت حزمة تبعية يمكن متابعة الجلسة الحالية؛ ستلتقط العمليات اللاحقة الحزمة عبر PATH أو PYTHONPATH أو NODE_PATH أو متغيرات بيئة مخصصة.",
    ],
  },
};

/** Locale → base ("zh-CN" → "zh") for i18n field fallbacks. */
function baseLocale(loc) {
  return String(loc || "").split("-")[0];
}

/** Read the YAML frontmatter (name/description/…) from a skill's SKILL.md.
 *  Lightweight single-line parser — every skill in this repo uses flat keys. */
function readSkillFrontmatter(skillDir) {
  try {
    const raw = fs.readFileSync(path.join(skillDir, "SKILL.md"), "utf8").replace(/\r\n/g, "\n");
    const m = /^---\s*\n([\s\S]*?)\n---/.exec(raw);
    if (!m) return null;
    const out = {};
    for (const line of m[1].split("\n")) {
      const kv = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
      if (!kv) continue;
      let v = kv[2].trim();
      if (v.length >= 2 && ((v[0] === '"' && v.endsWith('"')) || (v[0] === "'" && v.endsWith("'")))) {
        v = v.slice(1, -1);
      }
      out[kv[1]] = v;
    }
    return out;
  } catch {
    return null;
  }
}

/** Resolve a skill's index entry (display name + when-to-use + on-demand guide
 *  path), preferring localized manifest fields, then SKILL.md frontmatter. */
function skillIndexEntry(skill, loc) {
  const fm = readSkillFrontmatter(skill.skillDir) || {};
  const m = skill.manifest || {};
  const pick = (i18n, fallback) =>
    (i18n && (i18n[loc] || i18n[baseLocale(loc)])) || fallback || "";
  const name = pick(m.name_i18n, m.name) || fm.name || skill.id;
  const desc = pick(m.description_i18n, fm.description || m.description);
  const guidePath = path.join(skill.skillDir, "SKILL.md");
  return { id: skill.id, name, desc: String(desc).trim(), guidePath, hasGuide: fs.existsSync(guidePath) };
}

const SKILL_INDEX_I18N = {
  "zh-CN": {
    title: "技能目录（使用前先读取对应指南）",
    intro:
      "以下是本会话可用的全部技能。对每个用户请求：先按“适用场景”匹配技能（可多选并组合成能力链），在动手前用 Read 工具读取该技能的指南文件以获得完整步骤，再执行。未列出的技能不可用。",
    guideLabel: "指南",
  },
  en: {
    title: "Skill Catalog (read the guide before using a skill)",
    intro:
      "These are all skills available in this session. For each user request: match skills by their \"use when\" description (you may pick several and compose a capability chain), then READ the skill's guide file with the Read tool to get the full steps before acting. Skills not listed here are not available.",
    guideLabel: "Guide",
  },
  ar: {
    title: "فهرس المهارات (اقرأ الدليل قبل استخدام المهارة)",
    intro:
      "هذه جميع المهارات المتاحة في هذه الجلسة. لكل طلب: طابِق المهارات حسب وصف \"استخدمها عند\" (يمكنك اختيار عدة مهارات وتركيبها)، ثم اقرأ ملف دليل المهارة بأداة Read للحصول على الخطوات الكاملة قبل التنفيذ. المهارات غير المدرجة هنا غير متاحة.",
    guideLabel: "الدليل",
  },
};

/** Shorten a skill description to its leading trigger phrase. OpenCode's native
 *  skill registry already injects the FULL verbose description for every skill
 *  (system.ts `Skill.fmt(list, {verbose:true})` -> the `<available_skills>` block
 *  in the system prompt, sourced from the same SKILL.md frontmatter). So this
 *  index only needs a short "use when" pointer + the guide path as a read-tool
 *  fallback — duplicating the whole description here just dilutes every turn. */
function shortIndexDesc(desc, cap = 180) {
  const s = String(desc || "").replace(/\s+/g, " ").trim();
  if (s.length <= cap) return s;
  const slice = s.slice(0, cap);
  // Cut on a word boundary for space-delimited text; CJK (no spaces) hard-caps.
  const trimmed = slice.replace(/\s+\S*$/, "");
  return `${(trimmed.length >= cap * 0.6 ? trimmed : slice).trim()}…`;
}

/** Build the progressive-disclosure skill index: every enabled skill listed with
 *  a SHORT when-to-use trigger and the path to its full guide (loaded on demand,
 *  or read via the Read tool). The authoritative verbose descriptions come from
 *  OpenCode's native skill catalog, so keep these entries terse. */
function buildSkillIndexSection(enabledSkills, loc) {
  const head = SKILL_INDEX_I18N[loc] || SKILL_INDEX_I18N.en;
  const lines = [];
  for (const skill of enabledSkills) {
    const e = skillIndexEntry(skill, loc);
    if (!e.desc) continue;
    const guide = e.hasGuide ? ` (${head.guideLabel}: ${e.guidePath})` : "";
    const label = e.name && e.name !== e.id ? `${e.id} (${e.name})` : e.id;
    lines.push(`- **${label}** — ${shortIndexDesc(e.desc)}${guide}`);
  }
  if (!lines.length) return "";
  return [`## ${head.title}`, "", head.intro, "", ...lines].join("\n");
}

function buildAgentGuideContent(enabledSkills, locale) {
  const loc = locale || getActiveLocale() || "en";
  const guide = AGENT_GUIDE_I18N[loc] || AGENT_GUIDE_I18N["en"];
  const sections = [
    `# ${guide.title}`,
    "",
    guide.identity,
    guide.gatewayNote,
    guide.vendorDisclaimer,
    guide.responseLanguage,
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

  // Tell the model about the app-provided base runtimes and dependency-pack
  // probing ONLY when a runtime actually ships — otherwise (dev /
  // runtime-less build) `python3` may be the system interpreter and the claim
  // would be false.
  if (guide.envTitle && Array.isArray(guide.envNote)) {
    let hasBundledRuntime = false;
    try {
      hasBundledRuntime = Boolean(require("./runtime-python").resolveBundledRuntimeRoot());
    } catch {
      hasBundledRuntime = false;
    }
    if (hasBundledRuntime) {
      sections.push(`## ${guide.envTitle}`, "", ...guide.envNote, "");
    }
  }

  let lastTitle = null;

  for (const skill of enabledSkills) {
    if (!INLINE_GUIDE_SKILL_IDS.has(skill.id)) continue;
    const guide = manifestGuide(skill.manifest, loc);
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

  const index = buildSkillIndexSection(enabledSkills, loc);
  if (index) sections.push(index, "");

  return sections.join("\n").trim() + "\n";
}

/**
 * The SMALL, static identity header — Lily's OWN top-of-guide strings (no
 * invented persona). Used as the OpenCode primary-agent prompt so the engine's
 * `input.agent.prompt ? [input.agent.prompt] : SystemPrompt.provider(model)`
 * ternary (request.ts) takes the agent.prompt branch and SUPPRESSES OpenCode's
 * coding-CLI baseline (prompt/default.txt: "You are opencode… answer in <4
 * lines, one-word answers best"). Without this, that baseline is prepended to
 * every turn and reframes a general workbench request as a terse coding task.
 * The FULL per-turn guide (skills + workspace digest + learned context) still
 * rides `body.system`, so this stays static — safe to bake into the serve config
 * without the per-turn config-diff restart that broke continuity.
 */
function buildAgentBasePersona(locale) {
  const loc = locale || getActiveLocale() || "en";
  const guide = AGENT_GUIDE_I18N[loc] || AGENT_GUIDE_I18N["en"];
  return [
    `# ${guide.title}`,
    "",
    guide.identity,
    guide.gatewayNote,
    guide.vendorDisclaimer,
    guide.responseLanguage,
  ].join("\n");
}

/** Bump when static AGENT.md header or mandatory guide semantics change. */
const AGENT_GUIDE_STATIC_VERSION = 16;

/** @type {Map<string, string>} sessionId → sorted skill id signature */
const sessionGuideWriteCache = new Map();

function getActiveLocale() {
  try {
    return require("./locale-settings").getLocale();
  } catch {
    return "en";
  }
}

function sessionGuideWriteSignature(session, workspacePath = "") {
  const skillSig = resolveSessionSkillIds(session).slice().sort().join("\0");
  const locale = getActiveLocale();
  const learnedSig = learnedContext.contextSignature(session?.projectId, workspacePath);
  return `${AGENT_GUIDE_STATIC_VERSION}\0${locale}\0${skillSig}\0${workspacePath}\0${learnedSig}`;
}

function writeSessionAgentGuide(sessionId, session, workspacePath = "") {
  ensureRuntimeNodeShim();
  const configDir = sessionGuideDir(sessionId);
  const signature = sessionGuideWriteSignature(session, workspacePath);
  if (sessionGuideWriteCache.get(sessionId) === signature) {
    return configDir;
  }
  const skillIds = resolveSessionSkillIds(session);
  const skills = getSkillsForIds(skillIds);
  fs.mkdirSync(configDir, { recursive: true });
  ensureSessionConfigBridge(configDir);
  const guidePath = path.join(configDir, "AGENT.md");
  const locale = getActiveLocale();
  const learnedSections =
    learnedContext.buildWorkspaceDigestSection(workspacePath) +
    learnedContext.buildWorkspaceRulesSection(workspacePath) +
    learnedContext.buildLearnedSection(session?.projectId) +
    buildCrystallizationSection();
  fs.writeFileSync(guidePath, buildAgentGuideContent(skills, locale) + learnedSections, "utf8");
  syncEngineGuideMirror(guidePath, configDir);
  sessionGuideWriteCache.set(sessionId, signature);
  return configDir;
}

/**
 * Register a learned-skill draft (L3 crystallization). Workspace-origin drafts
 * are installed as learned skills and bound to the current project so new chats
 * in that workspace can use the generated capability immediately. They are not
 * globally enabled unless the user explicitly enables them in Settings.
 */
function registerLearnedSkillDir(srcDir, manifest, context = {}) {
  const baseId = String(manifest?.id || "");
  const id = baseId.startsWith("learned-") ? baseId : `learned-${baseId}`;
  if (PROTECTED_BUNDLED_IDS.has(id) || PROTECTED_BUNDLED_IDS.has(baseId)) return null;
  const target = installedSkillDir(id);
  copyDirRecursiveShipSafe(srcDir, target);
  let installedManifest;
  if (id !== baseId) {
    try {
      const manifestPath = path.join(target, "skill.manifest.json");
      installedManifest = { ...JSON.parse(fs.readFileSync(manifestPath, "utf8")), id };
      const updated = installedManifest;
      fs.writeFileSync(manifestPath, `${JSON.stringify(updated, null, 2)}\n`, "utf8");
    } catch {
      return null;
    }
  } else {
    installedManifest = loadManifestFromDir(target);
  }
  if (!installedManifest) return null;

  const skillMdPath = path.join(target, "SKILL.md");
  if (fs.existsSync(skillMdPath)) {
    const replacements = buildReplacements(target, installedManifest);
    const skillMd = applyPlaceholders(fs.readFileSync(skillMdPath, "utf8"), replacements);
    fs.writeFileSync(skillMdPath, skillMd, "utf8");
  }

  const state = loadSkillsState();
  const existing = state.skills[id] || {};
  const projectId = normalizeProjectId(context.projectId);
  const enabledProjectIds = uniqueStrings([
    ...uniqueStrings(existing.enabledProjectIds),
    ...(projectId ? [projectId] : []),
  ]);
  state.skills[id] = {
    ...existing,
    id,
    enabled: existing.enabled === true,
    source: "learned",
    installedVersion: String(manifest.version || "0.1.0"),
    workspaceOnly: Boolean(installedManifest.workspaceOnly || installedManifest.origin === "workspace"),
    enabledProjectIds,
    createdForProjectId: existing.createdForProjectId || projectId || undefined,
    updatedAt: new Date().toISOString(),
  };
  saveSkillsState();
  return id;
}

// `includeInstalled` widens the set from only workspace-learned skills to every
// enabled, non-protected installed skill — used when the author opts to bundle
// the project's skills into the pack (so the recipient needs no network fetch).
// Protected built-in skills are always skipped (the recipient already has them).
function listWorkspaceSkillExports(projectId = "", { includeInstalled = false } = {}) {
  const pid = normalizeProjectId(projectId);
  ensureSkillsStateDefaults();
  const state = loadSkillsState();
  const out = [];
  for (const [skillId, entry] of Object.entries(state.skills || {})) {
    if (PROTECTED_BUNDLED_IDS.has(skillId)) continue;
    const manifest = readInstalledManifest(skillId);
    if (!manifest) continue;
    if (!includeInstalled && !isWorkspaceSkillEntry(skillId, entry, manifest)) continue;
    const projectBindings = uniqueStrings(entry?.enabledProjectIds);
    const legacyGlobalWorkspaceSkill = projectBindings.length === 0 && entry?.enabled !== false;
    const enabledForProject = isSkillEnabledForProject(entry, pid);
    if (pid && !enabledForProject && !legacyGlobalWorkspaceSkill) continue;
    const dir = installedSkillDir(skillId);
    if (!fs.existsSync(path.join(dir, "SKILL.md"))) continue;
    out.push({
      id: skillId,
      dir,
      manifest,
      enabled: pid ? enabledForProject || legacyGlobalWorkspaceSkill : entry?.enabled !== false,
    });
  }
  out.sort((a, b) => a.id.localeCompare(b.id));
  return out;
}

function restoreWorkspaceSkillDir(srcDir, manifest, { enabled = false, projectId = "" } = {}) {
  const id = String(manifest?.id || "").trim();
  if (!SKILL_ID_RE.test(id) || PROTECTED_BUNDLED_IDS.has(id)) return null;
  if (!srcDir || !fs.existsSync(path.join(srcDir, "SKILL.md"))) return null;
  const target = installedSkillDir(id);
  fs.rmSync(target, { recursive: true, force: true });
  copyDirRecursiveShipSafe(srcDir, target);
  const installedManifestPath = path.join(target, "skill.manifest.json");
  let installedManifest;
  try {
    installedManifest = JSON.parse(fs.readFileSync(installedManifestPath, "utf8"));
  } catch {
    fs.rmSync(target, { recursive: true, force: true });
    return null;
  }
  if (String(installedManifest?.id || "") !== id) {
    fs.rmSync(target, { recursive: true, force: true });
    return null;
  }
  installedManifest = {
    ...installedManifest,
    id,
    origin: installedManifest.origin || "workspace",
    workspaceOnly: true,
    publisher: installedManifest.publisher || "Workspace",
  };
  fs.writeFileSync(installedManifestPath, `${JSON.stringify(installedManifest, null, 2)}\n`, "utf8");

  const state = loadSkillsState();
  const existing = state.skills[id] || {};
  const pid = normalizeProjectId(projectId);
  state.skills[id] = {
    ...existing,
    id,
    enabled: Boolean(existing.enabled || (!pid && enabled)),
    source: "learned",
    installedVersion: String(installedManifest.version || manifest.version || "0.1.0"),
    workspaceOnly: true,
    enabledProjectIds: uniqueStrings([
      ...uniqueStrings(existing.enabledProjectIds),
      ...(pid && enabled !== false ? [pid] : []),
    ]),
    restoredAt: new Date().toISOString(),
  };
  saveSkillsState();
  mergeAgentGuide();
  return id;
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
      source: skill.source || null,
      origin: skill.origin || null,
      workspaceOnly: Boolean(skill.workspaceOnly),
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

function manifestGuide(manifest, localeOverride = null) {
  if (!manifest) return null;
  const locale = localeOverride || getActiveLocale();
  const i18n = manifest.guideMd_i18n;
  if (i18n && i18n[locale]) return i18n[locale];
  const baseLocale = String(locale || "").split(/[-_]/)[0];
  if (i18n && baseLocale && i18n[baseLocale]) return i18n[baseLocale];
  // Non-zh locales must never fall through to the Chinese base text —
  // English is the universal fallback (zh keeps its base).
  if (i18n && i18n.en && !String(locale).startsWith("zh")) return i18n.en;
  if (!String(locale).startsWith("zh") && containsCjk(manifest.guideMd || manifest.claudeMd || "")) {
    return null;
  }
  return manifest.guideMd || manifest.claudeMd || null;
}

function containsCjk(value) {
  return /[\u4e00-\u9fff]/.test(typeof value === "string" ? value : JSON.stringify(value || ""));
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
  const baseLocale = String(locale || "").split(/[-_]/)[0];
  if (i18n && typeof i18n === "object" && baseLocale && i18n[baseLocale]) {
    return i18n[baseLocale];
  }
  // English before the (Chinese) base field for non-zh locales.
  if (i18n && typeof i18n === "object" && i18n.en && !String(locale).startsWith("zh")) {
    return i18n.en;
  }
  const baseValue = manifest[field];
  if (!String(locale).startsWith("zh") && containsCjk(baseValue)) {
    return defaultValue;
  }
  return baseValue || defaultValue;
}

function localizeRegistryCategory(category) {
  if (!category) return category;
  return {
    ...category,
    label: resolveLocalized(
      {
        label: category.label,
        label_i18n: category.label_i18n,
      },
      "label",
      category.label || category.id,
    ),
  };
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
    if (service?.apiBaseUrl) return `${service.apiBaseUrl}/api/skills/registry`;
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
  const manifestName = resolveLocalized(manifest, "name", registryEntry?.name || skillId);
  const manifestDescription = resolveLocalized(manifest, "description", registryEntry?.description || "");
  const manifestCategoryLabel = resolveLocalized(manifest, "categoryLabel", manifest?.categoryLabel || null);
  const registryName = resolveLocalized(registryEntry, "name", registryEntry?.name || skillId);
  const registryDescription = resolveLocalized(registryEntry, "description", registryEntry?.description || "");
  const registryCategoryLabel = resolveLocalized(
    registryEntry,
    "categoryLabel",
    registryEntry?.categoryLabel || null,
  );
  const registryChangelog = resolveLocalized(registryEntry, "changelog", registryEntry?.changelog || "");
  const preferRegistryDisplay = entry?.source === "remote" && Boolean(registryEntry);
  const origin =
    manifest?.origin ||
    (entry?.source === "learned" || manifest?.publisher === "Workspace" ? "workspace" : "platform");
  const workspaceOnly = Boolean(manifest?.workspaceOnly || origin === "workspace");
  const category =
    workspaceOnly ? "workspace" : (registryEntry?.category || manifest?.category || null);

  return {
    id: skillId,
    name: preferRegistryDisplay ? (registryName || manifestName) : manifestName,
    description: preferRegistryDisplay
      ? (registryDescription || manifestDescription)
      : manifestDescription,
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
    // The user can uninstall what they installed or learned — remote skills and
    // their own learned/workspace skills. Bundled platform skills stay protected.
    canUninstall: entry?.source === "remote" || entry?.source === "learned",
    updateAvailable,
    changelog: registryChangelog,
    category,
    categoryLabel:
      workspaceOnly
        ? manifestCategoryLabel
        : (registryCategoryLabel || manifestCategoryLabel),
    capabilityLayer: registryEntry?.capabilityLayer || "core",
    capability: registryEntry?.capability || manifest?.capability || null,
    riskLevel: registryEntry?.riskLevel || "low",
    defaultEligible: Boolean(registryEntry?.defaultEligible),
    featured: Boolean(registryEntry?.featured),
    origin,
    workspaceOnly,
  };
}

function availableSkillToPublic(registryEntry, installedVersion) {
  const updateAvailable =
    installedVersion && compareSemver(registryEntry.latestVersion, installedVersion) > 0;
  const name = resolveLocalized(registryEntry, "name", registryEntry.name || registryEntry.id);
  const description = resolveLocalized(
    registryEntry,
    "description",
    registryEntry.description || registryEntry.changelog || "",
  );
  const changelog = resolveLocalized(registryEntry, "changelog", registryEntry.changelog || "");
  const categoryLabel = resolveLocalized(registryEntry, "categoryLabel", registryEntry.categoryLabel || null);

  return {
    id: registryEntry.id,
    name,
    description,
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
    changelog,
    minAppVersion: registryEntry.minAppVersion,
    compatible: isAppVersionCompatible(registryEntry.minAppVersion),
    category: registryEntry.category || null,
    categoryLabel,
    publisher: registryEntry.publisher || null,
    sourceType: registryEntry.sourceType || "zip",
    capabilityLayer: registryEntry.capabilityLayer || "core",
    capability: registryEntry.capability || null,
    riskLevel: registryEntry.riskLevel || "low",
    defaultEligible: Boolean(registryEntry.defaultEligible),
    featured: Boolean(registryEntry.featured),
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

  const bundled = skillRegistry.ensureBundledRegistryCached();
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
  const pruned = pruneInstalledSkillsNotInRegistry(registry);
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
    if (regEntry.displayInCatalog === false) continue;
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
    pruned,
    categories: skillRegistry.categoriesForRegistry(registry).map(localizeRegistryCategory),
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
  const locale = getActiveLocale();
  return [...(available || [])].sort((a, b) => {
    const aFeatured = (a.featured || a.defaultEligible || featured.has(a.id)) ? 0 : 1;
    const bFeatured = (b.featured || b.defaultEligible || featured.has(b.id)) ? 0 : 1;
    if (aFeatured !== bFeatured) return aFeatured - bFeatured;
    return String(a.name || a.id).localeCompare(String(b.name || b.id), locale);
  });
}

async function loadServiceRegistryForSync({ fetch = true } = {}) {
  const serviceUrl = getServiceRegistryUrl();
  if (!serviceUrl) return { ok: false, error: "NO_SERVICE_URL" };
  if (fetch) return fetchServiceRegistry();
  const cached = skillRegistry.loadCachedRegistry();
  if (cached?.sourceUrl === serviceUrl) return { ok: true, registry: cached };
  return { ok: false, error: "NO_SERVICE_REGISTRY" };
}

async function syncServiceSkillPackages({ fetch = true } = {}) {
  const service = await loadServiceRegistryForSync({ fetch });
  if (!service.ok) {
    return { ok: true, skipped: true, reason: service.error };
  }

  const entries = (service.registry.skills || [])
    .filter((entry) => !PROTECTED_BUNDLED_IDS.has(entry.id))
    .filter((entry) => isAppVersionCompatible(entry.minAppVersion));

  const installed = [];
  const updated = [];
  const skipped = [];
  const failed = [];

  for (const entry of entries) {
    const manifest = readInstalledManifest(entry.id);
    const stateEntry = loadSkillsState().skills[entry.id];
    const isInstalled = Boolean(manifest);
    const updateAvailable =
      isInstalled && compareSemver(entry.latestVersion, manifest.version || "0.0.0") > 0;
    const shouldInstall = !isInstalled && Boolean(entry.defaultEligible);
    const shouldUpdate = isInstalled && stateEntry?.source === "remote" && updateAvailable;

    if (!shouldInstall && !shouldUpdate) {
      skipped.push(entry.id);
      continue;
    }

    const result = await skillInstaller.installFromRegistryEntry(entry);
    if (!result.ok) {
      failed.push({ id: entry.id, error: result.error || "INSTALL_FAILED", detail: result.detail || "" });
      continue;
    }

    if (shouldInstall) {
      installed.push(entry.id);
      reportSkillEvent("install", entry.id, result.version, { reason: "auto-sync" });
    } else {
      updated.push(entry.id);
      reportSkillEvent("update", entry.id, result.version, { reason: "auto-sync" });
    }
  }

  const state = loadSkillsState();
  state.meta = {
    ...(state.meta && typeof state.meta === "object" ? state.meta : {}),
    serviceSkillSyncAt: new Date().toISOString(),
    serviceSkillSyncSource: service.registry.sourceUrl || getServiceRegistryUrl(),
  };
  saveSkillsState();

  if (installed.length || updated.length) {
    mergeAgentGuide();
  }

  return {
    ok: failed.length === 0,
    registryUrl: service.registry.sourceUrl || getServiceRegistryUrl(),
    installed,
    updated,
    skipped,
    failed,
  };
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
  mergeAgentGuide();
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
  mergeAgentGuide();
  reportSkillEvent("uninstall", skillId, null);
  return { ok: true, skills: listSkillsPublic() };
}

function reportSkillEvent(eventType, skillId, skillVersion, metadata = {}) {
  require("./service-client")
    .reportSkillEvent({ eventType, skillId, skillVersion, metadata })
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
  const registry = skillRegistry.supplementRegistryWithBundled(cached) || skillRegistry.ensureBundledRegistryCached();
  const registryById = Object.fromEntries((registry?.skills || []).map((s) => [s.id, s]));
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
  const bundledRegistry = skillRegistry.ensureBundledRegistryCached();
  const installed = ensureBundledPresent();
  const pruned = pruneInstalledSkillsNotInRegistry(bundledRegistry);
  mergeAgentGuide();
  return { installed, pruned };
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
  syncServiceSkillPackages,
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
  buildAgentGuideContent,
  buildAgentBasePersona,
  buildReplacements,
  readInstalledManifest,
  installedSkillDir,
  writeSessionAgentGuide,
  registerLearnedSkillDir,
  listWorkspaceSkillExports,
  restoreWorkspaceSkillDir,
  resolveSessionSkillIds,
  getWorkspaceEnabledSkillIds,
  normalizeSessionSkillSelection,
  syncInheritedSessionGuides,
  getGloballyEnabledSkillIds,
  getEnabledRegistrySkillIds,
};
