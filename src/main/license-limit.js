"use strict";

/**
 * Licence-code (授权码) refusals from the model gateway, as chat sentences.
 *
 * A licensed device spends its licence's weekly credit pool first. When that
 * pool is used up and no account is signed in, the gateway answers
 * 402 payment_required with LICENSE_WEEKLY_LIMIT (+ resetsAt); a lapsed or
 * disabled licence answers LICENSE_UNAVAILABLE. With a signed-in account the
 * account's own credits pay instead, so neither code reaches the user then.
 *
 * Same shape as the ORG_* entries in organization-identity.js: exact codes,
 * classified ahead of the generic QUOTA_EXCEEDED ("top up your account" is the
 * wrong advice for a licence), non-retryable (the same request is refused the
 * same way until the reset or an admin acts).
 */

const { formatResetTime, resetsAtFromRaw } = require("./organization-identity");

const LICENSE_LIMIT_CODES = Object.freeze(["LICENSE_WEEKLY_LIMIT", "LICENSE_UNAVAILABLE"]);

/** LICENSE_WEEKLY_LIMIT takes {time}; its _NO_TIME twin is used when the reset time is unknown or past. */
const LICENSE_FAILURE_COPY = Object.freeze({
  "zh-CN": Object.freeze({
    LICENSE_WEEKLY_LIMIT: "本授权码本周积分已用完，{time} 重置；登录账号后可用个人积分继续（设置 → 账户）。",
    LICENSE_WEEKLY_LIMIT_NO_TIME: "本授权码本周积分已用完，本周期结束后自动重置；登录账号后可用个人积分继续（设置 → 账户）。",
    LICENSE_UNAVAILABLE: "本设备使用的授权码已过期或已被停用，本次请求没有发出。请联系管理员续期或恢复授权；也可以登录账号，使用个人积分继续（设置 → 账户）。",
  }),
  en: Object.freeze({
    LICENSE_WEEKLY_LIMIT: "This licence code has used up this week's credits. It resets at {time}. Sign in to your account to keep working with your personal credits (Settings → Account).",
    LICENSE_WEEKLY_LIMIT_NO_TIME: "This licence code has used up this week's credits; it resets when the current weekly window ends. Sign in to your account to keep working with your personal credits (Settings → Account).",
    LICENSE_UNAVAILABLE: "The licence code on this device has expired or been disabled, so this request was not sent. Ask your administrator to renew or re-enable it, or sign in to your account to keep working with your personal credits (Settings → Account).",
  }),
  ar: Object.freeze({
    LICENSE_WEEKLY_LIMIT: "استنفد رمز الترخيص هذا نقاط هذا الأسبوع، وستُعاد في {time}. سجّل الدخول إلى حسابك لمتابعة العمل بنقاطك الشخصية (الإعدادات ← الحساب).",
    LICENSE_WEEKLY_LIMIT_NO_TIME: "استنفد رمز الترخيص هذا نقاط هذا الأسبوع، وستُعاد عند انتهاء الفترة الأسبوعية الحالية. سجّل الدخول إلى حسابك لمتابعة العمل بنقاطك الشخصية (الإعدادات ← الحساب).",
    LICENSE_UNAVAILABLE: "انتهت صلاحية رمز الترخيص على هذا الجهاز أو تم تعطيله، لذلك لم يُرسَل هذا الطلب. اطلب من المسؤول تجديده أو إعادة تفعيله، أو سجّل الدخول إلى حسابك لمتابعة العمل بنقاطك الشخصية (الإعدادات ← الحساب).",
  }),
});

function copyLocale(locale) {
  const value = String(locale || "");
  if (value.startsWith("zh")) return "zh-CN";
  if (value.startsWith("ar")) return "ar";
  return "en";
}

function isLicenseLimitCode(code) {
  return LICENSE_LIMIT_CODES.includes(String(code || ""));
}

/**
 * The chat-facing sentence for a licence refusal.
 * @param {string} code one of LICENSE_LIMIT_CODES
 * @param {{ locale?: string, resetsAt?: string, now?: number }} options
 */
function licenseFailureMessage(code, { locale, resetsAt = "", now = Date.now() } = {}) {
  if (!isLicenseLimitCode(code)) return "";
  const copy = LICENSE_FAILURE_COPY[copyLocale(locale)];
  if (code === "LICENSE_WEEKLY_LIMIT") {
    const time = formatResetTime(resetsAt, locale || "zh-CN", now);
    return time ? copy.LICENSE_WEEKLY_LIMIT.replace("{time}", time) : copy.LICENSE_WEEKLY_LIMIT_NO_TIME;
  }
  return copy[code];
}

function currentLocale() {
  try {
    return require("./locale-settings").getLocale() || "zh-CN";
  } catch {
    return "zh-CN";
  }
}

function codePattern(code) {
  return new RegExp(`(?:^|[^A-Z0-9_])${code}(?![A-Z0-9_])`);
}

/** Error-classifier entries (agent-runner ERROR_PATTERNS). */
const LICENSE_LIMIT_ERROR_PATTERNS = Object.freeze(LICENSE_LIMIT_CODES.map((code) => Object.freeze({
  code,
  category: "account",
  test: codePattern(code),
  message: licenseFailureMessage(code, { locale: "en" }),
  describe: (raw) => licenseFailureMessage(code, {
    locale: currentLocale(),
    resetsAt: code === "LICENSE_WEEKLY_LIMIT" ? resetsAtFromRaw(raw) : "",
  }),
  retryable: false,
})));

module.exports = {
  LICENSE_FAILURE_COPY,
  LICENSE_LIMIT_CODES,
  LICENSE_LIMIT_ERROR_PATTERNS,
  isLicenseLimitCode,
  licenseFailureMessage,
};
