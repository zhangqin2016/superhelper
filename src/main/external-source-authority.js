"use strict";

// Stop at citation separators (; ， 、) too: models frequently join two source
// links as "(url1;url2)", which otherwise merges into one unmatchable URL and
// falsely fails source_link_not_in_evidence. Both the answer and the evidence
// are extracted with THIS regex, so any truncation is consistent on both sides
// and never breaks matching.
const HTTP_URL_RE = /https?:\/\/[^\s<>"'\])}）】》;；，、]+/gi;

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

module.exports = {
  extractHttpUrls,
  normalizeHttpUrl,
};
