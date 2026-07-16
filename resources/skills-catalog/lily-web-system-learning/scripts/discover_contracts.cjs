#!/usr/bin/env node
"use strict";

/**
 * L1 contract discovery — "stand on the system's own published contract".
 *
 * Before reverse-engineering a site from DOM/HAR, ask whether the backend
 * already publishes a machine-readable contract. When it does, that is an
 * authoritative, complete source of APIs + data structures (types, enums,
 * required, nullability) — strictly better than sample-based inference.
 *
 * This tool probes for and normalizes:
 *   - OpenAPI 3.x and Swagger 2.0 documents
 *   - GraphQL introspection
 * into a canonical `api-contracts.json` consumed by create_web_system_skill.cjs.
 *
 * Safety mirrors the rest of this skill: domain allowlist enforced on every
 * request and every emitted endpoint, read-only probes (GET + a single GraphQL
 * introspection POST), secrets redacted out of every schema, never persisting
 * raw cookies/tokens. Auth is reused from a Playwright storageState file — the
 * tool never asks for or stores credentials.
 */

const fs = require("node:fs");
const path = require("node:path");

const SCHEMA_VERSION = 1;
const SENSITIVE_KEY_RE =
  /(authorization|cookie|token|secret|api[-_]?key|apikey|password|credential|session)/i;
const MAX_ENDPOINTS = 1000;
const MAX_SCHEMA_DEPTH = 8;
const DEFAULT_TIMEOUT_MS = 20000;
const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;

// Common locations enterprise stacks expose their OpenAPI/Swagger document.
const OPENAPI_CANDIDATE_PATHS = [
  "/openapi.json",
  "/swagger.json",
  "/v3/api-docs",
  "/v2/api-docs",
  "/swagger/v1/swagger.json",
  "/api-docs",
  "/api/openapi.json",
  "/api/swagger.json",
  "/api/v1/openapi.json",
  "/docs/openapi.json",
];
const GRAPHQL_CANDIDATE_PATHS = ["/graphql", "/api/graphql", "/query"];

// ---------------------------------------------------------------------------
// URL / allowlist helpers
// ---------------------------------------------------------------------------

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
  if (!host) return false;
  return allowedDomains.includes(host) || allowedDomains.some((d) => host.endsWith(`.${d}`));
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

function joinUrl(base, ref) {
  try {
    return new URL(ref, base).href;
  } catch {
    return "";
  }
}

// ---------------------------------------------------------------------------
// Auth: reuse a Playwright storageState's cookies as a Cookie header, without
// ever persisting them anywhere.
// ---------------------------------------------------------------------------

function cookieHeaderFor(url, storageState) {
  if (!storageState || !Array.isArray(storageState.cookies)) return "";
  let host;
  let pathname;
  try {
    const parsed = new URL(url);
    host = parsed.hostname.toLowerCase();
    pathname = parsed.pathname || "/";
  } catch {
    return "";
  }
  const pairs = [];
  for (const cookie of storageState.cookies) {
    if (!cookie || !cookie.name) continue;
    const domain = String(cookie.domain || "").replace(/^\./, "").toLowerCase();
    if (!domain) continue;
    if (host !== domain && !host.endsWith(`.${domain}`)) continue;
    const cookiePath = String(cookie.path || "/");
    if (!pathname.startsWith(cookiePath)) continue;
    pairs.push(`${cookie.name}=${cookie.value}`);
  }
  return pairs.join("; ");
}

// ---------------------------------------------------------------------------
// Network (read-only, capped, never throws)
// ---------------------------------------------------------------------------

async function fetchResource(url, { headers = {}, method = "GET", body, timeoutMs, maxBytes } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs || DEFAULT_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method,
      headers,
      body,
      redirect: "follow",
      signal: controller.signal,
    });
    const contentType = String(res.headers.get("content-type") || "").toLowerCase();
    const reader = res.body?.getReader?.();
    let text = "";
    if (reader) {
      const decoder = new TextDecoder();
      let received = 0;
      const cap = maxBytes || DEFAULT_MAX_BYTES;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        received += value.byteLength;
        if (received > cap) {
          await reader.cancel();
          return { ok: false, status: res.status, error: "RESPONSE_TOO_LARGE" };
        }
        text += decoder.decode(value, { stream: true });
      }
      text += decoder.decode();
    } else {
      text = await res.text();
    }
    let json = null;
    if (contentType.includes("json") || /^\s*[[{]/.test(text)) {
      try {
        json = JSON.parse(text);
      } catch {
        json = null;
      }
    }
    return { ok: res.ok, status: res.status, contentType, json, text };
  } catch (err) {
    return { ok: false, status: 0, error: err?.name === "AbortError" ? "TIMEOUT" : String(err?.message || err) };
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// JSON Schema helpers: $ref resolution, type extraction, secret redaction
// ---------------------------------------------------------------------------

function refName(ref) {
  return String(ref || "").split("/").pop() || "";
}

/** Resolve a local $ref against the document root (no remote refs). */
function lookupRef(root, ref) {
  if (typeof ref !== "string" || !ref.startsWith("#/")) return null;
  const parts = ref.slice(2).split("/").map((p) => p.replace(/~1/g, "/").replace(/~0/g, "~"));
  let node = root;
  for (const part of parts) {
    if (!node || typeof node !== "object") return null;
    node = node[part];
  }
  return node && typeof node === "object" ? node : null;
}

/**
 * Inline local $refs into a self-contained schema, redacting sensitive keys.
 * Bounded depth + cycle guard; on a revisited ref we emit a `$ref` marker so
 * the structure stays finite without losing the type name.
 */
function derefSchema(schema, root, depth = 0, stack = []) {
  if (!schema || typeof schema !== "object") return schema;
  if (typeof schema.$ref === "string") {
    const name = refName(schema.$ref);
    if (stack.includes(schema.$ref) || depth >= MAX_SCHEMA_DEPTH) {
      return { $ref: name };
    }
    const target = lookupRef(root, schema.$ref);
    if (!target) return { $ref: name };
    return derefSchema(target, root, depth + 1, [...stack, schema.$ref]);
  }
  if (Array.isArray(schema)) {
    return schema.slice(0, 200).map((item) => derefSchema(item, root, depth + 1, stack));
  }
  const out = {};
  for (const [key, value] of Object.entries(schema)) {
    if (key === "properties" && value && typeof value === "object") {
      const props = {};
      for (const [propName, propSchema] of Object.entries(value)) {
        if (SENSITIVE_KEY_RE.test(propName)) {
          props[propName] = { type: "string", description: "redacted-sensitive" };
          continue;
        }
        props[propName] = derefSchema(propSchema, root, depth + 1, stack);
      }
      out.properties = props;
    } else if (key === "$ref") {
      out.$ref = refName(value);
    } else if (value && typeof value === "object") {
      out[key] = derefSchema(value, root, depth + 1, stack);
    } else {
      out[key] = value;
    }
  }
  return out;
}

function jsonType(schema) {
  if (!schema || typeof schema !== "object") return "string";
  if (Array.isArray(schema.type)) return schema.type.find((t) => t !== "null") || "string";
  if (schema.type) return schema.type;
  if (schema.properties) return "object";
  if (schema.items) return "array";
  if (schema.enum) return typeof schema.enum[0] === "number" ? "number" : "string";
  return "string";
}

/** Shallow {field: "<type>"} skeleton for quick human/agent display. */
function responseShapeFromSchema(schema, depth = 0) {
  if (!schema || typeof schema !== "object" || depth > 3) return "<any>";
  const type = jsonType(schema);
  if (type === "object" && schema.properties) {
    const shape = {};
    for (const [name, prop] of Object.entries(schema.properties).slice(0, 40)) {
      shape[name] = responseShapeFromSchema(prop, depth + 1);
    }
    return shape;
  }
  if (type === "array") {
    return [responseShapeFromSchema(schema.items || {}, depth + 1)];
  }
  return `<${type}>`;
}

// ---------------------------------------------------------------------------
// OpenAPI / Swagger normalization
// ---------------------------------------------------------------------------

function detectOpenApi(doc) {
  if (!doc || typeof doc !== "object") return null;
  if (typeof doc.openapi === "string" && doc.openapi.startsWith("3")) return "openapi3";
  if (doc.swagger === "2.0" || doc.swagger === 2) return "swagger2";
  return null;
}

function openApiBaseUrls(doc, kind, fallbackBaseUrl) {
  if (kind === "openapi3") {
    const servers = Array.isArray(doc.servers) ? doc.servers : [];
    const urls = servers
      .map((s) => (s && typeof s.url === "string" ? joinUrl(fallbackBaseUrl, s.url) : ""))
      .filter(Boolean);
    return urls.length ? urls : [fallbackBaseUrl];
  }
  // swagger 2.0: host + basePath + schemes
  const schemes = Array.isArray(doc.schemes) && doc.schemes.length ? doc.schemes : [new URL(fallbackBaseUrl).protocol.replace(":", "")];
  const host = doc.host || new URL(fallbackBaseUrl).host;
  const basePath = doc.basePath || "";
  return schemes.map((scheme) => `${scheme}://${host}${basePath}`);
}

function schemaForBody(operation, doc, kind) {
  if (kind === "openapi3") {
    const content = operation.requestBody?.content || {};
    const json = content["application/json"] || content[Object.keys(content)[0]];
    return json?.schema ? derefSchema(json.schema, doc) : null;
  }
  const bodyParam = (operation.parameters || []).find((p) => p && p.in === "body");
  return bodyParam?.schema ? derefSchema(bodyParam.schema, doc) : null;
}

function responseSchema(operation, doc, kind) {
  const responses = operation.responses || {};
  const key = Object.keys(responses).find((k) => /^2\d\d$/.test(k)) || "default";
  const resp = responses[key];
  if (!resp) return null;
  if (kind === "openapi3") {
    const content = resp.content || {};
    const json = content["application/json"] || content[Object.keys(content)[0]];
    return json?.schema ? derefSchema(json.schema, doc) : null;
  }
  return resp.schema ? derefSchema(resp.schema, doc) : null;
}

/** Flatten an operation's inputs into requestFields the generator can turn into params. */
function requestFieldsFor(operation, doc, kind) {
  const fields = [];
  const seen = new Set();
  const push = (field) => {
    if (!field.name || seen.has(`${field.in}:${field.name}`)) return;
    if (SENSITIVE_KEY_RE.test(field.name)) return;
    seen.add(`${field.in}:${field.name}`);
    fields.push(field);
  };
  for (const param of operation.parameters || []) {
    if (!param || param.in === "header" || param.in === "cookie" || param.in === "body") continue;
    const schema = kind === "openapi3" ? derefSchema(param.schema || {}, doc) : param;
    push({
      name: String(param.name || "").trim(),
      in: param.in || "query",
      type: jsonType(schema),
      required: Boolean(param.required),
      enum: Array.isArray(schema.enum) ? schema.enum.slice(0, 40) : undefined,
    });
  }
  const body = schemaForBody(operation, doc, kind);
  if (body && body.properties) {
    const required = new Set(Array.isArray(body.required) ? body.required : []);
    for (const [name, prop] of Object.entries(body.properties)) {
      push({
        name,
        in: "body",
        type: jsonType(prop),
        required: required.has(name),
        enum: Array.isArray(prop.enum) ? prop.enum.slice(0, 40) : undefined,
      });
    }
  }
  return fields.slice(0, 120);
}

function methodRisk(method) {
  return method === "GET" || method === "HEAD" ? "read" : "submit";
}

function normalizeOpenApi(doc, fallbackBaseUrl, allowedDomains, sourceUrl = "") {
  const kind = detectOpenApi(doc);
  const warnings = [];
  if (!kind) return { ok: false, contracts: [], dataSchemas: {}, warnings: ["NOT_OPENAPI"] };

  const bases = openApiBaseUrls(doc, kind, fallbackBaseUrl);
  const contracts = [];
  const dataSchemas = {};

  const schemaContainer = kind === "openapi3" ? doc.components?.schemas : doc.definitions;
  for (const [name, schema] of Object.entries(schemaContainer || {})) {
    dataSchemas[name] = derefSchema(schema, doc);
    if (Object.keys(dataSchemas).length >= 500) break;
  }

  const paths = doc.paths || {};
  outer: for (const [routePath, pathItem] of Object.entries(paths)) {
    if (!pathItem || typeof pathItem !== "object") continue;
    for (const method of ["get", "post", "put", "patch", "delete", "head"]) {
      const operation = pathItem[method];
      if (!operation || typeof operation !== "object") continue;
      const endpoint = bases
        .map((b) => joinUrl(b.endsWith("/") ? b : `${b}/`, routePath.replace(/^\//, "")))
        .find((u) => isUrlAllowed(u, allowedDomains));
      if (!endpoint) {
        warnings.push(`SKIPPED_OUT_OF_ALLOWLIST:${method.toUpperCase()} ${routePath}`);
        continue;
      }
      const upper = method.toUpperCase();
      const respSchema = responseSchema(operation, doc, kind);
      const reqSchema = schemaForBody(operation, doc, kind);
      const operationId = String(operation.operationId || "").trim();
      const id = (operationId || `${method}-${routePath}`)
        .replace(/[^a-z0-9]+/gi, "-")
        .toLowerCase()
        .replace(/^-+|-+$/g, "")
        .slice(0, 80);
      contracts.push({
        id,
        source: "openapi",
        authoritative: true,
        endpoint,
        method: upper,
        risk: methodRisk(upper),
        operationId: operationId || undefined,
        summary: String(operation.summary || operation.description || "").trim().slice(0, 200) || undefined,
        contentType: upper === "GET" || upper === "HEAD" ? "query" : "json",
        requestFields: requestFieldsFor(operation, doc, kind),
        requestSchema: reqSchema || undefined,
        responseSchema: respSchema || undefined,
        responseShape: respSchema ? responseShapeFromSchema(respSchema) : {},
        deprecated: Boolean(operation.deprecated) || undefined,
        sourceDoc: sourceUrl || undefined,
      });
      if (contracts.length >= MAX_ENDPOINTS) {
        warnings.push("ENDPOINT_CAP_REACHED");
        break outer;
      }
    }
  }

  return {
    ok: true,
    kind,
    title: String(doc.info?.title || "").trim(),
    version: String(doc.info?.version || "").trim(),
    contracts,
    dataSchemas,
    warnings,
  };
}

// ---------------------------------------------------------------------------
// GraphQL introspection normalization
// ---------------------------------------------------------------------------

const GRAPHQL_INTROSPECTION_QUERY = JSON.stringify({
  query:
    "query IntrospectionQuery{__schema{queryType{name}mutationType{name}types{kind name fields{name args{name type{kind name ofType{kind name ofType{kind name}}}}type{kind name ofType{kind name ofType{kind name}}}}inputFields{name type{kind name ofType{kind name}}}enumValues{name}}}}",
});

function gqlTypeRef(typeRef) {
  let node = typeRef;
  let required = false;
  let list = false;
  while (node) {
    if (node.kind === "NON_NULL") required = true;
    if (node.kind === "LIST") list = true;
    if (node.name) return { name: node.name, required, list };
    node = node.ofType;
  }
  return { name: "Unknown", required, list };
}

function gqlScalarType(name) {
  if (name === "Int" || name === "Float") return "number";
  if (name === "Boolean") return "boolean";
  return "string";
}

function normalizeGraphQLIntrospection(introspection, endpoint, allowedDomains) {
  const warnings = [];
  if (!isUrlAllowed(endpoint, allowedDomains)) {
    return { ok: false, contracts: [], dataSchemas: {}, warnings: ["GRAPHQL_OUT_OF_ALLOWLIST"] };
  }
  const schema = introspection?.data?.__schema || introspection?.__schema;
  if (!schema || !Array.isArray(schema.types)) {
    return { ok: false, contracts: [], dataSchemas: {}, warnings: ["NOT_GRAPHQL_INTROSPECTION"] };
  }
  const typeByName = new Map(schema.types.map((t) => [t.name, t]));
  const dataSchemas = {};
  for (const type of schema.types) {
    if (!type.name || type.name.startsWith("__")) continue;
    if (type.kind === "OBJECT" || type.kind === "INPUT_OBJECT" || type.kind === "ENUM") {
      if (type.kind === "ENUM") {
        dataSchemas[type.name] = { type: "string", enum: (type.enumValues || []).map((v) => v.name) };
      } else {
        const props = {};
        const fields = type.kind === "INPUT_OBJECT" ? type.inputFields || [] : type.fields || [];
        for (const field of fields) {
          if (SENSITIVE_KEY_RE.test(field.name)) continue;
          const ref = gqlTypeRef(field.type);
          props[field.name] = ref.list ? { type: "array", items: { type: gqlScalarType(ref.name) } } : { type: gqlScalarType(ref.name) };
        }
        dataSchemas[type.name] = { type: "object", properties: props };
      }
    }
    if (Object.keys(dataSchemas).length >= 500) break;
  }

  const contracts = [];
  const rootFor = (rootName, risk) => {
    const root = rootName ? typeByName.get(rootName) : null;
    for (const field of root?.fields || []) {
      if (!field.name || SENSITIVE_KEY_RE.test(field.name)) continue;
      const requestFields = (field.args || []).map((arg) => {
        const ref = gqlTypeRef(arg.type);
        return { name: arg.name, in: "graphql-arg", type: gqlScalarType(ref.name), required: ref.required };
      });
      const retRef = gqlTypeRef(field.type);
      contracts.push({
        id: `gql-${risk === "read" ? "query" : "mutation"}-${field.name}`.toLowerCase().slice(0, 80),
        source: "graphql",
        authoritative: true,
        endpoint,
        method: "POST",
        risk,
        operationId: field.name,
        graphqlOperation: risk === "read" ? "query" : "mutation",
        contentType: "json",
        requestFields,
        responseSchema: dataSchemas[retRef.name] || { type: "object" },
        responseShape: dataSchemas[retRef.name] ? responseShapeFromSchema(dataSchemas[retRef.name]) : {},
      });
      if (contracts.length >= MAX_ENDPOINTS) break;
    }
  };
  rootFor(schema.queryType?.name, "read");
  rootFor(schema.mutationType?.name, "submit");

  return { ok: true, kind: "graphql", contracts, dataSchemas, warnings };
}

// ---------------------------------------------------------------------------
// Probing orchestrator
// ---------------------------------------------------------------------------

function candidateOpenApiUrls(baseUrl) {
  return OPENAPI_CANDIDATE_PATHS.map((p) => joinUrl(baseUrl, p.replace(/^\//, ""))).filter(Boolean);
}

async function probeOpenApi(urls, fetchOpts, baseUrl, allowedDomains) {
  for (const url of urls) {
    if (!isUrlAllowed(url, allowedDomains)) continue;
    const res = await fetchResource(url, fetchOpts);
    if (res.ok && res.json && detectOpenApi(res.json)) {
      const normalized = normalizeOpenApi(res.json, baseUrl, allowedDomains, url);
      if (normalized.ok) return { url, ...normalized };
    }
  }
  return null;
}

async function probeGraphQL(urls, fetchOpts, allowedDomains) {
  for (const url of urls) {
    if (!isUrlAllowed(url, allowedDomains)) continue;
    const res = await fetchResource(url, {
      ...fetchOpts,
      method: "POST",
      headers: { ...fetchOpts.headers, "content-type": "application/json" },
      body: GRAPHQL_INTROSPECTION_QUERY,
    });
    if (res.ok && res.json && (res.json.data?.__schema || res.json.__schema)) {
      const normalized = normalizeGraphQLIntrospection(res.json, url, allowedDomains);
      if (normalized.ok && normalized.contracts.length) return { url, ...normalized };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = {
    baseUrl: "",
    allowDomains: [],
    storageState: null,
    openapiUrls: [],
    graphqlUrls: [],
    out: null,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    dryRun: false,
  };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--base-url") args.baseUrl = argv[++i];
    else if (arg === "--allow-domain") args.allowDomains.push(normalizeHost(argv[++i]));
    else if (arg === "--allowlist") args.allowDomains.push(...String(argv[++i] || "").split(",").map(normalizeHost).filter(Boolean));
    else if (arg === "--storage-state") args.storageState = argv[++i];
    else if (arg === "--openapi-url") args.openapiUrls.push(argv[++i]);
    else if (arg === "--graphql-url") args.graphqlUrls.push(argv[++i]);
    else if (arg === "--out") args.out = argv[++i];
    else if (arg === "--timeout-ms") args.timeoutMs = Number(argv[++i]) || DEFAULT_TIMEOUT_MS;
    else if (arg === "--dry-run") args.dryRun = true;
    else if (arg === "--help" || arg === "-h") {
      console.log("Usage: node discover_contracts.cjs --base-url <url> --allow-domain <host> [--storage-state <file>] [--openapi-url <url>] [--graphql-url <url>] [--out <file>] [--dry-run]");
      process.exit(0);
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!args.baseUrl) throw new Error("Missing --base-url");
  const baseHost = normalizeHost(args.baseUrl);
  if (!args.allowDomains.length) args.allowDomains = [baseHost];
  if (!isHostAllowed(baseHost, args.allowDomains)) {
    throw new Error(`Base URL host ${baseHost} is not in the allowlist`);
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv);
  const storageState = args.storageState ? JSON.parse(fs.readFileSync(path.resolve(args.storageState), "utf8")) : null;
  const headers = {};
  const cookieHeader = cookieHeaderFor(args.baseUrl, storageState);
  if (cookieHeader) headers.cookie = cookieHeader;
  const fetchOpts = { headers, timeoutMs: args.timeoutMs };

  const output = {
    ok: true,
    schemaVersion: SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    baseUrl: args.baseUrl,
    allowedDomains: args.allowDomains,
    sources: [],
    contracts: [],
    dataSchemas: {},
    coverage: {},
    warnings: [],
  };

  if (args.dryRun) {
    output.dryRun = true;
    output.plannedOpenApiProbes = (args.openapiUrls.length ? args.openapiUrls : candidateOpenApiUrls(args.baseUrl)).filter((u) => isUrlAllowed(u, args.allowDomains));
    output.plannedGraphQLProbes = (args.graphqlUrls.length ? args.graphqlUrls : GRAPHQL_CANDIDATE_PATHS.map((p) => joinUrl(args.baseUrl, p.replace(/^\//, "")))).filter((u) => isUrlAllowed(u, args.allowDomains));
    emit(output, args.out);
    return;
  }

  const openapiUrls = args.openapiUrls.length ? args.openapiUrls : candidateOpenApiUrls(args.baseUrl);
  const openapi = await probeOpenApi(openapiUrls, fetchOpts, args.baseUrl, args.allowDomains);
  if (openapi) {
    output.sources.push({ kind: openapi.kind, url: openapi.url, title: openapi.title, version: openapi.version, endpointCount: openapi.contracts.length });
    output.contracts.push(...openapi.contracts);
    Object.assign(output.dataSchemas, openapi.dataSchemas);
    output.warnings.push(...openapi.warnings);
  }

  const graphqlUrls = args.graphqlUrls.length ? args.graphqlUrls : GRAPHQL_CANDIDATE_PATHS.map((p) => joinUrl(args.baseUrl, p.replace(/^\//, "")));
  const graphql = await probeGraphQL(graphqlUrls, fetchOpts, args.allowDomains);
  if (graphql) {
    output.sources.push({ kind: "graphql", url: graphql.url, endpointCount: graphql.contracts.length });
    output.contracts.push(...graphql.contracts);
    Object.assign(output.dataSchemas, graphql.dataSchemas);
    output.warnings.push(...graphql.warnings);
  }

  if (!output.sources.length) {
    output.warnings.push("NO_PUBLISHED_CONTRACT_FOUND: fall back to scan_web_system.py + HAR inference");
  }
  output.coverage = {
    sourceCount: output.sources.length,
    endpointCount: output.contracts.length,
    withRequestSchema: output.contracts.filter((c) => c.requestSchema).length,
    withResponseSchema: output.contracts.filter((c) => c.responseSchema).length,
    dataSchemaCount: Object.keys(output.dataSchemas).length,
    readEndpoints: output.contracts.filter((c) => c.risk === "read").length,
    writeEndpoints: output.contracts.filter((c) => c.risk !== "read").length,
  };
  emit(output, args.out);
}

function emit(output, outPath) {
  const json = JSON.stringify(output, null, 2);
  if (outPath) fs.writeFileSync(path.resolve(outPath), json);
  else process.stdout.write(`${json}\n`);
}

if (require.main === module) {
  main().catch((err) => {
    process.stderr.write(`${JSON.stringify({ ok: false, error: String(err?.message || err) })}\n`);
    process.exit(1);
  });
}

module.exports = {
  normalizeHost,
  isHostAllowed,
  isUrlAllowed,
  cookieHeaderFor,
  fetchResource,
  joinUrl,
  derefSchema,
  jsonType,
  responseShapeFromSchema,
  detectOpenApi,
  normalizeOpenApi,
  normalizeGraphQLIntrospection,
  candidateOpenApiUrls,
  requestFieldsFor,
};
