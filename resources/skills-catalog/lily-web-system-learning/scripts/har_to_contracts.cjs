#!/usr/bin/env node
"use strict";

/**
 * Learn API contracts from real captured traffic (a Playwright HAR), for systems
 * that do NOT publish an OpenAPI/GraphQL contract and for write-path endpoints
 * (POST/PUT/PATCH/DELETE) that only fire when a flow is exercised.
 *
 * It groups HAR entries by method+endpoint, then infers a JSON Schema for the
 * request and response from the observed samples (types, enums for small value
 * sets, required = present in every sample). Secrets are redacted, the domain
 * allowlist is enforced, and results merge into an existing api-contracts.json
 * WITHOUT overriding authoritative (published) contracts — HAR only fills gaps.
 *
 * Pure inference is deterministic and unit-tested; only the upstream HAR capture
 * needs a real browser.
 */

const fs = require("node:fs");
const path = require("node:path");
const { normalizeHost, isUrlAllowed, responseShapeFromSchema } = require("./discover_contracts.cjs");

const SENSITIVE_KEY_RE =
  /(authorization|cookie|token|secret|api[-_]?key|apikey|password|credential|session)/i;
const MAX_SAMPLES_PER_ENDPOINT = 25;
const MAX_DEPTH = 8;
const MAX_ENUM = 12;

// ---------------------------------------------------------------------------
// Sample-based JSON Schema inference (genson-style merge over observed values)
// ---------------------------------------------------------------------------

function typeOf(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (Number.isInteger(value)) return "integer";
  if (typeof value === "number") return "number";
  return typeof value; // string | boolean | object
}

/** Infer a JSON Schema from one or more observed sample values. */
function inferSchema(samples, depth = 0) {
  const values = samples.filter((v) => v !== undefined);
  if (!values.length || depth > MAX_DEPTH) return {};
  const types = new Set(values.map(typeOf));
  const nullable = types.delete("null") || false;

  // Object: merge property sets, required = present in every (non-null) sample.
  if (types.has("object") && types.size === 1) {
    const objects = values.filter((v) => v && typeof v === "object" && !Array.isArray(v));
    const keyCounts = new Map();
    const byKey = new Map();
    for (const obj of objects) {
      for (const key of Object.keys(obj)) {
        keyCounts.set(key, (keyCounts.get(key) || 0) + 1);
        if (!byKey.has(key)) byKey.set(key, []);
        byKey.get(key).push(obj[key]);
      }
    }
    const properties = {};
    const required = [];
    for (const [key, vals] of byKey) {
      if (SENSITIVE_KEY_RE.test(key)) {
        properties[key] = { type: "string", description: "redacted-sensitive" };
      } else {
        properties[key] = inferSchema(vals, depth + 1);
      }
      if (keyCounts.get(key) === objects.length) required.push(key);
    }
    const schema = { type: "object", properties };
    if (required.length) schema.required = required;
    if (nullable) schema.nullable = true;
    return schema;
  }

  // Array: merge element schemas.
  if (types.has("array") && types.size === 1) {
    const items = [];
    for (const arr of values) for (const el of arr.slice(0, 20)) items.push(el);
    const schema = { type: "array", items: inferSchema(items, depth + 1) };
    if (nullable) schema.nullable = true;
    return schema;
  }

  // Scalar(s): pick the widest numeric type; collect a small enum if applicable.
  let type = [...types][0] || "string";
  if (types.has("number") && types.has("integer")) type = "number";
  else if (types.size > 1) type = "string";
  const schema = { type };
  if (type === "string" || type === "integer" || type === "number") {
    const distinct = [...new Set(values.map((v) => (typeof v === "object" ? JSON.stringify(v) : v)))];
    if (distinct.length > 1 && distinct.length <= MAX_ENUM && values.length >= distinct.length) {
      schema.enum = distinct.slice(0, MAX_ENUM);
    }
  }
  if (nullable) schema.nullable = true;
  return schema;
}

function requestFieldsFromSchema(schema) {
  if (!schema || schema.type !== "object" || !schema.properties) return [];
  const required = new Set(Array.isArray(schema.required) ? schema.required : []);
  return Object.entries(schema.properties)
    .filter(([name]) => !SENSITIVE_KEY_RE.test(name))
    .map(([name, prop]) => ({
      name,
      in: "body",
      type: prop.type || "string",
      required: required.has(name),
      enum: Array.isArray(prop.enum) ? prop.enum.slice(0, MAX_ENUM) : undefined,
    }))
    .slice(0, 120);
}

// ---------------------------------------------------------------------------
// HAR parsing
// ---------------------------------------------------------------------------

function parseBody(raw, mimeType) {
  if (raw === undefined || raw === null || raw === "") return undefined;
  const text = String(raw);
  if (/json/i.test(String(mimeType || "")) || /^\s*[[{]/.test(text)) {
    try {
      return JSON.parse(text);
    } catch {
      return undefined;
    }
  }
  if (/x-www-form-urlencoded/i.test(String(mimeType || ""))) {
    const obj = {};
    for (const [k, v] of new URLSearchParams(text)) obj[k] = v;
    return obj;
  }
  return undefined;
}

// SPAs commonly fetch lists/details via POST with a filter body (e.g.
// POST /api/tasks/my/query). Classify those query-style POSTs as read, not submit,
// so they aren't gated behind confirmation and the action/operation risks stay
// consistent (the executor rejects a read action that contains a submit-risk op).
const QUERY_PATH_RE = /\/(query|queries|search|list|lists|filter|lookup|find|report|reports|stats|statistics|page|browse|export)(?:[/?]|$)/i;
function methodRisk(method, endpoint = "") {
  if (method === "GET" || method === "HEAD") return "read";
  if ((method === "POST" || method === "PUT") && QUERY_PATH_RE.test(String(endpoint || ""))) return "read";
  return "submit";
}

function stripQuery(url) {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  } catch {
    return String(url || "");
  }
}

// Detect a pagination shape from the request's query keys + the response schema.
// Conservative: only emits when an items array AND a paging mechanism are both
// recognized. This is a HINT carried on the contract — the planner copies it into
// op.pagination only when the user actually wants all/every/a full export, so a
// single-page read never over-fetches. Returns undefined when unsure.
const ITEMS_PREFERRED = ["data", "rows", "items", "list", "records", "results", "content"];
function detectPagination(queryKeys, responseSchema) {
  if (!responseSchema || responseSchema.type !== "object" || !responseSchema.properties) return undefined;
  const props = responseSchema.properties;
  const arrayKeys = Object.keys(props).filter((k) => props[k] && props[k].type === "array");
  if (!arrayKeys.length) return undefined;
  const itemsPath = arrayKeys.find((k) => ITEMS_PREFERRED.includes(k.toLowerCase())) || (arrayKeys.length === 1 ? arrayKeys[0] : undefined);
  if (!itemsPath) return undefined; // multiple arrays, none recognized → not confident

  const nextKey = Object.keys(props).find((k) => /^(next|nextcursor|next_cursor|nexttoken|next_token|nextpage|next_page|cursor)$/i.test(k));
  const qk = [...queryKeys];
  const cursorParam = qk.find((k) => /^(cursor|next|nexttoken|next_token|pagetoken|page_token)$/i.test(k));
  const pageParam = qk.find((k) => /^(page|pageno|pagenum|pageindex|p)$/i.test(k));
  const offsetParam = qk.find((k) => /^(offset|skip|start)$/i.test(k));

  if (cursorParam && nextKey) return { mode: "cursor", param: cursorParam, itemsPath, nextPath: nextKey };
  if (pageParam) return { mode: "page", param: pageParam, itemsPath, start: 1 };
  if (offsetParam) return { mode: "offset", param: offsetParam, itemsPath, start: 0 };
  if (nextKey) return { mode: "cursor", param: "cursor", itemsPath, nextPath: nextKey };
  return undefined;
}

function harToContracts(har, baseUrl, allowedDomains) {
  const entries = har?.log?.entries;
  const warnings = [];
  if (!Array.isArray(entries)) return { ok: false, contracts: [], dataSchemas: {}, warnings: ["NOT_A_HAR"] };

  // group by method + endpoint(without query)
  const groups = new Map();
  for (const entry of entries) {
    const req = entry?.request;
    const res = entry?.response;
    if (!req?.url || !req?.method) continue;
    if (!isUrlAllowed(req.url, allowedDomains)) continue;
    const resourceType = String(entry._resourceType || "").toLowerCase();
    // Only API-like traffic; skip static assets.
    if (resourceType && !["xhr", "fetch", "document"].includes(resourceType)) continue;
    const respMime = res?.content?.mimeType || "";
    if (resourceType === "" && respMime && !/json/i.test(respMime)) continue;

    const method = String(req.method).toUpperCase();
    const endpoint = stripQuery(req.url);
    const key = `${method} ${endpoint}`;
    if (!groups.has(key)) groups.set(key, { method, endpoint, reqSamples: [], resSamples: [], statuses: new Set(), queryKeys: new Set() });
    const g = groups.get(key);
    try {
      for (const qk of new URL(req.url).searchParams.keys()) g.queryKeys.add(qk.toLowerCase());
    } catch {
      /* unparseable url — skip query-key capture */
    }
    if (g.reqSamples.length < MAX_SAMPLES_PER_ENDPOINT) {
      const reqBody = parseBody(req.postData?.text, req.postData?.mimeType);
      if (reqBody !== undefined) g.reqSamples.push(reqBody);
    }
    if (res) {
      g.statuses.add(res.status);
      // Only learn the response shape from successful calls.
      if (res.status >= 200 && res.status < 300 && g.resSamples.length < MAX_SAMPLES_PER_ENDPOINT) {
        const resBody = parseBody(res.content?.text, respMime);
        if (resBody !== undefined) g.resSamples.push(resBody);
      }
    }
  }

  const contracts = [];
  for (const [, g] of groups) {
    const requestSchema = g.reqSamples.length ? inferSchema(g.reqSamples) : undefined;
    const responseSchema = g.resSamples.length ? inferSchema(g.resSamples) : undefined;
    const id = `har-${g.method}-${g.endpoint}`.replace(/[^a-z0-9]+/gi, "-").toLowerCase().replace(/^-+|-+$/g, "").slice(0, 80);
    const pagination = (g.method === "GET" || g.method === "HEAD") ? detectPagination(g.queryKeys, responseSchema) : undefined;
    contracts.push({
      id,
      source: "har",
      authoritative: false,
      endpoint: g.endpoint,
      method: g.method,
      risk: methodRisk(g.method, g.endpoint),
      contentType: g.method === "GET" || g.method === "HEAD" ? "query" : "json",
      requestFields: requestSchema ? requestFieldsFromSchema(requestSchema) : [],
      requestSchema,
      responseSchema,
      responseShape: responseSchema ? responseShapeFromSchema(responseSchema) : {},
      observedStatuses: [...g.statuses].sort((a, b) => a - b),
      sampleCount: g.reqSamples.length + g.resSamples.length,
      ...(pagination ? { pagination } : {}),
    });
  }
  return { ok: true, kind: "har", contracts, dataSchemas: {}, warnings };
}

// ---------------------------------------------------------------------------
// Merge into an existing api-contracts.json (authoritative wins)
// ---------------------------------------------------------------------------

function mergeContracts(existing, harResult, baseUrl, allowedDomains) {
  const out = existing && existing.ok
    ? { ...existing, contracts: [...(existing.contracts || [])] }
    : { ok: true, schemaVersion: 1, baseUrl, allowedDomains, sources: [], contracts: [], dataSchemas: {}, coverage: {}, warnings: [] };
  const have = new Set(out.contracts.map((c) => `${String(c.method).toUpperCase()} ${stripQuery(c.endpoint)}`));
  let added = 0;
  for (const contract of harResult.contracts) {
    const key = `${contract.method} ${stripQuery(contract.endpoint)}`;
    if (have.has(key)) continue; // never override an authoritative/earlier contract
    out.contracts.push(contract);
    have.add(key);
    added += 1;
  }
  out.sources = [...(out.sources || []), { kind: "har", endpointCount: harResult.contracts.length, mergedNew: added }];
  out.warnings = [...(out.warnings || []), ...harResult.warnings];
  out.coverage = {
    ...(out.coverage || {}),
    endpointCount: out.contracts.length,
    harLearned: harResult.contracts.length,
    harWriteEndpoints: harResult.contracts.filter((c) => c.risk !== "read").length,
  };
  return out;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = { har: null, baseUrl: "", allowDomains: [], merge: null, out: null };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--har") args.har = argv[++i];
    else if (arg === "--base-url") args.baseUrl = argv[++i];
    else if (arg === "--allow-domain") args.allowDomains.push(normalizeHost(argv[++i]));
    else if (arg === "--allowlist") args.allowDomains.push(...String(argv[++i] || "").split(",").map(normalizeHost).filter(Boolean));
    else if (arg === "--merge") args.merge = argv[++i];
    else if (arg === "--out") args.out = argv[++i];
    else if (arg === "--help" || arg === "-h") {
      console.log("Usage: node har_to_contracts.cjs --har scan.har --base-url <url> --allow-domain <host> [--merge api-contracts.json] [--out api-contracts.json]");
      process.exit(0);
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!args.har) throw new Error("Missing --har");
  if (!args.baseUrl) throw new Error("Missing --base-url");
  if (!args.allowDomains.length) args.allowDomains = [normalizeHost(args.baseUrl)];
  return args;
}

function main() {
  const args = parseArgs(process.argv);
  const har = JSON.parse(fs.readFileSync(path.resolve(args.har), "utf8"));
  const harResult = harToContracts(har, args.baseUrl, args.allowDomains);
  const existing = args.merge && fs.existsSync(path.resolve(args.merge)) ? JSON.parse(fs.readFileSync(path.resolve(args.merge), "utf8")) : null;
  const output = mergeContracts(existing, harResult, args.baseUrl, args.allowDomains);
  const json = JSON.stringify(output, null, 2);
  if (args.out) fs.writeFileSync(path.resolve(args.out), `${json}\n`);
  else process.stdout.write(`${json}\n`);
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    process.stderr.write(`${JSON.stringify({ ok: false, error: String(err?.message || err) })}\n`);
    process.exit(1);
  }
}

module.exports = { inferSchema, requestFieldsFromSchema, parseBody, harToContracts, mergeContracts, stripQuery };
