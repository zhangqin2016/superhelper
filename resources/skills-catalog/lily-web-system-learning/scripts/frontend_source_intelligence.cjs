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

const DEFAULT_MAX_ASSETS = 25;
const DEFAULT_MAX_ASSET_BYTES = 512 * 1024;
const DEFAULT_MAX_HINTS = 200;
const JS_MIME_RE = /(java|ecma)script|text\/js|application\/x-javascript/i;
const JS_URL_RE = /\.m?js(?:[?#]|$)/i;
const API_PATH_RE = /["'`](\/(?:api|graphql|rest|rpc|v\d+|admin\/api|openapi)[A-Za-z0-9_./:{}?=&%~-]*)["'`]/g;
const FETCH_CALL_RE = /\b(?:fetch|axios\.(?:get|post|put|patch|delete)|request)\s*\(\s*["'`]([^"'`]+)["'`]/g;
const ROUTE_PATH_RE = /\b(?:path|route|redirect|to)\s*:\s*["'`](\/(?!\/)[A-Za-z0-9_./:{}?=&%~-]*)["'`]/g;
const ROUTER_ARRAY_RE = /["'`](\/(?!\/)(?:[A-Za-z0-9_-]+|:[A-Za-z0-9_-]+)(?:\/(?:[A-Za-z0-9_.~-]+|:[A-Za-z0-9_-]+))*\/?)["'`]/g;

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

function addHint(map, pathValue, sourceUrl, kind) {
  const pathOnly = compactPath(pathValue);
  if (!pathOnly) return;
  const existing = map.get(pathOnly) || { path: pathOnly, sources: [], confidence: kind === "api" ? "medium" : "low" };
  if (sourceUrl && !existing.sources.includes(sourceUrl)) existing.sources.push(sourceUrl);
  map.set(pathOnly, existing);
}

function extractHintsFromSource(source, sourceUrl) {
  const text = String(source || "");
  const api = new Map();
  const routes = new Map();
  for (const regex of [API_PATH_RE, FETCH_CALL_RE]) {
    regex.lastIndex = 0;
    let match;
    while ((match = regex.exec(text)) !== null) addHint(api, match[1], sourceUrl, "api");
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

function analyzeFrontendSourceFromHar(har, baseUrl, allowedDomainsInput, options = {}) {
  const allowedDomains = [...new Set((allowedDomainsInput || []).map(normalizeHost).filter(Boolean))];
  const baseHost = normalizeHost(baseUrl);
  if (baseHost && !allowedDomains.length) allowedDomains.push(baseHost);
  const maxAssets = Math.max(1, Math.min(Number(options.maxAssets || DEFAULT_MAX_ASSETS), 100));
  const maxAssetBytes = Math.max(1024, Math.min(Number(options.maxAssetBytes || DEFAULT_MAX_ASSET_BYTES), 5 * 1024 * 1024));
  const maxHints = Math.max(10, Math.min(Number(options.maxHints || DEFAULT_MAX_HINTS), 1000));
  const entries = Array.isArray(har?.log?.entries) ? har.log.entries : [];
  const assets = [];
  const apiByPath = new Map();
  const routesByPath = new Map();
  const warnings = [];

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
    const analyzedSource = byteSize > maxAssetBytes ? source.slice(0, maxAssetBytes) : source;
    const hints = extractHintsFromSource(analyzedSource, url);
    for (const hint of hints.apiHints) addHint(apiByPath, hint.path, url, "api");
    for (const hint of hints.routeHints) addHint(routesByPath, hint.path, url, "route");
    assets.push({
      url,
      byteSize,
      analyzedBytes: Buffer.byteLength(analyzedSource, "utf8"),
      truncated: byteSize > maxAssetBytes,
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
    },
    warnings,
  };
}

function parseArgs(argv) {
  const args = { har: "", baseUrl: "", allowedDomains: [], out: "", maxAssetBytes: 0, maxAssets: 0 };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--har") args.har = argv[++i];
    else if (arg === "--base-url") args.baseUrl = argv[++i];
    else if (arg === "--allow-domain") args.allowedDomains.push(argv[++i]);
    else if (arg === "--out") args.out = argv[++i];
    else if (arg === "--max-asset-bytes") args.maxAssetBytes = Number(argv[++i] || 0);
    else if (arg === "--max-assets") args.maxAssets = Number(argv[++i] || 0);
    else if (arg === "--help" || arg === "-h") {
      console.log("Usage: node frontend_source_intelligence.cjs --har scan.har --base-url <url> --allow-domain <host> [--out frontend-source-map.json]");
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

function main() {
  const args = parseArgs(process.argv);
  const har = JSON.parse(fs.readFileSync(path.resolve(args.har), "utf8"));
  const result = analyzeFrontendSourceFromHar(har, args.baseUrl, args.allowedDomains, {
    maxAssets: args.maxAssets || undefined,
    maxAssetBytes: args.maxAssetBytes || undefined,
  });
  const json = `${JSON.stringify(result, null, 2)}\n`;
  if (args.out) fs.writeFileSync(path.resolve(args.out), json, "utf8");
  else process.stdout.write(json);
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    console.error(JSON.stringify({ ok: false, error: err.message }, null, 2));
    process.exit(1);
  }
}

module.exports = {
  analyzeFrontendSourceFromHar,
  extractHintsFromSource,
  isJavaScriptEntry,
};
