// What a config rule sends, in words: the rules list shows these lines instead
// of the rule's JSON. Pure, so the render gate and a unit check can hold it.
//
// Every top-level key the rule carries yields a line; a key this file does not
// know still shows (by its own name), so a new config area is never silently
// invisible in the list.

const COPY = {
  zh: {
    models: "对话模型", defaultModel: "默认 {name}", media: "图片 / 视频 / 语音", image: "图片", video: "视频", speech: "语音",
    skills: "预装技能", skillsCount: "{count} 个", registry: "技能商店地址", permission: "权限", permissionDefault: "默认",
    minVersion: "最低版本", update: "强制更新", updateValue: "倒计时 {countdown} 秒，最多推迟 {defers} 次", channel: "更新渠道",
    vision: "识图模型", timeout: "请求超时", timeoutValue: "{seconds} 秒", env: "运行设置", envCount: "{count} 项",
    collaboration: "协作功能", characterWorlds: "角色世界", on: "开", off: "关", agents: "智能体",
    collab: { enabled: "总开关", tasks: "远程任务", workspaceShares: "工作区共享", realtime: "实时协作", attachments: "附件", aiTools: "AI 工具" },
    minClient: "（需 {version} 及以上）", andMore: "等 {count} 个", empty: "（空规则，不改任何设置）",
  },
  en: {
    models: "Chat models", defaultModel: "default {name}", media: "Image / video / speech", image: "image", video: "video", speech: "speech",
    skills: "Preinstalled skills", skillsCount: "{count}", registry: "Skill store address", permission: "Permissions", permissionDefault: "default",
    minVersion: "Minimum version", update: "Mandatory update", updateValue: "{countdown}s countdown, up to {defers} postponements", channel: "Update channel",
    vision: "Image-reading model", timeout: "Request timeout", timeoutValue: "{seconds}s", env: "Runtime settings", envCount: "{count}",
    collaboration: "Collaboration", characterWorlds: "Character worlds", on: "on", off: "off", agents: "Agents",
    collab: { enabled: "master switch", tasks: "remote tasks", workspaceShares: "workspace sharing", realtime: "live collaboration", attachments: "attachments", aiTools: "AI tools" },
    minClient: " (needs {version}+)", andMore: "and {rest} more", empty: "(empty rule — changes nothing)",
  },
};

const DEFAULT_REGISTRY = "/api/skills/registry";
const fill = (text, values) => text.replace(/\{(\w+)\}/g, (_, key) => String(values[key] ?? ""));

export function ruleCopy(locale) {
  return COPY[locale] || (String(locale).startsWith("zh") ? COPY.zh : COPY.en);
}

function parse(config) {
  if (config && typeof config === "object") return config;
  try {
    const value = JSON.parse(config);
    return value && typeof value === "object" ? value : null;
  } catch {
    return null;
  }
}

/**
 * @param {unknown} config the rule's config (object or JSON text)
 * @param {{locale?: string, providerName?: (id: string) => string, mediaName?: (id: string) => string}} [options]
 * @returns {Array<{label: string, value: string}>}
 */
export function summarizeRuleConfig(config, { locale = "zh", providerName = (id) => id, mediaName = (id) => id } = {}) {
  const c = ruleCopy(locale);
  const value = parse(config);
  if (!value) return [];
  const sep = locale === "zh" ? "、" : ", ";
  const lines = [];
  const push = (label, text) => { if (text) lines.push({ label, value: text }); };

  for (const [key, section] of Object.entries(value)) {
    if (key === "schemaVersion") continue;
    if (key === "models") {
      const ids = Array.isArray(section?.providers) ? section.providers : [];
      const names = ids.length ? ids.map(providerName) : (Array.isArray(section?.catalog) ? section.catalog.map((p) => p?.label || p?.id).filter(Boolean) : []);
      const active = section?.activeProvider ? fill(c.defaultModel, { name: providerName(section.activeProvider) }) : "";
      const shown = names.length > 6 ? `${names.slice(0, 6).join(sep)} ${fill(c.andMore, { count: names.length, rest: names.length - 6 })}` : names.join(sep);
      push(c.models, [shown, names.length > 1 ? active : ""].filter(Boolean).join(locale === "zh" ? "，" : "; "));
    } else if (key === "media") {
      const parts = ["image", "video", "speech"].filter((kind) => section?.[kind]).map((kind) => {
        const ids = Array.isArray(section[kind].providers) ? section[kind].providers : [section[kind].default].filter(Boolean);
        return `${c[kind]}${locale === "zh" ? "：" : ": "}${ids.map(mediaName).join(sep)}`;
      });
      push(c.media, parts.join(locale === "zh" ? "；" : "; "));
    } else if (key === "tools") {
      const ids = Array.isArray(section?.enabledPluginIds) ? section.enabledPluginIds : [];
      if (ids.length) push(c.skills, fill(c.skillsCount, { count: ids.length }));
      if (section?.pluginRegistryUrl && section.pluginRegistryUrl !== DEFAULT_REGISTRY) push(c.registry, section.pluginRegistryUrl);
    } else if (key === "policy") {
      if (section?.permissionMode) push(c.permission, section.permissionMode === "default" ? c.permissionDefault : section.permissionMode);
      if (section?.minAppVersion) push(c.minVersion, section.minAppVersion);
      if (section?.updateChannel) push(c.channel, section.updateChannel);
      const u = section?.update;
      if (u && typeof u === "object") push(c.update, fill(c.updateValue, { countdown: u.countdownSeconds ?? "-", defers: u.maxDeferrals ?? "-" }));
    } else if (key === "runtime") {
      const env = section?.env && typeof section.env === "object" ? section.env : {};
      if (env.VISION_MODEL) push(c.vision, env.VISION_MODEL);
      if (env.API_TIMEOUT_MS) push(c.timeout, fill(c.timeoutValue, { seconds: Math.round(Number(env.API_TIMEOUT_MS) / 1000) }));
      const rest = Object.keys(env).filter((name) => name !== "VISION_MODEL" && name !== "API_TIMEOUT_MS");
      if (rest.length) push(c.env, fill(c.envCount, { count: rest.length }));
    } else if (key === "collaboration") {
      const parts = Object.entries(section || {})
        .filter(([name, flag]) => typeof flag === "boolean" && c.collab[name])
        .map(([name, flag]) => `${c.collab[name]} ${flag ? c.on : c.off}`);
      push(c.collaboration, parts.join(" · "));
    } else if (key === "characterWorlds") {
      const version = section?.minimumClientVersion ? fill(c.minClient, { version: section.minimumClientVersion }) : "";
      push(c.characterWorlds, `${section?.enabled ? c.on : c.off}${version}`);
    } else if (key === "agents") {
      const ids = Array.isArray(section?.available) ? section.available.filter(Boolean) : [];
      push(c.agents, ids.length ? fill(c.skillsCount, { count: ids.length }) : "");
    } else {
      push(key, typeof section === "object" ? JSON.stringify(section).slice(0, 80) : String(section));
    }
  }
  return lines.length ? lines : [{ label: "", value: c.empty }];
}

/** Who a rule reaches, in words ("授权：某客户", "所有设备"); copy is t.admin.configRules. */
export function ruleAudience(rule, copy) {
  const scope = copy.scope[rule.scope] || rule.scope;
  if (rule.scope === "global") return scope;
  const target = rule.target_name || (rule.target_id ? String(rule.target_id) : copy.unnamed);
  return `${scope}${copy.colon}${target}`;
}
