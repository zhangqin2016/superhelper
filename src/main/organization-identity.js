"use strict";

/**
 * Enterprise identity on the desktop client — the pure rules.
 *
 * The identity the user picks decides who pays: with an organization selected
 * ONLY that organization's pool is charged, without one ONLY the personal
 * balance. There is no silent billing fallback in either direction, so the
 * client never quietly swaps identity when an organization stops working; it
 * clears the selection only when the organization is GONE for this user (not
 * in the list any more) and says so, and otherwise keeps the selection visible,
 * marked unusable, with a one-click way back to personal.
 *
 * The header that carries the selection is still injected in exactly one place
 * (runtime/opencode-model-config.js via account-manager.getCurrentOrganizationId);
 * nothing here decides the organization for a request.
 */

/** 403 org_forbidden codes. */
const ORG_FORBIDDEN_CODES = Object.freeze([
  "ORG_NOT_FOUND",
  "ORG_SUSPENDED",
  "ORG_DISABLED",
  "ORG_MEMBER_REQUIRED",
  "ORG_MEMBER_DISABLED",
]);

/** 402 payment_required codes raised under an organization identity. */
const ORG_PAYMENT_CODES = Object.freeze([
  "ORG_MEMBER_WEEKLY_LIMIT",
  "ORG_POOL_INSUFFICIENT",
  "ORG_MEMBER_QUOTA_EXCEEDED",
]);

const ORG_IDENTITY_CODES = Object.freeze([...ORG_FORBIDDEN_CODES, ...ORG_PAYMENT_CODES]);
const ORG_IDENTITY_CODE_SET = new Set(ORG_IDENTITY_CODES);
const SUPPORTED_LOCALES = ["zh-CN", "en", "ar"];

function isOrgIdentityCode(code) {
  return ORG_IDENTITY_CODE_SET.has(String(code || ""));
}

/**
 * Why this organization row cannot be used right now, or "" when it can.
 * Mirrors the server's orgUnavailableCode (platform freeze named first, it is
 * the one the enterprise cannot lift) plus the membership state. A row from an
 * older server that carries no status fields is usable — unknown is not a
 * reason to block.
 */
function organizationUnusableCode(row = {}) {
  if (!row || typeof row !== "object") return "";
  if (row.platform_status === "suspended") return "ORG_SUSPENDED";
  if (row.owner_status === "disabled") return "ORG_DISABLED";
  if (typeof row.status === "string" && row.status && row.status !== "active") return "ORG_DISABLED";
  if (typeof row.membership_status === "string" && row.membership_status && row.membership_status !== "active") {
    return "ORG_MEMBER_DISABLED";
  }
  return "";
}

/**
 * What a successful organization-list refresh means for the saved selection.
 *
 *   none  — personal identity, nothing to decide
 *   keep  — the selected organization is listed and usable
 *   flag  — listed but unusable (frozen / paused / membership disabled): keep
 *           it selected and visible, marked, with a switch-to-personal action
 *   clear — no longer listed (removed, left, deleted): the selection is gone
 *
 * Only call this with a list the server actually returned; a failed refresh
 * proves nothing and must not clear anything.
 */
function organizationSelectionDecision({ currentId = "", organizations = [] } = {}) {
  const id = String(currentId || "").trim();
  if (!id) return { action: "none", organizationId: "", code: "" };
  const rows = Array.isArray(organizations) ? organizations : [];
  const row = rows.find((item) => String(item?.id || "") === id);
  if (!row) return { action: "clear", organizationId: id, code: "ORG_MEMBER_REQUIRED" };
  const code = organizationUnusableCode(row);
  if (code) return { action: "flag", organizationId: id, code };
  return { action: "keep", organizationId: id, code: "" };
}

function normalizeLocale(locale) {
  const value = String(locale || "");
  if (SUPPORTED_LOCALES.includes(value)) return value;
  if (value.startsWith("zh")) return "zh-CN";
  if (value.startsWith("ar")) return "ar";
  return "en";
}

/**
 * Chat-facing copy per locale. It lives here, not in the renderer's locale
 * files, because the main process may not import renderer modules
 * (architecture-boundaries) and the sentence is written when the turn fails.
 * ORG_MEMBER_WEEKLY_LIMIT takes {time}; its _NO_TIME twin is used when the
 * reset time is unknown or already past.
 */
const ORG_FAILURE_COPY = Object.freeze({
  "zh-CN": Object.freeze({
    ORG_NOT_FOUND: "你当前使用的企业身份已不存在，本次请求没有发出。请在「设置 → 账户」切换为个人身份（使用个人余额）或选择其他企业后再发送。",
    ORG_MEMBER_REQUIRED: "你已不是当前所用企业的成员（已被移出或已退出），本次请求没有发出。请切换为个人身份（使用个人余额）或选择其他企业后再发送。",
    ORG_SUSPENDED: "当前所用企业已被平台冻结，暂时无法使用企业积分。请联系企业管理员与平台沟通处理；如需立即继续，可切换为个人身份（使用个人余额）。",
    ORG_DISABLED: "当前所用企业已被企业管理员暂停使用，暂时无法使用企业积分。请联系企业管理员恢复；如需立即继续，可切换为个人身份（使用个人余额）。",
    ORG_MEMBER_DISABLED: "你在当前所用企业中的成员身份已被停用。请联系企业管理员恢复；如需立即继续，可切换为个人身份（使用个人余额）。",
    ORG_MEMBER_WEEKLY_LIMIT: "你在本企业的本周积分额度已用完，将于 {time} 重置。可以等待重置、请企业管理员调整你的额度，或切换为个人身份（使用个人余额）继续。",
    ORG_MEMBER_WEEKLY_LIMIT_NO_TIME: "你在本企业的本周积分额度已用完，本周期结束后会自动重置。可以等待重置、请企业管理员调整你的额度，或切换为个人身份（使用个人余额）继续。",
    ORG_POOL_INSUFFICIENT: "企业的共享积分已用完，本次请求没有执行。请联系企业管理员为企业充值；如需立即继续，可切换为个人身份（使用个人余额）。",
    ORG_MEMBER_QUOTA_EXCEEDED: "这次请求超过了企业为成员设定的单次用量上限。请缩小任务范围（减少附件、拆分步骤）后再发送，或请企业管理员调高上限。",
  }),
  "en": Object.freeze({
    ORG_NOT_FOUND: "The enterprise you are using no longer exists, so this request was not sent. Switch to your personal identity (billed to your personal balance) or pick another enterprise in Settings → Account, then send again.",
    ORG_MEMBER_REQUIRED: "You are no longer a member of the enterprise you are using (you were removed or left it), so this request was not sent. Switch to your personal identity (billed to your personal balance) or pick another enterprise, then send again.",
    ORG_SUSPENDED: "The enterprise you are using has been frozen by the platform, so its credits can't be used right now. Ask your enterprise admin to contact the platform. To keep working now, switch to your personal identity (billed to your personal balance).",
    ORG_DISABLED: "Your enterprise admin has paused the enterprise you are using, so its credits can't be used right now. Ask your enterprise admin to turn it back on, or switch to your personal identity (billed to your personal balance) to keep working.",
    ORG_MEMBER_DISABLED: "Your membership in the enterprise you are using has been disabled. Ask your enterprise admin to re-enable it, or switch to your personal identity (billed to your personal balance) to keep working.",
    ORG_MEMBER_WEEKLY_LIMIT: "You have used up this week's credit allowance in your enterprise. It resets at {time}. Wait for the reset, ask your enterprise admin to raise your allowance, or switch to your personal identity (billed to your personal balance).",
    ORG_MEMBER_WEEKLY_LIMIT_NO_TIME: "You have used up this week's credit allowance in your enterprise; it resets when the current weekly window ends. Wait for the reset, ask your enterprise admin to raise your allowance, or switch to your personal identity (billed to your personal balance).",
    ORG_POOL_INSUFFICIENT: "Your enterprise's shared credits have run out, so this request was not run. Ask your enterprise admin to top up the enterprise. To keep working now, switch to your personal identity (billed to your personal balance).",
    ORG_MEMBER_QUOTA_EXCEEDED: "This request exceeds the per-request cap your enterprise set for members. Narrow the task (fewer attachments, smaller steps) and send again, or ask your enterprise admin to raise the cap.",
  }),
  "ar": Object.freeze({
    ORG_NOT_FOUND: "المؤسسة التي تستخدمها لم تعد موجودة، لذلك لم يُرسَل هذا الطلب. انتقل إلى هويتك الشخصية (تُخصم من رصيدك الشخصي) أو اختر مؤسسة أخرى من الإعدادات ← الحساب، ثم أرسل مرة أخرى.",
    ORG_MEMBER_REQUIRED: "لم تعد عضوًا في المؤسسة التي تستخدمها (تمت إزالتك أو غادرتها)، لذلك لم يُرسَل هذا الطلب. انتقل إلى هويتك الشخصية (تُخصم من رصيدك الشخصي) أو اختر مؤسسة أخرى، ثم أرسل مرة أخرى.",
    ORG_SUSPENDED: "جمّدت المنصة المؤسسة التي تستخدمها، لذا لا يمكن استخدام نقاطها الآن. اطلب من مسؤول مؤسستك التواصل مع المنصة. للمتابعة الآن، انتقل إلى هويتك الشخصية (تُخصم من رصيدك الشخصي).",
    ORG_DISABLED: "أوقف مسؤول مؤسستك المؤسسة التي تستخدمها مؤقتًا، لذا لا يمكن استخدام نقاطها الآن. اطلب من مسؤول مؤسستك إعادة تشغيلها، أو انتقل إلى هويتك الشخصية (تُخصم من رصيدك الشخصي) للمتابعة.",
    ORG_MEMBER_DISABLED: "تم تعطيل عضويتك في المؤسسة التي تستخدمها. اطلب من مسؤول مؤسستك إعادة تفعيلها، أو انتقل إلى هويتك الشخصية (تُخصم من رصيدك الشخصي) للمتابعة.",
    ORG_MEMBER_WEEKLY_LIMIT: "استنفدت مخصصك الأسبوعي من النقاط في مؤسستك. سيُعاد ضبطه في {time}. انتظر إعادة الضبط، أو اطلب من مسؤول مؤسستك رفع مخصصك، أو انتقل إلى هويتك الشخصية (تُخصم من رصيدك الشخصي).",
    ORG_MEMBER_WEEKLY_LIMIT_NO_TIME: "استنفدت مخصصك الأسبوعي من النقاط في مؤسستك؛ سيُعاد ضبطه عند انتهاء الأسبوع الحالي. انتظر إعادة الضبط، أو اطلب من مسؤول مؤسستك رفع مخصصك، أو انتقل إلى هويتك الشخصية (تُخصم من رصيدك الشخصي).",
    ORG_POOL_INSUFFICIENT: "نفدت النقاط المشتركة لمؤسستك، لذلك لم يُنفَّذ هذا الطلب. اطلب من مسؤول مؤسستك شحن رصيد المؤسسة. للمتابعة الآن، انتقل إلى هويتك الشخصية (تُخصم من رصيدك الشخصي).",
    ORG_MEMBER_QUOTA_EXCEEDED: "يتجاوز هذا الطلب الحد الأقصى لكل طلب الذي حددته مؤسستك للأعضاء. قلّص المهمة (مرفقات أقل، خطوات أصغر) وأرسل مرة أخرى، أو اطلب من مسؤول مؤسستك رفع الحد.",
  }),
});

function fill(template, params = {}) {
  return String(template || "").replace(/\{(\w+)\}/g, (_, key) => (params[key] ?? `{${key}}`));
}

/** A reset time for people: the user's locale, their clock; "" when unknown or already past. */
function formatResetTime(resetsAt, locale, now = Date.now()) {
  const ms = Date.parse(String(resetsAt || ""));
  if (!Number.isFinite(ms) || ms <= now) return "";
  try {
    return new Intl.DateTimeFormat(normalizeLocale(locale), { dateStyle: "medium", timeStyle: "short" }).format(new Date(ms));
  } catch {
    return new Date(ms).toISOString();
  }
}

/** A `resetsAt` ISO time carried in the raw error text, if the engine kept it. */
function resetsAtFromRaw(raw) {
  const match = /resets_?At["'\s:=]+["']?(\d{4}-\d{2}-\d{2}T[\d:.]+(?:Z|[+-]\d{2}:?\d{2})?)/i.exec(String(raw || ""));
  return match ? match[1] : "";
}

/**
 * The chat-facing sentence for an organization-identity refusal.
 * @param {string} code one of ORG_IDENTITY_CODES
 * @param {{ locale?: string, resetsAt?: string, now?: number }} options
 */
function organizationFailureMessage(code, { locale, resetsAt = "", now = Date.now() } = {}) {
  if (!isOrgIdentityCode(code)) return "";
  const copy = ORG_FAILURE_COPY[normalizeLocale(locale)] || ORG_FAILURE_COPY.en;
  if (code === "ORG_MEMBER_WEEKLY_LIMIT") {
    const time = formatResetTime(resetsAt, locale, now);
    return time ? fill(copy.ORG_MEMBER_WEEKLY_LIMIT, { time }) : copy.ORG_MEMBER_WEEKLY_LIMIT_NO_TIME;
  }
  return copy[code] || ORG_FAILURE_COPY.en[code] || "";
}

function currentLocale() {
  try {
    return require("./locale-settings").getLocale() || "zh-CN";
  } catch {
    return "zh-CN";
  }
}

/** Best-known reset time for the member's weekly budget in the current organization. */
function knownWeeklyResetsAt(raw) {
  const fromRaw = resetsAtFromRaw(raw);
  if (fromRaw) return fromRaw;
  try {
    const me = require("./account-manager").getCurrentOrganizationMe();
    return String(me?.resetsAt || "");
  } catch {
    return "";
  }
}

function codePattern(code) {
  return new RegExp(`(?:^|[^A-Z0-9_])${code}(?![A-Z0-9_])`);
}

/**
 * Error-classifier entries (agent-runner ERROR_PATTERNS). Non-retryable: the
 * same request under the same identity is refused the same way, so a blind
 * replay only burns a turn. `describe` renders the sentence at failure time in
 * the user's locale; `message` is the English fallback.
 */
const ORG_IDENTITY_ERROR_PATTERNS = Object.freeze(ORG_IDENTITY_CODES.map((code) => Object.freeze({
  code,
  category: "account",
  test: codePattern(code),
  message: organizationFailureMessage(code, { locale: "en" }) || code,
  describe: (raw) => organizationFailureMessage(code, {
    locale: currentLocale(),
    resetsAt: code === "ORG_MEMBER_WEEKLY_LIMIT" ? knownWeeklyResetsAt(raw) : "",
  }),
  retryable: false,
})));

module.exports = {
  ORG_FAILURE_COPY,
  ORG_FORBIDDEN_CODES,
  ORG_PAYMENT_CODES,
  ORG_IDENTITY_CODES,
  ORG_IDENTITY_ERROR_PATTERNS,
  formatResetTime,
  isOrgIdentityCode,
  organizationFailureMessage,
  organizationSelectionDecision,
  organizationUnusableCode,
  resetsAtFromRaw,
};
