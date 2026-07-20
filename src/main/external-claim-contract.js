"use strict";

const MAX_AUTHORITY_HOSTS = 12;
const MAX_ANCHOR_GROUPS = 12;
const MAX_ANCHOR_ALTERNATIVES = 8;
const MAX_ANCHOR_CHARS = 120;

function cleanText(value = "", limit = MAX_ANCHOR_CHARS) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, limit);
}

function normalizeComparable(value = "", limit = 40_000) {
  return String(value || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, "")
    .slice(0, limit);
}

function normalizeAuthorityHost(value = "") {
  const source = cleanText(value, 300).replace(/^\*\./, "");
  if (!source) return "";
  try {
    const parsed = new URL(source.includes("://") ? source : `https://${source}`);
    return parsed.hostname.toLowerCase().replace(/^www\./, "").replace(/\.$/, "");
  } catch {
    return "";
  }
}

function normalizeAuthorityHosts(values = []) {
  const result = [];
  for (const value of Array.isArray(values) ? values : []) {
    const host = normalizeAuthorityHost(value);
    if (!host || result.includes(host)) continue;
    result.push(host);
    if (result.length >= MAX_AUTHORITY_HOSTS) break;
  }
  return result;
}

function normalizeEvidenceAnchorGroups(values = []) {
  const result = [];
  const seen = new Set();
  for (const rawGroup of Array.isArray(values) ? values : []) {
    const alternatives = [];
    for (const rawValue of Array.isArray(rawGroup) ? rawGroup : [rawGroup]) {
      const value = cleanText(rawValue);
      if (!value || alternatives.includes(value)) continue;
      alternatives.push(value);
      if (alternatives.length >= MAX_ANCHOR_ALTERNATIVES) break;
    }
    if (!alternatives.length) continue;
    const key = alternatives.map((value) => normalizeComparable(value, MAX_ANCHOR_CHARS)).sort().join("\0");
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(alternatives);
    if (result.length >= MAX_ANCHOR_GROUPS) break;
  }
  return result;
}

function evidenceSupportsAnchorGroups(value = "", groups = []) {
  const requiredGroups = normalizeEvidenceAnchorGroups(groups);
  if (!requiredGroups.length) return false;
  const source = normalizeComparable(value);
  return requiredGroups.every((alternatives) => alternatives.some((anchor) =>
    source.includes(normalizeComparable(anchor, MAX_ANCHOR_CHARS)),
  ));
}

function isAuthorityHostUrl(value = "", authorityHosts = []) {
  const allowed = normalizeAuthorityHosts(authorityHosts);
  if (!allowed.length) return true;
  try {
    const hostname = new URL(value).hostname.toLowerCase().replace(/^www\./, "").replace(/\.$/, "");
    return allowed.some((host) => hostname === host || hostname.endsWith(`.${host}`));
  } catch {
    return false;
  }
}

function satisfiesAuthorityHosts(urls = [], authorityHosts = []) {
  const allowed = normalizeAuthorityHosts(authorityHosts);
  return !allowed.length || (Array.isArray(urls) ? urls : []).some((url) =>
    isAuthorityHostUrl(url, allowed),
  );
}

function isEvidenceAnchorLabel(label = "", groups = []) {
  const normalizedLabel = normalizeComparable(label, MAX_ANCHOR_CHARS);
  if (!normalizedLabel) return false;
  return normalizeEvidenceAnchorGroups(groups).some((alternatives) => alternatives.some((anchor) => {
    const normalizedAnchor = normalizeComparable(anchor, MAX_ANCHOR_CHARS);
    return normalizedAnchor === normalizedLabel;
  }));
}

module.exports = {
  evidenceSupportsAnchorGroups,
  isAuthorityHostUrl,
  isEvidenceAnchorLabel,
  normalizeAuthorityHost,
  normalizeAuthorityHosts,
  normalizeComparable,
  normalizeEvidenceAnchorGroups,
  satisfiesAuthorityHosts,
};
