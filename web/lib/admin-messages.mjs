import { getLocale } from "./i18n.mjs";

/**
 * Operator-facing messages from admin write actions.
 *
 * They were 28 English string literals inside actions.js, in a console that
 * ships in three languages: a Chinese operator saved a config rule and was
 * answered in English. Keeping them here makes the set enumerable — a gate can
 * check that every key is translated, which it cannot do for a literal.
 *
 * Arabic inherits English exactly as the rest of the admin dictionary does
 * today; that is the console's existing state, not a new gap.
 */
const MESSAGES = {
  licenseInvalidExpiry: {
    zh: "到期日期不正确。",
    en: "Invalid expiration date.",
  },
  licenseCreated: {
    zh: "授权已创建。请立刻复制，明文密钥只显示这一次。",
    en: "License created. Copy it now; the plain key is shown only once.",
  },
  licenseFailed: { zh: "创建授权失败。", en: "Failed to create license." },
  releaseCreated: { zh: "发布记录 {id} 已创建。", en: "Release {id} created." },
  releaseFailed: { zh: "创建发布记录失败。", en: "Failed to create release." },
  skillUploaded: { zh: "技能包 {id} 已上传。", en: "Skill package {id} uploaded." },
  skillFailed: { zh: "上传技能包失败。", en: "Failed to upload skill package." },
  appUploaded: { zh: "工作区应用 {id} 已上传。", en: "Workspace app {id} uploaded." },
  appFailed: { zh: "上传工作区应用失败。", en: "Failed to upload workspace app." },
  configNotObject: { zh: "配置必须是一个 JSON 对象。", en: "Config must be a JSON object." },
  configProfileSaved: { zh: "下发规则 {id} 已保存。", en: "Config profile {id} saved." },
  configProfileFailed: { zh: "保存下发规则失败。", en: "Failed to save config profile." },
  providerSaved: { zh: "模型供应商 {id} 已保存。", en: "Provider {id} saved." },
  providerFailed: { zh: "保存模型供应商失败。", en: "Failed to save provider." },
  groupSaved: { zh: "设备组 {id} 已保存。", en: "Group {id} saved." },
  groupFailed: { zh: "保存设备组失败。", en: "Failed to save group." },
  membershipUpdated: { zh: "归属已更新。", en: "Membership updated." },
  membershipFailed: { zh: "更新归属失败。", en: "Failed to update membership." },
  agentDefinitionRequired: { zh: "需要填写智能体定义 JSON。", en: "Definition JSON is required." },
  agentSaved: { zh: "智能体 {id} 已{action}。", en: "Agent package {id} {action}." },
  agentFailed: { zh: "保存智能体失败。", en: "Failed to save agent package." },
  wishUpdated: { zh: "愿望已更新。", en: "Wish updated." },
  wishFailed: { zh: "更新愿望失败。", en: "Failed to update wish." },
  wishMerged: { zh: "愿望已合并。", en: "Wish merged." },
  wishMergeFailed: { zh: "合并愿望失败。", en: "Failed to merge wish." },
  loginMissingCredentials: { zh: "请填写邮箱和密码。", en: "Email and password are required." },
  loginRejected: { zh: "登录失败，请检查邮箱和密码。", en: "Login failed. Check the email and password." },
  loginNoSession: { zh: "登录成功，但服务端没有返回管理会话。", en: "Login succeeded but no admin session was returned." },
};

export const ADMIN_MESSAGE_KEYS = Object.keys(MESSAGES);

export function formatAdminMessage(key, locale = "en", params = {}) {
  const entry = MESSAGES[key];
  if (!entry) return key;
  const text = entry[locale] || entry.en;
  return text.replace(/\{(\w+)\}/g, (_, name) => String(params[name] ?? ""));
}

/** The operator's own language, resolved from their cookie. */
export async function adminMessage(key, params = {}) {
  const locale = await getLocale();
  return formatAdminMessage(key, locale, params);
}

export { MESSAGES as ADMIN_MESSAGES };
