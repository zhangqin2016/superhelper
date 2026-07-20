"use strict";

const { satisfiesAuthorityHosts } = require("./external-claim-contract");

const HTTP_URL_RE = /https?:\/\/[^\s<>"'\])}）】》]+/gi;

function normalizeHttpUrl(value = "") {
  try {
    const parsed = new URL(
      String(value || "")
        .replace(/&amp;/gi, "&")
        .replace(/[.,;:!?，。；：！？）】》]+$/u, ""),
    );
    parsed.hash = "";
    const pathname = parsed.pathname.replace(/\/+$/, "") || "/";
    return `${parsed.protocol}//${parsed.host.toLowerCase()}${pathname}${parsed.search}`;
  } catch {
    return "";
  }
}

function extractHttpUrls(value = "") {
  const matches = String(value || "").match(HTTP_URL_RE) || [];
  return [...new Set(matches.map(normalizeHttpUrl).filter(Boolean))].slice(0, 50);
}

function isGovernmentAuthorityUrl(value = "") {
  try {
    const hostname = new URL(value).hostname.toLowerCase();
    const labels = hostname.split(".");
    return labels.some((label) => ["gov", "govt", "gouv", "government"].includes(label));
  } catch {
    return false;
  }
}

function satisfiesAuthorityUrlPolicy(urls = [], policy = "none", authorityHosts = []) {
  if (!satisfiesAuthorityHosts(urls, authorityHosts)) return false;
  if (policy === "none") return true;
  if (policy === "government") return urls.some(isGovernmentAuthorityUrl);
  return true;
}

module.exports = {
  extractHttpUrls,
  isGovernmentAuthorityUrl,
  normalizeHttpUrl,
  satisfiesAuthorityUrlPolicy,
};
