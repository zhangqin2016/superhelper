#!/usr/bin/env node
"use strict";

/**
 * Learn how authenticated requests should be assembled without storing token
 * values in skills or plans. The recipe stores sources ("Authorization comes
 * from localStorage.access_token, formatted as Bearer {{value}}"), while the
 * executor reads the actual value from the local Playwright storageState.
 */

const fs = require("node:fs");
const path = require("node:path");
const { normalizeHost, isUrlAllowed } = require("./discover_contracts.cjs");

const AUTH_HEADER_RE = /^(authorization|x-csrf-token|x-xsrf-token|csrf-token|x-csrf|x-xsrf)$/i;
const REFRESH_PATH_RE = /(refresh|renew|token|session|auth)/i;

function parseArgs(argv) {
  const args = { storageState: "", har: "", baseUrl: "", allowDomains: [], out: "" };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--storage-state") args.storageState = argv[++i];
    else if (arg === "--har") args.har = argv[++i];
    else if (arg === "--base-url") args.baseUrl = argv[++i];
    else if (arg === "--allow-domain") args.allowDomains.push(normalizeHost(argv[++i]));
    else if (arg === "--allowlist") args.allowDomains.push(...String(argv[++i] || "").split(",").map(normalizeHost).filter(Boolean));
    else if (arg === "--out") args.out = argv[++i];
    else if (arg === "--help" || arg === "-h") {
      console.log("Usage: node learn_auth_recipe.cjs --storage-state <state.json> --base-url <url> --allow-domain <host> [--har scan.har] [--out auth-recipe.json]");
      process.exit(0);
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!args.storageState) throw new Error("Missing --storage-state");
  if (!args.baseUrl) throw new Error("Missing --base-url");
  if (!args.allowDomains.length) args.allowDomains = [normalizeHost(args.baseUrl)];
  if (!args.out) args.out = defaultAuthRecipePath(args.storageState);
  return args;
}

function defaultAuthRecipePath(storageStatePath) {
  const ext = path.extname(storageStatePath);
  return ext ? storageStatePath.slice(0, -ext.length) + ".auth-recipe.json" : `${storageStatePath}.auth-recipe.json`;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(path.resolve(file), "utf8"));
}

function storageEntries(storageState) {
  const entries = [];
  for (const origin of storageState?.origins || []) {
    for (const item of origin.localStorage || []) {
      if (!item?.name || item.value === undefined) continue;
      entries.push({ source: "localStorage", origin: origin.origin || "", key: item.name, value: String(item.value) });
    }
  }
  for (const origin of storageState?.lilySessionStorage || []) {
    for (const item of origin.sessionStorage || []) {
      if (!item?.name || item.value === undefined) continue;
      entries.push({ source: "sessionStorage", origin: origin.origin || "", key: item.name, value: String(item.value) });
    }
  }
  for (const cookie of storageState?.cookies || []) {
    if (!cookie?.name || cookie.value === undefined) continue;
    entries.push({ source: "cookie", domain: String(cookie.domain || ""), key: cookie.name, value: String(cookie.value) });
  }
  return entries;
}

function formatForHeader(headerValue, tokenValue) {
  if (headerValue === tokenValue) return "{{value}}";
  if (headerValue === `Bearer ${tokenValue}`) return "Bearer {{value}}";
  if (headerValue.includes(tokenValue)) return headerValue.replace(tokenValue, "{{value}}");
  return "";
}

function resolveHeaderSource(headerValue, entries) {
  const raw = String(headerValue || "");
  if (!raw) return null;
  const sorted = entries
    .filter((entry) => entry.value && raw.includes(entry.value))
    .sort((a, b) => b.value.length - a.value.length);
  for (const entry of sorted) {
    const format = formatForHeader(raw, entry.value);
    if (!format) continue;
    return {
      source: entry.source,
      key: entry.key,
      origin: entry.origin || undefined,
      domain: entry.domain || undefined,
      format,
    };
  }
  return null;
}

function headerArray(headers) {
  if (Array.isArray(headers)) return headers;
  if (headers && typeof headers === "object") {
    return Object.entries(headers).map(([name, value]) => ({ name, value }));
  }
  return [];
}

function learnAuthRecipe({ storageState, har, baseUrl, allowedDomains }) {
  const entries = storageEntries(storageState);
  const headerRules = [];
  const unresolvedHeaders = [];
  const refreshCandidates = [];
  const seenRules = new Set();
  const seenUnresolved = new Set();
  const seenRefresh = new Set();

  for (const entry of har?.log?.entries || []) {
    const req = entry?.request || {};
    if (!req.url || !isUrlAllowed(req.url, allowedDomains)) continue;
    for (const header of headerArray(req.headers)) {
      const name = String(header?.name || "").trim();
      if (!AUTH_HEADER_RE.test(name)) continue;
      const resolved = resolveHeaderSource(header.value, entries);
      if (!resolved) {
        const key = name.toLowerCase();
        if (!seenUnresolved.has(key)) {
          unresolvedHeaders.push({ name, reason: "source-not-found-in-storage-state" });
          seenUnresolved.add(key);
        }
        continue;
      }
      const key = `${name.toLowerCase()}:${resolved.source}:${resolved.key}:${resolved.format}`;
      if (seenRules.has(key)) continue;
      seenRules.add(key);
      headerRules.push({ name, ...resolved });
    }

    let url;
    try {
      url = new URL(req.url);
    } catch {
      continue;
    }
    if (!REFRESH_PATH_RE.test(url.pathname)) continue;
    const refreshKey = `${String(req.method || "GET").toUpperCase()} ${url.origin}${url.pathname}`;
    if (seenRefresh.has(refreshKey)) continue;
    seenRefresh.add(refreshKey);
    refreshCandidates.push({
      method: String(req.method || "GET").toUpperCase(),
      endpoint: `${url.origin}${url.pathname}`,
      source: "har",
    });
  }

  return {
    schemaVersion: 1,
    baseUrl,
    allowedDomains,
    cookies: { mode: "storage-state", inject: true },
    headerRules,
    unresolvedHeaders,
    refreshCandidates,
    notes: [
      "No token values are stored in this recipe.",
      "The executor resolves header values from the local storageState at runtime.",
    ],
  };
}

function writeRecipe(file, recipe) {
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  fs.writeFileSync(path.resolve(file), `${JSON.stringify(recipe, null, 2)}\n`);
  try {
    fs.chmodSync(path.resolve(file), 0o600);
  } catch {
    /* best-effort */
  }
}

function main() {
  const args = parseArgs(process.argv);
  const storageState = readJson(args.storageState);
  const har = args.har ? readJson(args.har) : null;
  const recipe = learnAuthRecipe({ storageState, har, baseUrl: args.baseUrl, allowedDomains: args.allowDomains });
  writeRecipe(args.out, recipe);
  process.stdout.write(`${JSON.stringify({ ok: true, out: path.resolve(args.out), headerRules: recipe.headerRules.length, unresolvedHeaders: recipe.unresolvedHeaders.length, refreshCandidates: recipe.refreshCandidates.length }, null, 2)}\n`);
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    process.stderr.write(`${JSON.stringify({ ok: false, error: String(err?.message || err) })}\n`);
    process.exit(1);
  }
}

module.exports = { defaultAuthRecipePath, storageEntries, learnAuthRecipe, resolveHeaderSource };
