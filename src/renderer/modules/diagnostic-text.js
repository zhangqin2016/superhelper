import { t } from "../i18n/index.js";

function translated(key, fallback, params) {
  if (!key) return fallback || "";
  const value = t(key, params);
  return value === key ? fallback || "" : value;
}

export function diagnosticText(check) {
  const label = translated(check.labelCode, check.label, check.params);
  const detail = translated(check.detailCode, check.detail, check.params);
  const message = check.messageCode
    ? translated(check.messageCode, check.message, check.params)
    : label ? (detail ? t("diagnostics.issue", { label, detail }) : label) : check.message || "";
  return { label, detail, message };
}
