#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_API = "https://lilych.lilywb.cn";
const DEFAULT_CHANNEL = "stable";
const DEFAULT_SKILL_OUT = path.join(ROOT, "dist", "skill-packs");
const DEFAULT_APP_OUT = path.join(ROOT, "dist", "workspace-apps");
const DEFAULT_QINIU_BUCKET = "lanrensoft";
const DEFAULT_QINIU_DOMAIN = "https://qny.lanrensoft.cn";
const DEFAULT_QINIU_UP_HOST = "https://upload.qiniup.com";
const DIRECT_APP_UPLOAD_THRESHOLD_BYTES = 40 * 1024 * 1024;
const LOCAL_SERVER_SKILL_IDS = new Set([
  "anthropics-docx",
  "anthropics-pdf",
  "anthropics-pptx",
  "anthropics-xlsx",
]);

const WORKSPACE_APP_BUILDERS = [
  {
    appId: "mail-assistant",
    version: "1.0.1",
    script: "scripts/build-mail-workspace-app.mjs",
    name: "邮件助手",
    summary: "连接 Gmail、Outlook/Microsoft 365 和 IMAP/SMTP，用自然语言搜索、总结、草拟和确认发送邮件。",
    description:
      "邮件助手把邮箱作为当前工作区连接器接入，支持搜索邮件、读取线程、总结重点、查找附件、起草回复，并在用户确认后发送或执行归档等高风险动作。账号凭据通过连接器安全存储，不写入聊天或工作区文件。",
    category: "connectors",
    appType: "connector",
    riskLevel: "high",
    featured: true,
    tags: ["mail", "gmail", "outlook", "imap", "connector"],
    requiredSkillPackages: ["lily-mail-assistant"],
    minAppVersion: "0.1.48",
  },
  {
    appId: "web-system-learning",
    version: "1.0.9",
    versionFromRequiredSkills: true,
    script: "scripts/build-web-system-learning-workspace-app.mjs",
    name: "网页系统学习",
    summary: "学习 OA、ERP、CRM 和后台系统，生成页面地图、动作地图、API 地图和工作区技能。",
    description:
      "网页系统学习用于把内部 OA、ERP、CRM、后台和门户系统变成当前工作区自然语言能力。它先在用户授权域名内做只读学习，生成系统画像、页面地图、动作地图、API 地图、Playbook 并保存为工作区技能；后续新对话自动加载，查询/导出可走已验证能力，提交类动作仍必须二次确认。",
    category: "business",
    appType: "connector",
    riskLevel: "high",
    featured: true,
    tags: ["web", "oa", "erp", "crm", "admin", "automation"],
    requiredSkillPackages: ["lily-web-system-learning"],
    minAppVersion: "0.1.48",
  },
  {
    appId: "daily-stock-analysis",
    version: "1.0.6",
    script: "scripts/build-stock-workspace-app.mjs",
    name: "股票智能分析 Starter",
    summary: "安装股票投研示范工作区，结合联网研究、Excel 分析和多 Agent 流程生成结构化报告。",
    description:
      "股票智能分析 Starter 是面向投研场景的示范应用，内置工作区模板、执行约定和所需技能声明。它帮助用户围绕股票列表做资料收集、数据整理、风险提示和结构化报告输出，并明确区分事实、推断和非投资建议边界。",
    category: "finance",
    appType: "workspace",
    riskLevel: "medium",
    featured: false,
    tags: ["stock", "finance", "research", "excel"],
    requiredSkillPackages: [
      "lily-stock-research",
      "lily-research-synthesis",
      "lily-excel-data-analysis",
      "lily-code-repair",
    ],
    minAppVersion: "0.1.48",
    optionalSourceDir: ".lily-work/app-build/daily-stock-analysis",
  },
];

function usage() {
  console.error(`usage:
  node scripts/publish-local-catalog-server.mjs [--api ${DEFAULT_API}] [--channel stable] [--version 1.0.0] [--upload]

Publishes product-maintained local skill packages and workspace app packages to the Lily server.
The server validates artifacts and uploads them to Qiniu, then updates public registries.

auth:
  RELEASE_ADMIN_TOKEN
  or RELEASE_ADMIN_EMAIL + RELEASE_ADMIN_PASSWORD

options:
  --skills-only
  --apps-only
  --skip-skills
  --skip-apps
  --app app-id
  --bucket ${DEFAULT_QINIU_BUCKET}
  --domain ${DEFAULT_QINIU_DOMAIN}
  --qiniu-up-host ${DEFAULT_QINIU_UP_HOST}
  --force
  --dry-run
`);
  process.exit(1);
}

function parseArgs(argv) {
  const out = {
    api: DEFAULT_API,
    channel: DEFAULT_CHANNEL,
    upload: false,
    dryRun: false,
    force: false,
    skills: true,
    apps: true,
    version: "",
    appId: "",
    only: null,
    bucket: process.env.RELEASE_QINIU_BUCKET || process.env.QINIU_BUCKET || DEFAULT_QINIU_BUCKET,
    domain: process.env.RELEASE_QINIU_DOMAIN || process.env.QINIU_PUBLIC_BASE_URL || DEFAULT_QINIU_DOMAIN,
    qiniuUpHost: process.env.QINIU_UP_HOST || DEFAULT_QINIU_UP_HOST,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];
    if (!item.startsWith("--")) usage();
    const key = item.slice(2);
    if (key === "upload") out.upload = true;
    else if (key === "dry-run") out.dryRun = true;
    else if (key === "force") out.force = true;
    else if (key === "skills-only") out.apps = false;
    else if (key === "apps-only") out.skills = false;
    else if (key === "skip-skills") out.skills = false;
    else if (key === "skip-apps") out.apps = false;
    else if (key === "api") out.api = argv[++i] || "";
    else if (key === "channel") out.channel = argv[++i] || "";
    else if (key === "version") out.version = argv[++i] || "";
    else if (key === "app") out.appId = argv[++i] || "";
    else if (key === "only") { out.only = out.only || new Set(); out.only.add(argv[++i] || ""); }
    else if (key === "bucket") out.bucket = argv[++i] || "";
    else if (key === "domain") out.domain = argv[++i] || "";
    else if (key === "qiniu-up-host") out.qiniuUpHost = argv[++i] || "";
    else if (key === "help" || key === "h") usage();
    else usage();
  }
  if (!out.api || !out.channel) usage();
  if (!out.skills && !out.apps) usage();
  if (out.appId && !out.apps) usage();
  return out;
}

function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function compareSemver(a, b) {
  const left = String(a || "")
    .split(".")
    .map((part) => Number.parseInt(part, 10))
    .map((part) => (Number.isFinite(part) ? part : 0));
  const right = String(b || "")
    .split(".")
    .map((part) => Number.parseInt(part, 10))
    .map((part) => (Number.isFinite(part) ? part : 0));
  const len = Math.max(left.length, right.length, 3);
  for (let i = 0; i < len; i += 1) {
    const diff = (left[i] || 0) - (right[i] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

function skillManifestVersion(skillId) {
  if (!skillId) return "";
  const manifest = readJson(path.join(ROOT, "resources", "skills-catalog", skillId, "skill.manifest.json"), {});
  return String(manifest?.version || "").trim();
}

function resolveWorkspaceAppVersion(app, options = {}) {
  const fallback = app.version || options.version || "";
  if (!app?.versionFromRequiredSkills) return fallback;
  const versions = (app.requiredSkillPackages || [])
    .map((skillId) => skillManifestVersion(skillId))
    .filter(Boolean);
  if (versions.length === 0) return fallback;
  const latestRequiredSkillVersion = versions.sort(compareSemver).at(-1);
  if (!fallback || compareSemver(latestRequiredSkillVersion, fallback) >= 0) {
    return latestRequiredSkillVersion;
  }
  return fallback;
}

function runCapture(command, argsList) {
  const result = spawnSync(command, argsList, {
    cwd: ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    const output = `${result.stdout || ""}${result.stderr || ""}`.trim();
    throw new Error(`${command} ${argsList.join(" ")} failed${output ? `: ${output}` : ""}`);
  }
  return result.stdout || "";
}

function shellQuote(value) {
  const s = String(value);
  return /^[A-Za-z0-9_./:=@-]+$/.test(s) ? s : JSON.stringify(s);
}

function joinPublicUrl(domain, objectKey) {
  return `${String(domain || "").replace(/\/+$/g, "")}/${String(objectKey || "").replace(/^\/+/g, "")}`;
}

function withCacheBuster(rawUrl, params = {}) {
  const parsed = new URL(rawUrl);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") {
      parsed.searchParams.set(key, String(value));
    }
  }
  return parsed.toString();
}

function normalizeObjectSegment(value, fallback) {
  return String(value || fallback)
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120) || fallback;
}

function workspaceAppObjectKey({ appId, version, filePath }) {
  const safeAppId = normalizeObjectSegment(appId, "workspace-app");
  const safeVersion = normalizeObjectSegment(version, "0.0.0");
  const safeFile = normalizeObjectSegment(path.basename(filePath), "workspace-app.zip");
  return `workspace-apps/${safeAppId}/${safeVersion}/${safeFile}`;
}

function skillArtifactObjectKey({ skillId, version, sha256, filePath }) {
  const safeSkillId = normalizeObjectSegment(skillId, "skill");
  const safeVersion = normalizeObjectSegment(version, "0.0.0");
  const safeFile = normalizeObjectSegment(path.basename(filePath), "skill.skillpack.zip");
  const digest = String(sha256 || "").trim().toLowerCase().slice(0, 16) || "unverified";
  return `skill-packages/${safeSkillId}/${safeVersion}/${digest}-${safeFile}`;
}

function qshellAvailable() {
  const result = spawnSync("qshell", ["--version"], {
    cwd: ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return result.status === 0;
}

function uploadQiniuWithQshell({ bucket, objectKey, filePath, upHost }) {
  const localFile = path.resolve(ROOT, filePath);
  const uploadFile = path.relative(ROOT, localFile).startsWith("..") ? localFile : path.relative(ROOT, localFile);
  const args = ["rput", bucket, objectKey, uploadFile, "--overwrite", "--up-host", upHost || DEFAULT_QINIU_UP_HOST];
  console.log(`[publish-local-catalog] qiniu upload: qshell ${args.map(shellQuote).join(" ")}`);
  const result = spawnSync("qshell", args, {
    cwd: ROOT,
    stdio: "inherit",
  });
  if (result.status === 0) return;

  const legacyArgs = ["rput", bucket, objectKey, uploadFile, "true"];
  console.log(`[publish-local-catalog] qiniu upload retry: qshell ${legacyArgs.map(shellQuote).join(" ")}`);
  const legacy = spawnSync("qshell", legacyArgs, {
    cwd: ROOT,
    stdio: "inherit",
  });
  if (legacy.status !== 0) {
    throw new Error(`qshell upload failed for ${objectKey}`);
  }
}

function buildJson(command, argsList) {
  console.log(`[publish-local-catalog] ${command} ${argsList.map(shellQuote).join(" ")}`);
  const stdout = runCapture(command, argsList);
  return JSON.parse(stdout);
}

function normalizeBaseUrl(api) {
  return String(api || "").replace(/\/+$/g, "");
}

function registryById() {
  const registry = readJson(path.join(ROOT, "resources", "skills-registry", "registry.json"), { skills: [] });
  const byId = new Map();
  const capabilities = registry.capabilities || {};
  for (const entry of registry.skills || []) {
    byId.set(entry.id, { ...entry, capability: entry.capability || capabilities[entry.id] || null });
  }
  return byId;
}

function registryEntries() {
  const registry = readJson(path.join(ROOT, "resources", "skills-registry", "registry.json"), { skills: [] });
  const capabilities = registry.capabilities || {};
  return Array.isArray(registry.skills)
    ? registry.skills.map((entry) => ({ ...entry, capability: entry.capability || capabilities[entry.id] || null }))
    : [];
}

function localSkillDirs() {
  const catalogDir = path.join(ROOT, "resources", "skills-catalog");
  return fs
    .readdirSync(catalogDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && (entry.name.startsWith("lily-") || LOCAL_SERVER_SKILL_IDS.has(entry.name)))
    .map((entry) => path.join(catalogDir, entry.name))
    .filter((skillDir) => fs.existsSync(path.join(skillDir, "SKILL.md")))
    .sort((a, b) => path.basename(a).localeCompare(path.basename(b)));
}

function extendedDescription(entry = {}, manifest = {}) {
  const parts = [
    entry.description || manifest.description || "",
    entry.changelog || "",
    manifest.guideMd?.body || "",
    manifest.description_i18n?.en || "",
  ]
    .map((item) => String(item || "").trim())
    .filter(Boolean);
  const joined = [...new Set(parts)].join(" ");
  return joined.length >= 80
    ? joined.slice(0, 2000)
    : `${joined} Lily 官方维护技能包，用于提升工作区助手的稳定执行、可审计操作、可复用能力和跨版本一致体验。该描述由发布脚本补齐，确保服务端质量门禁可以稳定校验。`;
}

function stringMapField(...candidates) {
  const out = {};
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue;
    for (const [locale, value] of Object.entries(candidate)) {
      if (!locale || typeof value !== "string") continue;
      const text = value.trim();
      if (text) out[String(locale)] = text;
    }
  }
  return Object.keys(out).length > 0 ? JSON.stringify(out) : "";
}

function normalizeSkillCategory(category) {
  const value = String(category || "").trim();
  if (value === "dev") return "coding";
  return value || "core";
}

function skillUploadFields({ pack, skillDir, channel }) {
  const manifest = readJson(path.join(skillDir, "skill.manifest.json"), {});
  const entry = registryById().get(pack.skillId) || {};
  const riskLevel = entry.riskLevel || manifest.riskLevel || "low";
  const publisher = entry.publisher || manifest.publisher || "Lily Workbench";
  const sourceKind = entry.sourceKind || manifest.sourceKind || "lily";
  const lilyReviewed = publisher === "Lily Workbench" && sourceKind === "lily";
  const defaultEligible = riskLevel === "high" || !lilyReviewed ? false : Boolean(entry.defaultEligible);
  const featured = riskLevel === "high" ? false : Boolean(entry.featured && defaultEligible);
  return {
    skillId: pack.skillId,
    name: entry.name || manifest.name || pack.name || pack.skillId,
    nameI18n: stringMapField(manifest.name_i18n, entry.name_i18n),
    description: extendedDescription(entry, manifest),
    descriptionI18n: stringMapField(manifest.description_i18n, entry.description_i18n),
    version: pack.version,
    category: normalizeSkillCategory(entry.category || manifest.category),
    categoryLabel: entry.categoryLabel || manifest.categoryLabel || "",
    categoryLabelI18n: stringMapField(manifest.categoryLabel_i18n, entry.categoryLabel_i18n),
    capabilityLayer: entry.capabilityLayer || manifest.capabilityLayer || "core",
    capabilityContract: entry.capability ? JSON.stringify(entry.capability) : "",
    publisher,
    sourceKind,
    sourceRepo: entry.sourceRepo || manifest.sourceRepo || "lily-workbench/skills",
    minAppVersion: entry.minAppVersion || manifest.minAppVersion || "0.1.0",
    channel,
    riskLevel,
    defaultEligible: String(defaultEligible),
    featured: String(featured),
    displayInCatalog: String(entry.displayInCatalog !== false && manifest.displayInCatalog !== false),
    notes: entry.changelog || `Published from ${path.relative(ROOT, skillDir)}`,
  };
}

function registryMetadataUploadFields({ entry, existing, channel }) {
  if (!entry?.id) throw new Error("registry entry is missing id");
  if (!existing?.artifact_url && !existing?.download_url) {
    throw new Error(`existing skill package ${entry.id} is missing artifact_url`);
  }
  const publisher = entry.publisher || existing.publisher || "Lily Workbench";
  const sourceKind = entry.sourceKind || existing.source_kind || "lily";
  const riskLevel = entry.riskLevel || existing.risk_level || "low";
  const lilyReviewed = publisher === "Lily Workbench" && sourceKind === "lily";
  const defaultEligible = riskLevel === "high" || !lilyReviewed
    ? false
    : Boolean(entry.defaultEligible ?? existing.default_eligible);
  return {
    skillId: entry.id,
    name: entry.name || entry.id,
    nameI18n: stringMapField(entry.name_i18n),
    description: extendedDescription(entry, {}),
    descriptionI18n: stringMapField(entry.description_i18n),
    version: existing.version || entry.latestVersion || "1.0.0",
    category: normalizeSkillCategory(entry.category || existing.category),
    categoryLabel: entry.categoryLabel || existing.category_label || "",
    categoryLabelI18n: stringMapField(entry.categoryLabel_i18n),
    capabilityLayer: entry.capabilityLayer || existing.capability_layer || "core",
    capabilityContract: entry.capability ? JSON.stringify(entry.capability) : "",
    publisher,
    sourceKind,
    sourceRepo: entry.sourceRepo || existing.source_repo || "",
    minAppVersion: entry.minAppVersion || existing.min_app_version || "0.1.0",
    channel,
    riskLevel,
    defaultEligible: String(defaultEligible),
    featured: String(Boolean(entry.featured ?? existing.featured) && defaultEligible),
    displayInCatalog: String(entry.displayInCatalog !== false),
    notes: entry.changelog || existing.notes || `Metadata synchronized from bundled registry for ${entry.id}`,
    artifactUrl: existing.artifact_url || existing.download_url,
    sha256: existing.sha256,
    sizeBytes: existing.size_bytes,
    enabled: existing.enabled !== false,
  };
}

function appUploadFields({ app, artifact, channel }) {
  return {
    appId: app.appId,
    name: app.name,
    summary: app.summary,
    description: app.description,
    version: artifact.version,
    category: app.category,
    appType: app.appType,
    entryKind: "zip",
    publisher: "Lily Workbench",
    sourceKind: "lily",
    sourceRepo: "lily-workbench/apps",
    minAppVersion: app.minAppVersion || "0.1.0",
    channel,
    riskLevel: app.riskLevel,
    featured: String(Boolean(app.featured && app.riskLevel !== "high")),
    tags: app.tags.join(","),
    requiredRuntimePacks: "",
    requiredSkillPackages: app.requiredSkillPackages.join(","),
    notes: `Published from ${app.script}`,
  };
}

function workspaceAppArtifactPath(artifact) {
  return artifact?.path
    || artifact?.artifactPath
    || artifact?.packagePath
    || artifact?.file
    || artifact?.filePath
    || artifact?.outputPath
    || artifact?.zipPath
    || "";
}

function workspaceAppBuildArgs(app, options = {}) {
  const args = [app.script, "--out", DEFAULT_APP_OUT];
  const version = resolveWorkspaceAppVersion(app, options);
  if (version) args.push("--version", version);
  return args;
}

function existingByKey(rows, idKey, channel) {
  const byKey = new Map();
  for (const row of rows || []) {
    if ((row.channel || DEFAULT_CHANNEL) !== channel) continue;
    byKey.set(`${row[idKey]}@${row.version}`, row);
  }
  return byKey;
}

function latestExistingById(rows, idKey, channel) {
  const byId = new Map();
  for (const row of rows || []) {
    if ((row.channel || DEFAULT_CHANNEL) !== channel) continue;
    const id = row[idKey];
    if (!id) continue;
    const current = byId.get(id);
    if (!current || String(row.version || "").localeCompare(String(current.version || ""), undefined, { numeric: true }) > 0) {
      byId.set(id, row);
    }
  }
  return byId;
}

async function login(api) {
  const token = process.env.RELEASE_ADMIN_TOKEN;
  if (token) return { authorization: `Bearer ${token}`, cookie: "" };

  const email = process.env.RELEASE_ADMIN_EMAIL;
  const password = process.env.RELEASE_ADMIN_PASSWORD;
  if (!email || !password) {
    throw new Error("missing admin auth: set RELEASE_ADMIN_TOKEN or RELEASE_ADMIN_EMAIL + RELEASE_ADMIN_PASSWORD");
  }
  const response = await fetch(`${api}/api/admin/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (!response.ok) throw new Error(`admin login failed: HTTP ${response.status}`);
  const cookie = response.headers.get("set-cookie")?.match(/(?:^|,?\s*)lily_admin_session=([^;]+)/)?.[1];
  if (!cookie) throw new Error("admin login succeeded but no session cookie was returned");
  return { authorization: "", cookie: `lily_admin_session=${decodeURIComponent(cookie)}` };
}

function authHeaders(auth) {
  const headers = {};
  if (auth.authorization) headers.Authorization = auth.authorization;
  if (auth.cookie) headers.Cookie = auth.cookie;
  return headers;
}

async function fetchJson(api, auth, route) {
  const response = await fetch(`${api}${route}`, { headers: authHeaders(auth) });
  if (!response.ok) throw new Error(`GET ${route} failed: HTTP ${response.status}`);
  return response.json();
}

function wait(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function fetchRemoteSha256(remoteUrl, { maxBytes = 100 * 1024 * 1024, timeoutMs = 120_000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(remoteUrl, {
      signal: controller.signal,
      headers: { "Cache-Control": "no-cache" },
    });
    if (!response.ok) {
      throw new Error(`GET ${remoteUrl} failed: HTTP ${response.status}`);
    }
    const length = Number(response.headers.get("content-length") || 0);
    if (length > maxBytes) {
      throw new Error(`remote artifact too large: ${length} bytes`);
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > maxBytes) {
      throw new Error(`remote artifact too large: ${buffer.length} bytes`);
    }
    return {
      sha256: crypto.createHash("sha256").update(buffer).digest("hex"),
      sizeBytes: buffer.length,
    };
  } finally {
    clearTimeout(timer);
  }
}

async function waitForRemoteArtifactSha({ artifactUrl, expectedSha256, maxAttempts = 10, delayMs = 3_000 }) {
  const expected = String(expectedSha256 || "").toLowerCase();
  if (!expected) return artifactUrl;
  let lastError = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const verifiedUrl = withCacheBuster(artifactUrl, {
      lily_sha: expected.slice(0, 16),
      lily_attempt: attempt,
      lily_ts: Date.now(),
    });
    try {
      const remote = await fetchRemoteSha256(verifiedUrl);
      if (remote.sha256 === expected) {
        if (attempt > 1) {
          console.log(`[publish-local-catalog] remote artifact verified after ${attempt} attempts: ${artifactUrl}`);
        }
        return verifiedUrl;
      }
      lastError = new Error(`remote checksum mismatch: expected ${expected}, got ${remote.sha256}`);
    } catch (error) {
      lastError = error;
    }
    if (attempt < maxAttempts) {
      console.log(
        `[publish-local-catalog] waiting for remote artifact consistency (${attempt}/${maxAttempts}): ${lastError?.message || "unknown"}`,
      );
      await wait(delayMs);
    }
  }
  throw new Error(`remote artifact did not match expected checksum: ${artifactUrl}; ${lastError?.message || "unknown"}`);
}

async function postJson(api, auth, route, body) {
  const maxAttempts = 3;
  let lastError = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const response = await fetch(`${api}${route}`, {
        method: "POST",
        headers: {
          ...authHeaders(auth),
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        const detail = await response.text().catch(() => "");
        const error = new Error(`POST ${route} failed: HTTP ${response.status}${detail ? ` ${detail}` : ""}`);
        error.status = response.status;
        throw error;
      }
      return response.json();
    } catch (error) {
      lastError = error;
      if (error?.status && error.status < 500) throw error;
      if (attempt === maxAttempts) break;
      await wait(1_000 * attempt);
    }
  }
  throw lastError;
}

async function uploadMultipart(api, auth, route, fields, filePath) {
  const buffer = fs.readFileSync(filePath);
  const maxAttempts = 5;
  const timeoutMs = 180_000;
  let lastError = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const form = new FormData();
    for (const [key, value] of Object.entries(fields)) {
      if (value !== undefined && value !== null && value !== "") form.set(key, String(value));
    }
    form.set("artifact", new Blob([buffer], { type: "application/zip" }), path.basename(filePath));
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(`${api}${route}`, {
        method: "POST",
        headers: authHeaders(auth),
        body: form,
        signal: controller.signal,
      });
      if (!response.ok) {
        const body = await response.text().catch(() => "");
        const error = new Error(`POST ${route} failed: HTTP ${response.status}${body ? ` ${body}` : ""}`);
        error.status = response.status;
        throw error;
      }
      return response.json();
    } catch (error) {
      lastError = error;
      if (error?.status && error.status < 500) throw error;
      if (attempt === maxAttempts) break;
      console.log(
        `[publish-local-catalog] upload retry ${attempt}/${maxAttempts}: ${route} ${path.basename(filePath)} (${error?.message || "unknown"})`,
      );
      await wait(2_000 * attempt);
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError;
}

async function publishSkills(options, auth) {
  const api = normalizeBaseUrl(options.api);
  const existingRows = options.upload && !options.dryRun
    ? (await fetchJson(api, auth, "/api/admin/skill-packages")).skillPackages
    : [];
  const existing = options.upload && !options.dryRun
    ? existingByKey(existingRows, "skill_id", options.channel)
    : new Map();
  const existingLatest = options.upload && !options.dryRun
    ? latestExistingById(existingRows, "skill_id", options.channel)
    : new Map();
  const results = [];
  const localSkillIds = new Set();
  const only = options.only instanceof Set && options.only.size ? options.only : null;
  for (const skillDir of localSkillDirs()) {
    // --only <skillId>: publish just the named skill(s), skipping the rest (and
    // the metadata sync below). Lets us ship one small skill reliably without
    // re-uploading every large pack over a flaky link.
    if (only && !only.has(path.basename(skillDir))) continue;
    const pack = buildJson(process.execPath, [
      "scripts/build-skill-pack.mjs",
      "--skill",
      path.relative(ROOT, skillDir),
      "--out",
      DEFAULT_SKILL_OUT,
    ]);
    localSkillIds.add(pack.skillId);
    const current = existing.get(`${pack.skillId}@${pack.version}`);
    if (!options.force && current?.sha256?.toLowerCase() === pack.sha256.toLowerCase()) {
      console.log(`[publish-local-catalog] skill unchanged: ${pack.skillId}@${pack.version}`);
      results.push({ kind: "skill", id: pack.skillId, version: pack.version, action: "skipped" });
      continue;
    }
    const fields = skillUploadFields({ pack, skillDir, channel: options.channel });
    if (!options.upload || options.dryRun) {
      console.log(`[publish-local-catalog] skill ready: ${pack.skillId}@${pack.version}`);
      results.push({ kind: "skill", id: pack.skillId, version: pack.version, action: "built" });
      continue;
    }
    const artifactSize = fs.statSync(pack.artifactPath).size;
    let uploaded;
    if (qshellAvailable()) {
      const objectKey = skillArtifactObjectKey({
        skillId: pack.skillId,
        version: pack.version,
        sha256: pack.sha256,
        filePath: pack.artifactPath,
      });
      uploadQiniuWithQshell({
        bucket: options.bucket,
        objectKey,
        filePath: pack.artifactPath,
        upHost: options.qiniuUpHost,
      });
      const artifactUrl = joinPublicUrl(options.domain, objectKey);
      const verifiedArtifactUrl = await waitForRemoteArtifactSha({
        artifactUrl,
        expectedSha256: pack.sha256,
      });
      uploaded = await postJson(api, auth, "/api/admin/skill-packages", {
        ...fields,
        artifactUrl: verifiedArtifactUrl,
        sha256: pack.sha256,
        sizeBytes: artifactSize,
        enabled: true,
      });
    } else {
      uploaded = await uploadMultipart(
        api,
        auth,
        "/api/admin/skill-packages/upload",
        fields,
        pack.artifactPath,
      );
    }
    console.log(`[publish-local-catalog] skill uploaded: ${uploaded.skillId}@${pack.version}`);
    results.push({ kind: "skill", id: pack.skillId, version: pack.version, action: "uploaded" });
  }
  for (const entry of registryEntries()) {
    if (only) break; // --only: don't touch other skills' metadata
    if (!entry?.id || localSkillIds.has(entry.id)) continue;
    const current = existing.get(`${entry.id}@${entry.latestVersion}`) || existingLatest.get(entry.id);
    if (!current) {
      console.log(`[publish-local-catalog] skill metadata skipped, no server artifact: ${entry.id}`);
      results.push({ kind: "skill-metadata", id: entry.id, version: entry.latestVersion || "", action: "skipped-missing-artifact" });
      continue;
    }
    const fields = registryMetadataUploadFields({ entry, existing: current, channel: options.channel });
    if (!options.upload || options.dryRun) {
      console.log(`[publish-local-catalog] skill metadata ready: ${entry.id}@${fields.version}`);
      results.push({ kind: "skill-metadata", id: entry.id, version: fields.version, action: "metadata-built" });
      continue;
    }
    await postJson(api, auth, "/api/admin/skill-packages", fields);
    console.log(`[publish-local-catalog] skill metadata synced: ${entry.id}@${fields.version}`);
    results.push({ kind: "skill-metadata", id: entry.id, version: fields.version, action: "metadata-synced" });
  }
  return results;
}

async function publishApps(options, auth) {
  const api = normalizeBaseUrl(options.api);
  const existing = options.upload && !options.dryRun
    ? existingByKey((await fetchJson(api, auth, "/api/admin/workspace-apps")).workspaceApps, "app_id", options.channel)
    : new Map();
  const results = [];
  const apps = options.appId
    ? WORKSPACE_APP_BUILDERS.filter((item) => item.appId === options.appId)
    : WORKSPACE_APP_BUILDERS;
  if (options.appId && apps.length === 0) {
    throw new Error(`unknown workspace app: ${options.appId}`);
  }
  for (const app of apps) {
    if (app.optionalSourceDir && !fs.existsSync(path.join(ROOT, app.optionalSourceDir))) {
      console.log(`[publish-local-catalog] app source missing, skipped: ${app.appId}`);
      results.push({ kind: "app", id: app.appId, version: "", action: "skipped-source-missing" });
      continue;
    }
    const args = workspaceAppBuildArgs(app, options);
    const artifact = buildJson(process.execPath, args);
    const current = existing.get(`${artifact.appId}@${artifact.version}`);
    if (!options.force && current?.sha256?.toLowerCase() === artifact.sha256.toLowerCase()) {
      console.log(`[publish-local-catalog] app unchanged: ${artifact.appId}@${artifact.version}`);
      results.push({ kind: "app", id: artifact.appId, version: artifact.version, action: "skipped" });
      continue;
    }
    const fields = appUploadFields({ app, artifact, channel: options.channel });
    const artifactPath = workspaceAppArtifactPath(artifact);
    if (!artifactPath) {
      throw new Error(
        `workspace app builder ${app.script} did not return an artifact path; expected one of path, artifactPath, packagePath, filePath, outputPath, zipPath`,
      );
    }
    if (!options.upload || options.dryRun) {
      console.log(`[publish-local-catalog] app ready: ${artifact.appId}@${artifact.version}`);
      results.push({ kind: "app", id: artifact.appId, version: artifact.version, action: "built" });
      continue;
    }
    const artifactSize = fs.statSync(artifactPath).size;
    let uploaded;
    if (artifactSize >= DIRECT_APP_UPLOAD_THRESHOLD_BYTES && qshellAvailable()) {
      const objectKey = workspaceAppObjectKey({
        appId: artifact.appId || app.appId,
        version: artifact.version,
        filePath: artifactPath,
      });
      uploadQiniuWithQshell({
        bucket: options.bucket,
        objectKey,
        filePath: artifactPath,
        upHost: options.qiniuUpHost,
      });
      const artifactUrl = joinPublicUrl(options.domain, objectKey);
      const verifiedArtifactUrl = await waitForRemoteArtifactSha({
        artifactUrl,
        expectedSha256: artifact.sha256 || "",
      });
      uploaded = await postJson(api, auth, "/api/admin/workspace-apps", {
        ...fields,
        artifactUrl: verifiedArtifactUrl,
        sha256: artifact.sha256 || "",
        sizeBytes: artifactSize,
        enabled: true,
      });
    } else {
      uploaded = await uploadMultipart(api, auth, "/api/admin/workspace-apps/upload", fields, artifactPath);
    }
    console.log(`[publish-local-catalog] app uploaded: ${uploaded.appId}@${artifact.version}`);
    results.push({ kind: "app", id: artifact.appId, version: artifact.version, action: "uploaded" });
  }
  return results;
}

export {
  WORKSPACE_APP_BUILDERS,
  appUploadFields,
  extendedDescription,
  localSkillDirs,
  registryMetadataUploadFields,
  resolveWorkspaceAppVersion,
  skillArtifactObjectKey,
  skillUploadFields,
  skillManifestVersion,
  waitForRemoteArtifactSha,
  withCacheBuster,
  workspaceAppBuildArgs,
  workspaceAppArtifactPath,
};

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const api = normalizeBaseUrl(options.api);
  const auth = options.upload && !options.dryRun ? await login(api) : null;
  const results = [];
  if (options.skills) results.push(...(await publishSkills(options, auth)));
  if (options.apps) results.push(...(await publishApps(options, auth)));
  const summary = results.reduce((acc, item) => {
    acc[item.action] = (acc[item.action] || 0) + 1;
    return acc;
  }, {});
  console.log(`[publish-local-catalog] done ${JSON.stringify(summary)}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error?.stack || error?.message || String(error));
    process.exit(1);
  });
}
