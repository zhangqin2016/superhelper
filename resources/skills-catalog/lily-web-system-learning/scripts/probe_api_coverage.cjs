#!/usr/bin/env node
"use strict";
/**
 * Active API-coverage probing for systems that do NOT publish an OpenAPI/GraphQL
 * contract. Published contracts (discover_contracts.cjs) and real traffic
 * (har_to_contracts.cjs) only reveal what the app documents or what the scan
 * happened to trigger. This closes the gap: it takes the frontend-source apiHints
 * (endpoints the app's own JS references) that were NOT seen in traffic, and does
 * a bounded, authenticated, READ-ONLY probe to CONFIRM each exists and learn its
 * response schema — turning "hinted but unverified" into a real contract, or
 * recording it as permission-gated / stale.
 *
 * Parameter-space probing: it harvests id-like values from verified collection
 * responses and fills templated GET hints ("/users/{id}") with a real id, so
 * detail endpoints get covered too.
 *
 * SAFETY (read-only, permission-respecting, no stealth):
 *  - Only GET/HEAD are ever executed. POST/PUT/PATCH/DELETE hints are recorded
 *    UNVERIFIED and NEVER sent (no mutation risk).
 *  - 401/403 is respected: recorded as "gated" (exists, no permission), never
 *    retried or bypassed. No UA/webdriver spoofing — the existing authed session
 *    cookies only.
 *  - Domain allowlist enforced; bounded probe count; rate-limited; per-probe
 *    timeout. Fail-open: any error skips that endpoint, keeping the baseline.
 *  - Merges into api-contracts.json WITHOUT overriding authoritative/earlier
 *    contracts. Reports an honest coverage delta; never claims complete coverage.
 */
const fs = require("node:fs");
const path = require("node:path");
const { isUrlAllowed, cookieHeaderFor, fetchResource, joinUrl } = require("./discover_contracts.cjs");
const { inferSchema, stripQuery } = require("./har_to_contracts.cjs");

const READ_METHODS = new Set(["GET", "HEAD"]);
const DEFAULT_MAX_PROBES = 80;
const DEFAULT_DELAY_MS = 150;
const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_HARVESTED_IDS = 24;
const MAX_TEMPLATE_ATTEMPTS = 3;
const ID_KEY_RE = /^(id|uuid|guid|code|key|no|num|[a-z0-9]*_?id)$/i;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function isTemplated(p) {
  return /[:{]/.test(p);
}

function contractId(method, p) {
  return `probe-${method}-${p}`.replace(/[^a-z0-9]+/gi, "-").toLowerCase().replace(/^-+|-+$/g, "").slice(0, 80);
}

function riskFor(method) {
  return READ_METHODS.has(method) ? "read" : (method === "DELETE" ? "high" : "write");
}

// Pull id-like scalar values out of a JSON body (arrays of objects, or object
// with an array field) to fill templated detail endpoints.
function harvestIds(body, out) {
  if (out.size >= MAX_HARVESTED_IDS) return;
  const items = Array.isArray(body)
    ? body
    : (body && typeof body === "object")
      ? Object.values(body).find((v) => Array.isArray(v)) || []
      : [];
  for (const item of items.slice(0, 12)) {
    if (!item || typeof item !== "object") continue;
    for (const [k, v] of Object.entries(item)) {
      if ((typeof v === "string" || typeof v === "number") && ID_KEY_RE.test(k)) {
        const s = String(v).trim();
        if (s && s.length <= 64 && /^[A-Za-z0-9_-]+$/.test(s)) out.add(s);
        if (out.size >= MAX_HARVESTED_IDS) return;
      }
    }
  }
}

function fillTemplate(p, id) {
  // Replace the first :param or {param} with the id; bail if more than one.
  const params = p.match(/(:[A-Za-z0-9_]+|\{[A-Za-z0-9_]+\})/g) || [];
  if (params.length !== 1) return "";
  return p.replace(params[0], encodeURIComponent(id));
}

async function probeApiCoverage({
  baseUrl,
  allowedDomains,
  apiHints = [],
  existingContracts = [],
  storageState = null,
  maxProbes = DEFAULT_MAX_PROBES,
  delayMs = DEFAULT_DELAY_MS,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  fetchImpl = fetchResource,
} = {}) {
  const have = new Set(
    (existingContracts || []).map((c) => `${String(c.method || "GET").toUpperCase()} ${stripQuery(String(c.endpoint || c.path || ""))}`),
  );
  const stats = { probed: 0, verified: 0, gated: 0, stale: 0, skippedWrite: 0, skippedTemplated: 0, skippedKnown: 0, errors: 0, templatedVerified: 0 };
  const contracts = [];
  const warnings = [];
  const harvestedIds = new Set();
  const templatedGetHints = [];
  const headersFor = (url) => {
    const cookie = storageState ? cookieHeaderFor(url, storageState) : "";
    return { accept: "application/json", ...(cookie ? { cookie } : {}) };
  };

  const record = (entry) => contracts.push(entry);
  let budget = Math.max(1, Number(maxProbes) || DEFAULT_MAX_PROBES);

  async function probeGet(p, { templated = false } = {}) {
    const url = joinUrl(baseUrl, p);
    if (!isUrlAllowed(url, allowedDomains)) return null;
    if (budget <= 0) return "budget";
    budget -= 1;
    stats.probed += 1;
    let res;
    try {
      res = await fetchImpl(url, { headers: headersFor(url), method: "GET", timeoutMs });
    } catch {
      stats.errors += 1;
      return null;
    }
    if (delayMs) await sleep(delayMs);
    const status = Number(res?.status || 0);
    if (status === 401 || status === 403) {
      record({ id: contractId("GET", p), source: "probe", endpoint: p, method: "GET", risk: "read", verified: false, access: "forbidden", note: "exists but no permission (403) — respected, not bypassed" });
      stats.gated += 1;
      return "gated";
    }
    if (status < 200 || status >= 300) { stats.stale += 1; return "stale"; }
    const body = res.json;
    if (body === undefined || body === null) { stats.stale += 1; return "stale"; } // non-JSON GET = a page, not an API
    harvestIds(body, harvestedIds);
    const responseSchema = inferSchema([body]);
    record({
      id: contractId("GET", p),
      source: "probe",
      endpoint: p,
      method: "GET",
      risk: "read",
      contentType: "query",
      requestFields: [],
      responseSchema,
      verified: true,
      confidence: "high",
      note: templated ? "detail endpoint verified via harvested id (read-only)" : "verified via read-only probe",
    });
    stats[templated ? "templatedVerified" : "verified"] += 1;
    return "verified";
  }

  // Phase 1 — concrete GET hints (also harvests ids for phase 2).
  for (const hint of apiHints) {
    const p = String(hint?.path || "").trim();
    if (!p.startsWith("/")) continue;
    const method = String(hint?.method || "GET").toUpperCase();
    if (have.has(`${method} ${stripQuery(p)}`)) { stats.skippedKnown += 1; continue; }
    if (!READ_METHODS.has(method)) {
      record({ id: contractId(method, p), source: "frontend-hint", endpoint: p, method, risk: riskFor(method), verified: false, note: "write endpoint — hinted only, NOT probed (mutation-unsafe)" });
      stats.skippedWrite += 1;
      continue;
    }
    if (isTemplated(p)) { templatedGetHints.push(p); continue; }
    if ((await probeGet(p)) === "budget") { warnings.push(`probe budget (${maxProbes}) reached before templated pass; coverage may be partial`); break; }
  }

  // Phase 2 — parameter-space: fill templated GET detail endpoints with a real id.
  for (const p of templatedGetHints) {
    if (have.has(`GET ${stripQuery(p)}`)) { stats.skippedKnown += 1; continue; }
    const ids = [...harvestedIds].slice(0, MAX_TEMPLATE_ATTEMPTS);
    if (!ids.length) {
      record({ id: contractId("GET", p), source: "frontend-hint", endpoint: p, method: "GET", risk: "read", verified: false, note: "templated path — no id harvested to probe it" });
      stats.skippedTemplated += 1;
      continue;
    }
    let done = false;
    for (const id of ids) {
      const filled = fillTemplate(p, id);
      if (!filled) { stats.skippedTemplated += 1; done = true; break; }
      const r = await probeGet(filled, { templated: true });
      if (r === "budget") { warnings.push(`probe budget (${maxProbes}) reached in templated pass; coverage may be partial`); done = true; break; }
      if (r === "verified" || r === "gated") {
        // relabel the endpoint as the TEMPLATE (not the concrete filled url)
        const last = contracts[contracts.length - 1];
        if (last) { last.endpoint = p; last.id = contractId("GET", p); }
        done = true;
        break;
      }
      // stale/404 with this id → try the next harvested id
    }
    if (!done) stats.skippedTemplated += 1;
  }

  return { ok: true, kind: "probe-coverage", baseUrl, allowedDomains, contracts, warnings, stats };
}

// Merge probed contracts into an api-contracts.json WITHOUT overriding earlier
// (authoritative/HAR) contracts, keyed by method+endpoint.
function mergeProbe(existing, probeResult, baseUrl, allowedDomains) {
  const out = existing && existing.ok
    ? { ...existing, contracts: [...(existing.contracts || [])] }
    : { ok: true, schemaVersion: 1, baseUrl, allowedDomains, sources: [], contracts: [], dataSchemas: {}, coverage: {}, warnings: [] };
  const have = new Set(out.contracts.map((c) => `${String(c.method).toUpperCase()} ${stripQuery(String(c.endpoint || ""))}`));
  let added = 0;
  for (const contract of probeResult.contracts) {
    const key = `${String(contract.method).toUpperCase()} ${stripQuery(String(contract.endpoint || ""))}`;
    if (have.has(key)) continue;
    out.contracts.push(contract);
    have.add(key);
    added += 1;
  }
  out.sources = [...(out.sources || []), { kind: "probe", endpointCount: probeResult.contracts.length, mergedNew: added, stats: probeResult.stats }];
  out.warnings = [...(out.warnings || []), ...(probeResult.warnings || [])];
  out.coverage = { ...(out.coverage || {}), endpointCount: out.contracts.length, probeVerified: probeResult.stats.verified + probeResult.stats.templatedVerified, probeGated: probeResult.stats.gated };
  return out;
}

module.exports = { probeApiCoverage, mergeProbe, harvestIds, fillTemplate, isTemplated };

// ----------------------------------------------------------------------------- CLI
if (require.main === module) {
  (async () => {
    const argv = process.argv.slice(2);
    const args = { allowedDomains: [] };
    for (let i = 0; i < argv.length; i += 1) {
      const a = argv[i];
      if (a === "--base-url") args.baseUrl = argv[++i];
      else if (a === "--allow-domain") args.allowedDomains.push(argv[++i]);
      else if (a === "--frontend-source") args.frontendSource = argv[++i];
      else if (a === "--contracts") args.contracts = argv[++i];
      else if (a === "--storage-state") args.storageState = argv[++i];
      else if (a === "--out") args.out = argv[++i];
      else if (a === "--max-probes") args.maxProbes = Number(argv[++i]);
      else if (a === "--delay-ms") args.delayMs = Number(argv[++i]);
    }
    if (!args.baseUrl || !args.frontendSource) {
      console.error("Usage: node probe_api_coverage.cjs --base-url <url> --allow-domain <host> --frontend-source frontend-source-map.json [--contracts api-contracts.json] [--storage-state session.json] [--out api-contracts.json] [--max-probes 80]");
      process.exit(2);
    }
    const readJson = (f) => { try { return JSON.parse(fs.readFileSync(path.resolve(f), "utf8")); } catch { return null; } };
    const fsm = readJson(args.frontendSource) || {};
    const existing = args.contracts ? readJson(args.contracts) : null;
    const storageState = args.storageState ? readJson(args.storageState) : null;
    const result = await probeApiCoverage({
      baseUrl: args.baseUrl,
      allowedDomains: args.allowedDomains,
      apiHints: Array.isArray(fsm.apiHints) ? fsm.apiHints : [],
      existingContracts: existing?.contracts || [],
      storageState,
      maxProbes: args.maxProbes,
      delayMs: args.delayMs,
    });
    const merged = mergeProbe(existing, result, args.baseUrl, args.allowedDomains);
    const json = JSON.stringify(merged, null, 2);
    if (args.out) fs.writeFileSync(path.resolve(args.out), json, "utf8");
    console.error(`[probe] ${JSON.stringify(result.stats)}`);
    if (!args.out) console.log(json);
  })().catch((err) => { console.error(String(err?.message || err)); process.exit(1); });
}
