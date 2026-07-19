"use strict";

const RANKING_REQUEST_RE = /(?:排名|排行榜|榜单|前\s*\d+|第\s*\d+\s*名|\btop\s*\d+\b|\brank(?:ing|ed|s)?\b)/i;
const NUMBERED_CLAIM_RE = /^\s*(\d{1,3})\s*[.)、:]\s+(.+?)\s*$/;

function normalizeClaimText(value = "") {
  return String(value || "")
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/[\s\p{P}\p{S}]+/gu, "")
    .slice(0, 500);
}

function claimLabel(value = "") {
  const withoutLinks = String(value || "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[*_`#]/g, " ")
    .trim();
  const firstField = withoutLinks.split(/\s+(?:[-–—|]|[:：])\s+|\s*\([^)]*\)\s*$/)[0] || "";
  return firstField.trim().slice(0, 160);
}

function extractRankedClaims(assistant = "") {
  const claims = [];
  for (const line of String(assistant || "").split(/\r?\n/)) {
    const match = line.match(NUMBERED_CLAIM_RE);
    if (!match) continue;
    const label = claimLabel(match[2]);
    const normalizedLabel = normalizeClaimText(label);
    if (normalizedLabel.length < 2) continue;
    claims.push({ rank: Number(match[1]), label, normalizedLabel });
    if (claims.length >= 50) break;
  }
  return claims;
}

function assessClaimEvidenceCoverage({ assistant = "", evidenceText = "", userText = "", externalFact = false } = {}) {
  if (!externalFact || !RANKING_REQUEST_RE.test(`${userText}\n${assistant}`)) return null;
  const claims = extractRankedClaims(assistant);
  if (claims.length < 2) return null;
  const corpus = normalizeClaimText(`${evidenceText}\n${userText}`);
  const mapped = claims.map((claim) => ({
    ...claim,
    supported: corpus.includes(claim.normalizedLabel),
  }));
  const unsupported = mapped.filter((claim) => !claim.supported);
  return {
    ok: unsupported.length === 0,
    schemaVersion: 1,
    claimCount: mapped.length,
    supportedClaimCount: mapped.length - unsupported.length,
    claims: mapped.map(({ rank, label, supported }) => ({ rank, label, supported })),
    unsupportedClaims: unsupported.slice(0, 10).map(({ rank, label }) => ({ rank, label })),
  };
}

module.exports = {
  assessClaimEvidenceCoverage,
  extractRankedClaims,
  normalizeClaimText,
};
