#!/usr/bin/env node
"use strict";

/**
 * Lily legal retrieval gateway — the one process that answers "which article".
 *
 * Loopback only; the Lily API is its sole client and does authentication,
 * entitlement and rate limiting. It reads the V27 pack (full article text,
 * read-only) and asks the V2 service (same host) for lane votes and a law's
 * validity. Node >= 22, no dependencies.
 *
 *   node server.cjs --runtime <managed runtime> | --pack <pack dir> [--v2 …] [--port 8791]
 *
 * With --runtime (the V27 update toolchain's managed directory) the corpus is
 * whatever `active.json` points at, checked before every request: an applied
 * update or a rollback is served from the next request on, no restart, and a
 * request in flight finishes on the version it started with.
 *
 *   POST /search  {query, laws?, topK?, includeHistorical?}
 *   GET  /article ?id=… | ?law=…&article=…
 *   GET  /health
 */

const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { LegalCorpus, searchLegal, getArticle } = require("./legal-retrieval.cjs");

const arg = (name, fallback) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : fallback; };
const PACK = arg("--pack", process.env.LILY_LEGAL_PACK_DIR || "");
const RUNTIME = arg("--runtime", process.env.LILY_LEGAL_RUNTIME_DIR || "");
const V2 = String(arg("--v2", process.env.LILY_LEGAL_V2_URL || "http://127.0.0.1:8790")).replace(/\/+$/, "");
const PORT = Number(arg("--port", process.env.LILY_LEGAL_GATEWAY_PORT || 8791));
const HOST = "127.0.0.1";
const LANE_TIMEOUT_MS = Number(process.env.LILY_LEGAL_LANE_TIMEOUT_MS || 4000);
const MAX_BODY = 16 * 1024;

const log = (...parts) => console.log(new Date().toISOString(), ...parts);
if (!PACK === !RUNTIME) { console.error("exactly one of --runtime <dir> or --pack <dir> is required"); process.exit(2); }

// The V2 service's registered law abbreviations, when its code is alongside.
let aliases = null;
const ALIASES = arg("--aliases", process.env.LILY_LEGAL_ALIASES || "");
if (ALIASES) {
  try { aliases = require(ALIASES); } catch (error) { log(`law aliases not loaded from ${ALIASES} (abbreviations will not resolve): ${error?.message || error}`); }
}
const openCorpus = (packDir) => new LegalCorpus({ packDir, aliases, openDatabase: (file) => new DatabaseSync(file, { readOnly: true }) });

/** The release `active.json` names, with the checks the update toolchain applies. */
function activeRelease(runtime) {
  const root = path.resolve(runtime);
  const active = JSON.parse(fs.readFileSync(path.join(root, "active.json"), "utf8"));
  if (active.kind !== "v27-active-v1" || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/.test(String(active.releaseId || ""))) throw new Error("invalid active pointer");
  const releases = fs.realpathSync(path.join(root, "releases"));
  const folder = fs.realpathSync(path.join(releases, active.releaseId));
  if (path.dirname(folder) !== releases) throw new Error("release path escapes the runtime");
  return { releaseId: active.releaseId, folder };
}

let current = null; // { corpus, releaseId }
function corpusNow() {
  if (!RUNTIME) {
    if (!current) current = { corpus: openCorpus(PACK), releaseId: "" };
    return current;
  }
  let release;
  try {
    release = activeRelease(RUNTIME);
  } catch (error) {
    // A pointer being rewritten or damaged: keep serving what is open.
    if (current) { log(`active pointer unreadable, still serving ${current.releaseId}: ${error?.message || error}`); return current; }
    throw error;
  }
  if (current?.releaseId === release.releaseId) return current;
  const next = { corpus: openCorpus(release.folder), releaseId: release.releaseId };
  const previous = current;
  current = next;
  log(`serving release ${next.releaseId} (corpus ${next.corpus.version}, ${next.corpus.laws.size} laws)${previous ? `, was ${previous.releaseId}` : ""}`);
  // In-flight requests on the old handle finish first.
  if (previous) setTimeout(() => { try { previous.corpus.db.close(); } catch { /* already closed */ } }, 60_000).unref();
  return next;
}
const initial = corpusNow();
log(`corpus ${initial.corpus.version}: ${initial.corpus.laws.size} laws loaded from ${RUNTIME || PACK}`);

async function v2Fetch(pathname, init = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LANE_TIMEOUT_MS);
  try {
    const response = await fetch(`${V2}${pathname}`, { ...init, signal: controller.signal });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(`V2 ${pathname} ${response.status} ${body?.error?.code || ""}`.trim());
    return body;
  } finally {
    clearTimeout(timer);
  }
}

async function v2Search(query, mode) {
  const body = await v2Fetch("/api/v2/search", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ query, topK: 10, mode }),
  });
  return (Array.isArray(body.results) ? body.results : []).map((item) => ({
    title: item.title, validity: item.validityStatus || item.validity?.status || "",
  }));
}

// A law's validity as V2 records it, looked up once per title per process.
const validityCache = new Map();
async function lawValidity(title) {
  if (validityCache.has(title)) return validityCache.get(title);
  const pending = (async () => {
    try {
      const body = await v2Fetch("/api/v2/search", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ query: `${title}第一条`, topK: 3, mode: "exact" }),
      });
      const same = (body.results || []).find((item) => item.title === title);
      return String(same?.validityStatus || same?.validity?.status || "unknown");
    } catch (error) {
      log(`validity lookup failed for ${title}: ${error?.message || error}`);
      validityCache.delete(title);
      return "unknown";
    }
  })();
  validityCache.set(title, pending);
  if (validityCache.size > 5000) validityCache.delete(validityCache.keys().next().value);
  return pending;
}

function send(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(text) });
  res.end(text);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) { reject(Object.assign(new Error("body too large"), { status: 413 })); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${HOST}`);
  const started = Date.now();
  try {
    const { corpus, releaseId } = corpusNow();
    if (req.method === "GET" && url.pathname === "/health") {
      let v2 = null;
      try { v2 = await v2Fetch("/api/v2/health"); } catch (error) { v2 = { error: error?.message || String(error) }; }
      send(res, 200, { ok: true, corpusVersion: corpus.version, releaseId, laws: corpus.laws.size, v2: { ok: !v2?.error, releaseId: v2?.releaseId || "", semanticState: v2?.semanticState || "", error: v2?.error || undefined } });
      return;
    }
    if (req.method === "POST" && url.pathname === "/search") {
      const input = JSON.parse((await readBody(req)) || "{}");
      if (typeof input.query !== "string" || !input.query.trim() || input.query.length > 240) { send(res, 400, { ok: false, error: "LEGAL_QUERY_INVALID" }); return; }
      const result = { ...(await searchLegal(corpus, input, { v2Search: (q, mode) => v2Search(q, mode), lawValidity, log })), releaseId };
      log(`search ${Date.now() - started}ms laws=${result.laws.map((l) => `${l.name}:${l.source}`).join(",") || "-"} results=${result.results.length}`);
      send(res, 200, result);
      return;
    }
    if (req.method === "GET" && url.pathname === "/article") {
      const result = getArticle(corpus, { id: url.searchParams.get("id"), law: url.searchParams.get("law"), article: url.searchParams.get("article") });
      if (result.ok) { result.article.validity = await lawValidity(result.article.title); result.releaseId = releaseId; }
      send(res, result.ok ? 200 : 404, result);
      return;
    }
    send(res, 404, { ok: false, error: "NOT_FOUND" });
  } catch (error) {
    log(`request failed ${req.method} ${url.pathname}: ${error?.message || error}`);
    send(res, error?.status || (error instanceof SyntaxError ? 400 : 500), { ok: false, error: error instanceof SyntaxError ? "BAD_JSON" : "LEGAL_GATEWAY_FAILED" });
  }
});

server.listen(PORT, HOST, () => log(`legal retrieval gateway on http://${HOST}:${PORT} (V2 ${V2})`));
for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => { server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 3000).unref(); });
