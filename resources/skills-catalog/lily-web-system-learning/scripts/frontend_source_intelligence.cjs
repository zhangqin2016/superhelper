#!/usr/bin/env node
"use strict";

/**
 * Bounded frontend-source intelligence for SPA learning.
 *
 * This deliberately does not persist raw JavaScript. It reads same-allowlist JS
 * assets from a captured HAR and emits only structural hints: likely routes and
 * API paths. Large bundles are capped; off-domain assets are ignored.
 */

const fs = require("node:fs");
const path = require("node:path");

const DEFAULT_MAX_ASSETS = 200;
const DEFAULT_MAX_ASSET_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_TOTAL_BYTES = 200 * 1024 * 1024;
const DEFAULT_MAX_HINTS = 5000;
const JS_MIME_RE = /(java|ecma)script|text\/js|application\/x-javascript/i;
const JS_URL_RE = /\.m?js(?:[?#]|$)/i;
const API_PATH_RE = /["'`](\/(?:api|graphql|rest|rpc|v\d+|admin\/api|openapi)[A-Za-z0-9_./:{}?=&%~-]*)["'`]/g;
const METHOD_CALL_RE = /\b(?:fetch|request|\$?axios|http|client|api|service|this\.\$http|this\.\$axios)(?:\.(get|post|put|patch|delete|head|options))?\s*\(\s*["'`]([^"'`]+)["'`]([^)]{0,800})\)/gi;
const OBJECT_CALL_RE = /\b(?:fetch|request|\$?axios|http|client|api|service|this\.\$http|this\.\$axios)\s*\(\s*{([^)]{0,1200})}\s*\)/gi;
const ROUTE_PATH_RE = /\b(?:path|route|redirect|to)\s*:\s*["'`](\/(?!\/)[A-Za-z0-9_./:{}?=&%~-]*)["'`]/g;
const ROUTER_ARRAY_RE = /["'`](\/(?!\/)(?:[A-Za-z0-9_-]+|:[A-Za-z0-9_-]+)(?:\/(?:[A-Za-z0-9_.~-]+|:[A-Za-z0-9_-]+))*\/?)["'`]/g;
const OBJECT_URL_RE = /\b(?:url|path|endpoint)\s*:\s*["'`](\/(?:api|graphql|rest|rpc|v\d+|admin\/api|openapi)[A-Za-z0-9_./:{}?=&%~-]*)["'`]/gi;
const OBJECT_METHOD_RE = /\bmethod\s*:\s*["'`](GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)["'`]/i;

function normalizeHost(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  try {
    return new URL(raw.includes("://") ? raw : `https://${raw}`).hostname.toLowerCase();
  } catch {
    return raw.toLowerCase();
  }
}

function isHostAllowed(host, allowedDomains) {
  return allowedDomains.includes(host) || allowedDomains.some((domain) => host.endsWith(`.${domain}`));
}

function isUrlAllowed(url, allowedDomains) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
    return isHostAllowed(parsed.hostname.toLowerCase(), allowedDomains);
  } catch {
    return false;
  }
}

function stripQueryAndHash(value) {
  try {
    const parsed = new URL(value, "https://placeholder.local");
    return parsed.pathname || "/";
  } catch {
    return String(value || "").split(/[?#]/)[0] || "";
  }
}

function compactPath(value) {
  const text = String(value || "").trim();
  if (!text || text.startsWith("//") || /^[a-z][a-z0-9+.-]*:/i.test(text)) return "";
  const pathOnly = stripQueryAndHash(text);
  if (!pathOnly.startsWith("/") || pathOnly === "/") return "";
  if (/\.(?:png|jpe?g|gif|svg|webp|css|map|woff2?|ttf|ico|m?js)$/i.test(pathOnly)) return "";
  return pathOnly.slice(0, 240);
}

function normalizeMethod(value) {
  const method = String(value || "").trim().toUpperCase();
  return /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)$/.test(method) ? method : "";
}

function inferFetchMethod(tail = "") {
  const match = String(tail || "").match(/\bmethod\s*:\s*["'`](GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)["'`]/i);
  return normalizeMethod(match?.[1]) || "GET";
}

function addHint(map, pathValue, sourceUrl, kind, meta = {}) {
  const pathOnly = compactPath(pathValue);
  if (!pathOnly) return;
  const existing = map.get(pathOnly) || { path: pathOnly, sources: [], confidence: kind === "api" ? "medium" : "low" };
  if (sourceUrl && !existing.sources.includes(sourceUrl)) existing.sources.push(sourceUrl);
  const method = normalizeMethod(meta.method);
  if (kind === "api" && method) {
    const methods = new Set(Array.isArray(existing.methods) ? existing.methods : []);
    methods.add(method);
    existing.methods = [...methods].sort();
    if (!existing.method && existing.methods.length === 1) existing.method = existing.methods[0];
    if (existing.methods.length > 1) delete existing.method;
  }
  if (kind === "api" && meta.callsite) {
    const callsites = new Set(Array.isArray(existing.callsites) ? existing.callsites : []);
    callsites.add(String(meta.callsite).slice(0, 80));
    existing.callsites = [...callsites].slice(0, 12);
  }
  map.set(pathOnly, existing);
}

function extractHintsFromSource(source, sourceUrl) {
  const text = String(source || "");
  const api = new Map();
  const routes = new Map();
  API_PATH_RE.lastIndex = 0;
  let apiMatch;
  while ((apiMatch = API_PATH_RE.exec(text)) !== null) addHint(api, apiMatch[1], sourceUrl, "api", { callsite: "string-literal" });

  METHOD_CALL_RE.lastIndex = 0;
  let methodMatch;
  while ((methodMatch = METHOD_CALL_RE.exec(text)) !== null) {
    const verb = normalizeMethod(methodMatch[1]) || inferFetchMethod(methodMatch[3]);
    addHint(api, methodMatch[2], sourceUrl, "api", { method: verb, callsite: "method-call" });
  }

  OBJECT_CALL_RE.lastIndex = 0;
  let objectMatch;
  while ((objectMatch = OBJECT_CALL_RE.exec(text)) !== null) {
    const body = objectMatch[1] || "";
    const method = normalizeMethod(body.match(OBJECT_METHOD_RE)?.[1]) || "GET";
    OBJECT_URL_RE.lastIndex = 0;
    let urlMatch;
    while ((urlMatch = OBJECT_URL_RE.exec(body)) !== null) {
      addHint(api, urlMatch[1], sourceUrl, "api", { method, callsite: "object-call" });
    }
  }

  for (const regex of [ROUTE_PATH_RE, ROUTER_ARRAY_RE]) {
    regex.lastIndex = 0;
    let match;
    while ((match = regex.exec(text)) !== null) {
      const value = match[1].startsWith("/") ? match[1] : `/${match[1]}`;
      if (/^\/(?:api|graphql|rest|rpc|v\d+)(?:\/|$)/i.test(value)) continue;
      addHint(routes, value, sourceUrl, "route");
    }
  }
  return { apiHints: [...api.values()], routeHints: [...routes.values()] };
}

function isJavaScriptEntry(entry) {
  const type = String(entry?._resourceType || "").toLowerCase();
  const url = String(entry?.request?.url || "");
  const mime = String(entry?.response?.content?.mimeType || "");
  return type === "script" || JS_MIME_RE.test(mime) || JS_URL_RE.test(url);
}

function cookieAppliesToUrl(cookie, url) {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    const domain = String(cookie.domain || "").replace(/^\./, "").toLowerCase();
    if (domain && host !== domain && !host.endsWith(`.${domain}`)) return false;
    const cookiePath = String(cookie.path || "/");
    if (cookiePath && !parsed.pathname.startsWith(cookiePath)) return false;
    if (cookie.secure && parsed.protocol !== "https:") return false;
    return Boolean(cookie.name);
  } catch {
    return false;
  }
}

function cookieHeaderForUrl(storageState, url) {
  const cookies = Array.isArray(storageState?.cookies) ? storageState.cookies : [];
  return cookies
    .filter((cookie) => cookieAppliesToUrl(cookie, url))
    .map((cookie) => `${cookie.name}=${cookie.value || ""}`)
    .join("; ");
}

async function hydrateMissingJavaScriptFromHar(har, baseUrl, allowedDomainsInput, options = {}) {
  const storageStatePath = options.storageState ? path.resolve(options.storageState) : "";
  if (!storageStatePath) return { fetched: 0, warnings: [] };
  let storageState = null;
  try {
    storageState = JSON.parse(fs.readFileSync(storageStatePath, "utf8"));
  } catch (err) {
    return { fetched: 0, warnings: [`STORAGE_STATE_UNREADABLE:${err.message}`] };
  }
  const allowedDomains = [...new Set((allowedDomainsInput || []).map(normalizeHost).filter(Boolean))];
  const baseHost = normalizeHost(baseUrl);
  if (baseHost && !allowedDomains.length) allowedDomains.push(baseHost);
  const maxAssets = Math.max(1, Math.min(Number(options.maxAssets || DEFAULT_MAX_ASSETS), 500));
  const maxAssetBytes = Math.max(1024, Math.min(Number(options.maxAssetBytes || DEFAULT_MAX_ASSET_BYTES), 10 * 1024 * 1024));
  const entries = Array.isArray(har?.log?.entries) ? har.log.entries : [];
  const warnings = [];
  let fetched = 0;
  for (const entry of entries) {
    if (fetched >= maxAssets) break;
    const url = String(entry?.request?.url || "");
    if (!url || !isJavaScriptEntry(entry) || !isUrlAllowed(url, allowedDomains)) continue;
    const content = entry.response && typeof entry.response === "object" ? (entry.response.content || {}) : {};
    if (content.text) continue;
    try {
      const headers = {};
      const cookie = cookieHeaderForUrl(storageState, url);
      if (cookie) headers.cookie = cookie;
      const response = await fetch(url, { headers, redirect: "follow" });
      if (!response.ok) {
        warnings.push(`FETCH_JS_STATUS:${response.status}:${url}`);
        continue;
      }
      const mime = response.headers.get("content-type") || "application/javascript";
      if (!JS_MIME_RE.test(mime) && !JS_URL_RE.test(url)) {
        warnings.push(`FETCH_JS_NON_SCRIPT:${url}`);
        continue;
      }
      const text = await response.text();
      entry.response = entry.response && typeof entry.response === "object" ? entry.response : {};
      entry.response.status = response.status;
      entry.response.content = {
        mimeType: mime,
        text: text.slice(0, maxAssetBytes),
      };
      fetched += 1;
    } catch (err) {
      warnings.push(`FETCH_JS_FAILED:${url}:${err.message}`);
    }
  }
  return { fetched, warnings };
}

function analyzeFrontendSourceFromHar(har, baseUrl, allowedDomainsInput, options = {}) {
  const allowedDomains = [...new Set((allowedDomainsInput || []).map(normalizeHost).filter(Boolean))];
  const baseHost = normalizeHost(baseUrl);
  if (baseHost && !allowedDomains.length) allowedDomains.push(baseHost);
  const maxAssets = Math.max(1, Math.min(Number(options.maxAssets || DEFAULT_MAX_ASSETS), 500));
  const maxAssetBytes = Math.max(1024, Math.min(Number(options.maxAssetBytes || DEFAULT_MAX_ASSET_BYTES), 10 * 1024 * 1024));
  const maxTotalBytes = Math.max(maxAssetBytes, Math.min(Number(options.maxTotalBytes || DEFAULT_MAX_TOTAL_BYTES), 500 * 1024 * 1024));
  const maxHints = Math.max(10, Math.min(Number(options.maxHints || DEFAULT_MAX_HINTS), 20000));
  const entries = Array.isArray(har?.log?.entries) ? har.log.entries : [];
  const assets = [];
  const apiByPath = new Map();
  const routesByPath = new Map();
  const warnings = [];
  let totalAnalyzedBytes = 0;

  for (const entry of entries) {
    if (assets.length >= maxAssets) {
      warnings.push("ASSET_LIMIT_REACHED");
      break;
    }
    const url = String(entry?.request?.url || "");
    if (!url || !isJavaScriptEntry(entry) || !isUrlAllowed(url, allowedDomains)) continue;
    const content = entry?.response?.content || {};
    if (String(content.encoding || "").toLowerCase() === "base64") {
      warnings.push(`SKIPPED_BASE64:${url}`);
      continue;
    }
    const source = String(content.text || "");
    if (!source) continue;
    const byteSize = Buffer.byteLength(source, "utf8");
    if (totalAnalyzedBytes >= maxTotalBytes) {
      warnings.push("TOTAL_ASSET_BYTES_LIMIT_REACHED");
      break;
    }
    const remainingBytes = maxTotalBytes - totalAnalyzedBytes;
    const perAssetLimit = Math.min(maxAssetBytes, remainingBytes);
    const analyzedSource = byteSize > perAssetLimit ? source.slice(0, perAssetLimit) : source;
    const analyzedBytes = Buffer.byteLength(analyzedSource, "utf8");
    totalAnalyzedBytes += analyzedBytes;
    const hints = extractHintsFromSource(analyzedSource, url);
    for (const hint of hints.apiHints) {
      const methods = Array.isArray(hint.methods) ? hint.methods : (hint.method ? [hint.method] : []);
      if (methods.length) {
        for (const method of methods) addHint(apiByPath, hint.path, url, "api", { method, callsite: (hint.callsites || [])[0] });
      } else {
        addHint(apiByPath, hint.path, url, "api", { callsite: (hint.callsites || [])[0] });
      }
    }
    for (const hint of hints.routeHints) addHint(routesByPath, hint.path, url, "route");
    assets.push({
      url,
      byteSize,
      analyzedBytes,
      truncated: byteSize > perAssetLimit,
      routeHintCount: hints.routeHints.length,
      apiHintCount: hints.apiHints.length,
    });
  }

  const routeHints = [...routesByPath.values()].slice(0, maxHints);
  const apiHints = [...apiByPath.values()].slice(0, maxHints);
  return {
    ok: true,
    schemaVersion: 1,
    kind: "frontend-source-map",
    baseUrl,
    allowedDomains,
    assets,
    routeHints,
    apiHints,
    coverage: {
      assetCount: assets.length,
      routeHintCount: routeHints.length,
      apiHintCount: apiHints.length,
      truncatedAssetCount: assets.filter((asset) => asset.truncated).length,
      analyzedBytes: totalAnalyzedBytes,
      maxAssets,
      maxAssetBytes,
      maxTotalBytes,
    },
    warnings,
  };
}

function parseArgs(argv) {
  const args = { har: "", baseUrl: "", allowedDomains: [], out: "", storageState: "", maxAssetBytes: 0, maxAssets: 0, maxTotalBytes: 0, maxHints: 0 };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--har") args.har = argv[++i];
    else if (arg === "--base-url") args.baseUrl = argv[++i];
    else if (arg === "--allow-domain") args.allowedDomains.push(argv[++i]);
    else if (arg === "--out") args.out = argv[++i];
    else if (arg === "--storage-state") args.storageState = argv[++i];
    else if (arg === "--max-asset-bytes") args.maxAssetBytes = Number(argv[++i] || 0);
    else if (arg === "--max-assets") args.maxAssets = Number(argv[++i] || 0);
    else if (arg === "--max-total-bytes") args.maxTotalBytes = Number(argv[++i] || 0);
    else if (arg === "--max-hints") args.maxHints = Number(argv[++i] || 0);
    else if (arg === "--help" || arg === "-h") {
      console.log("Usage: node frontend_source_intelligence.cjs --har scan.har --base-url <url> --allow-domain <host> [--storage-state session.json] [--out frontend-source-map.json]");
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!args.har) throw new Error("Missing --har");
  if (!args.baseUrl) throw new Error("Missing --base-url");
  if (!args.allowedDomains.length) throw new Error("Missing --allow-domain");
  return args;
}

async function main() {
  const args = parseArgs(process.argv);
  const har = JSON.parse(fs.readFileSync(path.resolve(args.har), "utf8"));
  const hydration = await hydrateMissingJavaScriptFromHar(har, args.baseUrl, args.allowedDomains, {
    storageState: args.storageState || "",
    maxAssets: args.maxAssets || undefined,
    maxAssetBytes: args.maxAssetBytes || undefined,
  });
  const result = analyzeFrontendSourceFromHar(har, args.baseUrl, args.allowedDomains, {
    maxAssets: args.maxAssets || undefined,
    maxAssetBytes: args.maxAssetBytes || undefined,
    maxTotalBytes: args.maxTotalBytes || undefined,
    maxHints: args.maxHints || undefined,
  });
  if (hydration.fetched) result.coverage.fetchedAssetCount = hydration.fetched;
  if (hydration.warnings.length) result.warnings.push(...hydration.warnings);
  const json = `${JSON.stringify(result, null, 2)}\n`;
  if (args.out) fs.writeFileSync(path.resolve(args.out), json, "utf8");
  else process.stdout.write(json);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(JSON.stringify({ ok: false, error: err.message }, null, 2));
    process.exit(1);
  });
}

module.exports = {
  analyzeFrontendSourceFromHar,
  hydrateMissingJavaScriptFromHar,
  extractHintsFromSource,
  isJavaScriptEntry,
};
