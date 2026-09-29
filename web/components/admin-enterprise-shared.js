import { Badge } from "./ui/badge";

/**
 * What the platform enterprise pages say about an organization, decided once
 * and shared by the list, the detail page and the user page. Pure: no hooks,
 * so server pages and client forms import the same wording.
 */

export function intlLocale(locale) {
  return locale === "zh" ? "zh-CN" : locale === "ar" ? "ar" : "en-US";
}

export function fill(template, params = {}) {
  return String(template || "").replace(/\{(\w+)\}/g, (_, key) => String(params[key] ?? ""));
}

export function formatNumber(value, locale) {
  return Number(value || 0).toLocaleString(intlLocale(locale));
}

export function formatDate(value, locale, withTime = false) {
  if (!value) return "-";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "-";
  return withTime ? parsed.toLocaleString(intlLocale(locale)) : parsed.toLocaleDateString(intlLocale(locale));
}

/** "1,000,000 tokens", "20 images" — the unit is always said, never implied. */
export function formatAmount(copy, resourceType, units, locale) {
  return fill(copy?.unitCount?.[resourceType] || "{n}", { n: formatNumber(units, locale) });
}

/** A whole number typed by a person: "1,000,000", "1 000 000" and "1000000" are the same. */
export function parseWhole(raw) {
  const text = String(raw ?? "").replace(/[,\s，_]/g, "");
  if (!/^\d+$/.test(text)) return 0;
  const value = Number(text);
  return Number.isSafeInteger(value) ? value : 0;
}

/**
 * The two switches and what they add up to. The platform's freeze and the
 * owner's own pause are separate; the organization works only when both are on.
 * Legacy rows without the split columns fall back to `status`.
 */
export function orgStatus(org = {}) {
  const frozen = org.platform_status === "suspended";
  const paused = org.owner_status === "disabled";
  if (frozen && paused) return { key: "both", frozen, paused, variant: "danger" };
  if (frozen) return { key: "frozen", frozen, paused, variant: "danger" };
  if (paused) return { key: "paused", frozen, paused, variant: "warning" };
  if (org.status && org.status !== "active") return { key: "frozen", frozen: true, paused, variant: "danger" };
  return { key: "active", frozen, paused, variant: "success" };
}

export function OrgStatusBadge({ org, copy }) {
  const status = orgStatus(org);
  return <Badge variant={status.variant}>{copy?.statusLabel?.[status.key] || status.key}</Badge>;
}

/** Who a member is, in the words an operator would say on the phone. */
export function personLabel(person = {}) {
  return person.displayName || person.loginName || person.phone || person.userId || person.user_id || "-";
}
