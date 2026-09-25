"use strict";

// Stop at citation separators (; ， 、) too: models frequently join two source
// links as "(url1;url2)", which otherwise merges into one unmatchable URL and
// falsely fails source_link_not_in_evidence. Both the answer and the evidence
// are extracted with THIS regex, so any truncation is consistent on both sides
// and never breaks matching.
// A backtick or asterisk ends a URL too: models cite as `https://…` and
// **https://…**, and a swallowed closing mark turned every such citation into
// "…/login%60", which no evidence contains — the model's correct links were
// then stripped as fabricated (2026-09-25).
const HTTP_URL_RE = /https?:\/\/[^\s<>"'`*\])}）】》;；，、]+/gi;

// A host is a name or an address. Text that merely looks like a URL — a code
// template's `http://{args.host}/…` — is not a source anyone can open, and
// listing it as one is worse than listing nothing.
const HOSTNAME_RE = /^(?:[a-z0-9_](?:[a-z0-9_-]*[a-z0-9_])?)(?:\.[a-z0-9_](?:[a-z0-9_-]*[a-z0-9_])?)*$|^\[[0-9a-f:.]+\]$/i;

function normalizeHttpUrl(value = "") {
  try {
    const parsed = new URL(
      String(value || "")
        .replace(/&amp;/gi, "&")
        .replace(/[.,;:!?，。；：！？）】》`*]+$/u, ""),
    );
    if (!HOSTNAME_RE.test(parsed.hostname)) return "";
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
