/**
 * Enterprise identity — what the account page and a failed chat turn SAY.
 *
 * Pure: every function takes `t` (and a locale) so it runs in node tests. The
 * rules about which organization is usable live in the main process
 * (src/main/organization-identity.js); rows arrive already carrying
 * `unusableCode`, and this module only turns facts into words.
 */

/** Failure codes after which "switch to personal" is a real way forward. */
export const ORG_SWITCHABLE_FAILURE_CODES = Object.freeze([
  "ORG_NOT_FOUND",
  "ORG_SUSPENDED",
  "ORG_DISABLED",
  "ORG_MEMBER_REQUIRED",
  "ORG_MEMBER_DISABLED",
  "ORG_MEMBER_WEEKLY_LIMIT",
  "ORG_POOL_INSUFFICIENT",
  "ORG_MEMBER_QUOTA_EXCEEDED",
]);

/** The failure code a committed/failed message carries, whatever layer wrote it. */
export function messageFailureCode(message = {}) {
  const candidates = [
    message?.record?.failure?.errorCode,
    message?.record?.failureCode,
    message?.errorCode,
    message?.meta?.errorCode,
    message?.meta?.failureCode,
  ];
  for (const value of candidates) if (typeof value === "string" && value.trim()) return value.trim();
  return "";
}

export function shouldOfferPersonalSwitch(message = {}) {
  return Boolean(message?.failed) && ORG_SWITCHABLE_FAILURE_CODES.includes(messageFailureCode(message));
}

/** Option text: the name, plus why it cannot be used when it cannot. */
export function organizationOptionLabel(row = {}, t) {
  const name = String(row?.name || row?.id || "");
  const code = String(row?.unusableCode || "");
  return code ? `${name} (${t(`orgIdentity.label.${code}`)})` : name;
}

/**
 * An unusable organization cannot be picked — except the one already selected,
 * which stays shown (disabled options still display as the current value) so
 * the user sees WHAT is wrong instead of a silent jump to personal.
 */
export function organizationOptionDisabled(row = {}) {
  return Boolean(row?.unusableCode);
}

function formatTime(iso, locale, now = Date.now()) {
  const ms = Date.parse(String(iso || ""));
  if (!Number.isFinite(ms) || ms <= now) return "";
  try {
    return new Intl.DateTimeFormat(locale || undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(ms));
  } catch {
    return new Date(ms).toISOString();
  }
}

function formatUnits(value, locale) {
  const n = Number(value || 0);
  try {
    return new Intl.NumberFormat(locale || undefined).format(n);
  } catch {
    return String(n);
  }
}

/** "This week: used / budget · resets …" for the selected org; "" when there is no budget. */
export function organizationWeeklyText(me, t, locale, now = Date.now()) {
  if (!me || typeof me !== "object" || me.ok === false) return "";
  if (me.weeklyBudget === null || me.weeklyBudget === undefined) return "";
  const time = formatTime(me.resetsAt, locale, now);
  if (me.limited) return time ? t("orgIdentity.weeklyLimited", { time }) : t("orgIdentity.weeklyLimitedNoReset");
  const params = { used: formatUnits(me.weeklyUsed, locale), budget: formatUnits(me.weeklyBudget, locale), time };
  return time ? t("orgIdentity.weekly", params) : t("orgIdentity.weeklyNoReset", params);
}

/**
 * What the account page says about the selection after a refresh.
 * @returns {{ text: string, kind: "" | "warning" | "info", offerSwitch: boolean }}
 */
export function organizationSelectionNotice(result = {}, rows = [], t) {
  const selection = result?.selection || {};
  if (selection.action === "clear") {
    const name = selection.organizationName || t("orgIdentity.unknownOrg");
    return { text: t("orgIdentity.clearedGone", { name }), kind: "info", offerSwitch: false };
  }
  if (selection.action === "flag" && selection.code) {
    const row = (Array.isArray(rows) ? rows : []).find((item) => String(item?.id || "") === selection.organizationId);
    const name = row?.name || selection.organizationId || t("orgIdentity.unknownOrg");
    return { text: t(`orgIdentity.unusable.${selection.code}`, { name }), kind: "warning", offerSwitch: true };
  }
  return { text: "", kind: "", offerSwitch: false };
}

/**
 * The toast after an identity switch, told from what the main process
 * ACTUALLY saved — a failed or ignored call must never read as "switched".
 * @returns {{ ok: boolean, text: string, kind: "success" | "error" }}
 */
export function organizationSwitchOutcome(result, requestedId, t, error = null) {
  const wanted = String(requestedId || "").trim();
  const saved = typeof result?.organizationId === "string" ? result.organizationId.trim() : null;
  const ok = !error && result?.ok === true && saved === wanted;
  if (!ok) return { ok: false, text: t("orgIdentity.switchFailed"), kind: "error" };
  return { ok: true, text: wanted ? t("settings.accountOrgSet") : t("orgIdentity.switchedPersonal"), kind: "success" };
}
