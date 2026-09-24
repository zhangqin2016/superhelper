"use strict";

// Update feeds and download links may arrive from the service API. Restrict
// them to origins we already trust for updates — a compromised or spoofed
// service response must not be able to redirect the updater elsewhere.

const DEFAULT_MANIFEST_URL = "https://qny.lanrensoft.cn/app/updates/latest.json";
const DEFAULT_AUTO_UPDATE_BASE_URL = "https://qny.lanrensoft.cn/app/auto-updates";

function defaultManifestUrl() {
  return process.env.LILY_UPDATE_MANIFEST_URL || DEFAULT_MANIFEST_URL;
}

function defaultAutoUpdateBaseUrl() {
  return process.env.LILY_AUTO_UPDATE_BASE_URL || DEFAULT_AUTO_UPDATE_BASE_URL;
}

function trustedUpdateOrigins() {
  const origins = new Set();
  const candidates = [
    defaultManifestUrl(),
    defaultAutoUpdateBaseUrl(),
    process.env.LILY_AUTO_UPDATE_FEED_URL,
  ];
  try {
    const svc = require("./service-client").getServiceSettings();
    if (svc?.apiBaseUrl) candidates.push(svc.apiBaseUrl);
  } catch {
    // service client unavailable in some test contexts
  }
  for (const value of candidates) {
    try {
      if (value) origins.add(new URL(String(value)).origin);
    } catch {
      // ignore malformed configured URLs
    }
  }
  return origins;
}

function isTrustedUpdateUrl(url) {
  try {
    const parsed = new URL(String(url || ""));
    const loopback = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1";
    if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && loopback)) return false;
    return trustedUpdateOrigins().has(parsed.origin);
  } catch {
    return false;
  }
}


module.exports = { isTrustedUpdateUrl, trustedUpdateOrigins, defaultManifestUrl, defaultAutoUpdateBaseUrl };
