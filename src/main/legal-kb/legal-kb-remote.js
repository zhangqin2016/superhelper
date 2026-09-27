"use strict";

/**
 * The legal corpus, served: what `lily_legal_search` and `lily_legal_article` read.
 *
 * The corpus lives only on the server. The Lily API (`/api/legal/search`,
 * `/api/legal/article`) admits a signed, entitled device and asks the host's
 * legal retrieval gateway, which finds the governing law first and then the
 * article inside it, returning the corpus's full article text
 * (deploy/legal-kb/gateway). Measured on 25 plain-language questions: the
 * answering article in the top 5 for 24 when the caller names the law, 21
 * without — the V2 service alone found 7 to 8.
 *
 * Fail-open: an unreachable, unauthorized or rate-limited service is an
 * explicit `ok:false` with no results, never a throw, so the model sees that
 * the evidence is missing instead of inventing a citation.
 *
 * Never worse than the local pack it replaces: while the service cannot be
 * reached (not yet deployed, down) a pack an earlier version installed still
 * answers, marked `source: "local-fallback"`; a refusal (the admin disabled
 * the pack, the plan does not cover it, the quota is spent) is never routed
 * around. The local pack is retired only after the service has answered.
 */

// The service said no: these are decisions, not outages.
const REFUSALS = new Set(["LEGAL_KB_NOT_ENTITLED", "LEGAL_KB_DISABLED", "LEGAL_SEARCH_RATE_LIMITED", "INVALID_REQUEST",
  "LEGAL_KB_QUERY_REQUIRED", "LEGAL_KB_QUERY_TOO_LONG", "LEGAL_QUERY_INVALID", "DEVICE_SIGNATURE_INVALID"]);

async function localFallback(args, manager) {
  try {
    const local = manager || require("./legal-kb-manager");
    if (!local.status?.()?.usable) return null;
    const out = await local.search({ query: args.query, topK: args.topK }, { autoInstall: false });
    if (!out?.ok) return null;
    return {
      ok: true,
      source: "local-fallback",
      corpusVersion: String(out.packVersion || ""),
      note: "the legal service could not be reached; these are excerpts from the pack installed on this machine, which may be older",
      results: (out.results || []).map((row) => toolArticle({ ...row, text: row.excerpt, textTruncated: true, law: String(row.title || "").replace(/^中华人民共和国/, "") })),
    };
  } catch (error) {
    console.warn(`[legal-kb] local fallback unavailable: ${error?.message || error}`);
    return null;
  }
}

const MAX_QUERY_CHARS = 240;
const MAX_TOP_K = 20;

function compact(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function serviceClient(serviceFetch, getDeviceId) {
  if (serviceFetch) return { fetch: serviceFetch, deviceId: getDeviceId };
  const client = require("../service-client");
  return { fetch: client.serviceFetch, deviceId: getDeviceId || client.getDeviceId };
}

function withDevice(body, deviceId) {
  try {
    const id = typeof deviceId === "function" ? String(deviceId() || "") : "";
    if (id) return { ...body, deviceId: id };
  } catch { /* the signature header still identifies the device */ }
  return body;
}

async function call(path, body, { serviceFetch, getDeviceId } = {}) {
  let client;
  try { client = serviceClient(serviceFetch, getDeviceId); } catch (error) {
    return { ok: false, error: "LEGAL_KB_SERVICE_UNAVAILABLE", detail: error?.message || String(error) };
  }
  let response;
  try {
    response = await client.fetch(path, { method: "POST", body: JSON.stringify(withDevice(body, client.deviceId)) });
  } catch (error) {
    return { ok: false, error: "LEGAL_KB_SERVICE_UNAVAILABLE", detail: error?.message || String(error) };
  }
  if (!response?.ok) {
    const code = String(response?.json?.code || response?.error || "LEGAL_KB_SERVICE_UNAVAILABLE");
    return { ok: false, error: code, ...(response?.json?.retryAfterSec ? { retryAfterSec: response.json.retryAfterSec } : {}) };
  }
  return { ok: true, json: response.json || {} };
}

/** One served article in the tool's shape: full text, the law's validity, a citation line. */
function toolArticle(item = {}) {
  const validity = String(item.validity || "unknown");
  return {
    id: String(item.id || ""),
    law: String(item.law || ""),
    title: String(item.title || ""),
    article: String(item.article || ""),
    text: String(item.text || ""),
    textTruncated: Boolean(item.textTruncated),
    category: String(item.category || ""),
    authority: String(item.authority || ""),
    promulgatedAt: String(item.promulgatedAt || ""),
    effectiveAt: String(item.effectiveAt || ""),
    validity,
    citation: `《${String(item.title || item.law || "")}》${String(item.article || "")}`,
    ...(item.lawSource ? { lawSource: String(item.lawSource) } : {}),
  };
}

/**
 * @param {{query: string, laws?: string[], topK?: number, includeHistorical?: boolean, serviceFetch?: Function, getDeviceId?: Function}} args
 */
async function searchLegalKnowledgeRemote({ query, laws, topK = 8, includeHistorical, serviceFetch, getDeviceId, localManager, retire } = {}) {
  const text = compact(query);
  if (!text) return { ok: false, error: "LEGAL_KB_QUERY_REQUIRED", results: [] };
  if (text.length > MAX_QUERY_CHARS) return { ok: false, error: "LEGAL_KB_QUERY_TOO_LONG", results: [] };
  const body = { query: text, topK: Math.max(1, Math.min(MAX_TOP_K, Number(topK) || 8)) };
  const names = (Array.isArray(laws) ? laws : []).map(compact).filter(Boolean).slice(0, 5);
  if (names.length) body.laws = names;
  if (includeHistorical === true) body.includeHistorical = true;
  const out = await call("/api/legal/search", body, { serviceFetch, getDeviceId });
  if (!out.ok) {
    if (!REFUSALS.has(out.error)) {
      const fallback = await localFallback(body, localManager);
      if (fallback) {
        console.warn(`[legal-kb] legal service unavailable (${out.error}); answered from the local pack`);
        return fallback;
      }
    }
    return { ...out, results: [] };
  }
  // The service answered: the local copy is no longer needed.
  try { (retire || require("./local-pack-retirement").retireLocalLegalPack)(); } catch { /* retirement is best effort */ }
  const json = out.json;
  return {
    ok: true,
    source: "service",
    corpusVersion: String(json.corpusVersion || ""),
    laws: Array.isArray(json.laws) ? json.laws : [],
    ...(Array.isArray(json.unresolvedLaws) && json.unresolvedLaws.length ? { unresolvedLaws: json.unresolvedLaws } : {}),
    ...(json.note ? { note: String(json.note) } : {}),
    results: Array.isArray(json.results) ? json.results.map(toolArticle) : [],
  };
}

/** @param {{id?: string, law?: string, article?: string, serviceFetch?: Function, getDeviceId?: Function}} args */
async function getLegalArticleRemote({ id, law, article, serviceFetch, getDeviceId } = {}) {
  const body = {};
  if (compact(id)) body.id = compact(id);
  else if (compact(law) && compact(article)) { body.law = compact(law); body.article = compact(article); }
  else return { ok: false, error: "LEGAL_ARTICLE_REFERENCE_REQUIRED" };
  const out = await call("/api/legal/article", body, { serviceFetch, getDeviceId });
  if (!out.ok) return out;
  return { ok: true, source: "service", corpusVersion: String(out.json.corpusVersion || ""), article: toolArticle(out.json.article || {}) };
}

module.exports = { searchLegalKnowledgeRemote, getLegalArticleRemote, toolArticle, MAX_QUERY_CHARS, MAX_TOP_K };
