import { createHash } from "node:crypto";
import { z } from "zod";
import { requireSignedDeviceRequest } from "../../services/device-identity.js";
import { legalSearchAccess } from "../../services/legal-kb-access.js";
import { zodBody, okResponse } from "../../openapi.js";

// The legal retrieval gateway (deploy/legal-kb/gateway) on this host: loopback
// only, no authentication of its own — this route is its only door. The API
// container runs with network_mode: host, so 127.0.0.1 is the host itself.
const GATEWAY_URL = String(process.env.LILY_LEGAL_GATEWAY_URL || "http://127.0.0.1:8791").replace(/\/+$/, "");
const TIMEOUT_MS = Number(process.env.LILY_LEGAL_SEARCH_TIMEOUT_MS || 15000);
// Per device: a legal question takes a few searches; a scraper takes thousands.
const PER_MINUTE = Number(process.env.LILY_LEGAL_SEARCH_PER_MINUTE || 30);
const PER_DAY = Number(process.env.LILY_LEGAL_SEARCH_PER_DAY || 1500);
const MAX_TEXT = 3000;

const deviceField = z.string().min(6).max(120);
const searchSchema = z.object({
  deviceId: deviceField,
  query: z.string().min(1).max(240),
  laws: z.array(z.string().min(1).max(60)).max(5).optional(),
  topK: z.number().int().min(1).max(20).optional(),
  includeHistorical: z.boolean().optional(),
});
const articleSchema = z.object({
  deviceId: deviceField,
  id: z.string().min(1).max(400).optional(),
  law: z.string().min(1).max(60).optional(),
  article: z.string().min(1).max(40).optional(),
}).refine((v) => v.id || (v.law && v.article), { message: "id or law+article" });

/** Sliding per-device quota; in-process, which matches a single API instance. */
export function createDeviceQuota({ perMinute = PER_MINUTE, perDay = PER_DAY, now = Date.now } = {}) {
  const buckets = new Map();
  return (deviceId) => {
    const t = now();
    const b = buckets.get(deviceId) || { minute: [], dayStart: t, day: 0 };
    b.minute = b.minute.filter((at) => t - at < 60_000);
    if (t - b.dayStart >= 86_400_000) { b.dayStart = t; b.day = 0; }
    if (b.minute.length >= perMinute) return { ok: false, retryAfterSec: Math.ceil((60_000 - (t - b.minute[0])) / 1000) };
    if (b.day >= perDay) return { ok: false, retryAfterSec: Math.ceil((86_400_000 - (t - b.dayStart)) / 1000) };
    b.minute.push(t); b.day += 1;
    buckets.set(deviceId, b);
    if (buckets.size > 50_000) buckets.delete(buckets.keys().next().value);
    return { ok: true };
  };
}

// Only these fields leave the host; the gateway may carry more.
function publicArticle(item = {}) {
  const text = String(item.text || "");
  return {
    id: String(item.id || ""),
    law: String(item.law || ""),
    title: String(item.title || ""),
    article: String(item.article || ""),
    text: text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}…` : text,
    textTruncated: Boolean(item.textTruncated) || text.length > MAX_TEXT,
    category: String(item.category || ""),
    authority: String(item.authority || ""),
    promulgatedAt: String(item.promulgatedAt || ""),
    effectiveAt: String(item.effectiveAt || ""),
    validity: String(item.validity || "unknown"),
    ...(item.lane ? { lane: String(item.lane) } : {}),
    ...(item.lawSource ? { lawSource: String(item.lawSource) } : {}),
    ...(Number.isFinite(Number(item.score)) ? { score: Number(item.score) } : {}),
  };
}

async function gateway(pathname, init = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(`${GATEWAY_URL}${pathname}`, { ...init, signal: controller.signal });
    return { status: response.status, body: await response.json().catch(() => ({})) };
  } finally {
    clearTimeout(timer);
  }
}

const deviceTag = (deviceId) => createHash("sha256").update(String(deviceId)).digest("hex").slice(0, 12);

export function registerPublicLegalSearchRoutes(app, { quota = createDeviceQuota(), access = legalSearchAccess, verifySignature = requireSignedDeviceRequest } = {}) {
  // Signature, entitlement, quota — in that order, for both endpoints.
  async function admit(request, reply, schema) {
    let input;
    try { input = schema.parse(request.body || {}); } catch { reply.code(400).send({ ok: false, code: "INVALID_REQUEST" }); return null; }
    if (!(await verifySignature(request, reply, input))) return null;
    const allowed = await access(input.deviceId);
    if (!allowed.ok) { reply.code(403).send({ ok: false, code: allowed.code, ...(allowed.requiredPlan ? { requiredPlan: allowed.requiredPlan } : {}) }); return null; }
    const within = quota(input.deviceId);
    if (!within.ok) { reply.header("retry-after", String(within.retryAfterSec)).code(429).send({ ok: false, code: "LEGAL_SEARCH_RATE_LIMITED", retryAfterSec: within.retryAfterSec }); return null; }
    return input;
  }

  app.post("/api/legal/search", {
    schema: {
      tags: ["public:legal-knowledge-packs"],
      summary: "Search the server-side legal corpus",
      description: "Signed, entitled devices only. Finds the governing law, then its articles, and returns their full text; the corpus never leaves the server.",
      body: zodBody(searchSchema),
      response: {
        200: okResponse({ corpusVersion: { type: "string" }, laws: { type: "array", items: { type: "object", additionalProperties: true } }, results: { type: "array", items: { type: "object", additionalProperties: true } } }),
      },
    },
  }, async (request, reply) => {
    const input = await admit(request, reply, searchSchema);
    if (!input) return undefined;
    const started = Date.now();
    try {
      const { status, body } = await gateway("/search", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ query: input.query, laws: input.laws, topK: input.topK || 8, includeHistorical: input.includeHistorical === true }),
      });
      if (status !== 200 || !body.ok) return reply.code(status === 400 ? 400 : 502).send({ ok: false, code: body?.error || "LEGAL_SEARCH_FAILED" });
      const results = (body.results || []).slice(0, 20).map(publicArticle);
      // Audit without the question itself: legal questions are the client's business.
      request.log.info({ legalSearch: { device: deviceTag(input.deviceId), queryChars: input.query.length, laws: (body.laws || []).map((l) => l.name), results: results.length, ms: Date.now() - started } }, "legal search");
      return {
        ok: true,
        corpusVersion: String(body.corpusVersion || ""),
        laws: (body.laws || []).map((l) => ({ name: String(l.name || ""), source: String(l.source || "") })),
        ...(body.unresolvedLaws ? { unresolvedLaws: body.unresolvedLaws.map(String) } : {}),
        ...(body.note ? { note: String(body.note) } : {}),
        results,
      };
    } catch (error) {
      request.log.warn({ err: error }, "legal retrieval gateway unreachable");
      return reply.code(503).send({ ok: false, code: "LEGAL_SEARCH_UNAVAILABLE" });
    }
  });

  app.post("/api/legal/article", {
    schema: {
      tags: ["public:legal-knowledge-packs"],
      summary: "Fetch one legal article's full text",
      description: "Signed, entitled devices only. By result id, or by law and article number.",
      body: zodBody(articleSchema),
      response: { 200: okResponse({ corpusVersion: { type: "string" }, article: { type: "object", additionalProperties: true } }) },
    },
  }, async (request, reply) => {
    const input = await admit(request, reply, articleSchema);
    if (!input) return undefined;
    const params = new URLSearchParams();
    if (input.id) params.set("id", input.id);
    if (input.law) params.set("law", input.law);
    if (input.article) params.set("article", input.article);
    try {
      const { status, body } = await gateway(`/article?${params}`);
      if (status === 404) return reply.code(404).send({ ok: false, code: "LEGAL_ARTICLE_NOT_FOUND" });
      if (status !== 200 || !body.ok) return reply.code(502).send({ ok: false, code: body?.error || "LEGAL_ARTICLE_FAILED" });
      const article = body.article || {};
      return { ok: true, corpusVersion: String(body.corpusVersion || ""), article: { ...publicArticle(article), text: String(article.text || ""), textTruncated: false } };
    } catch (error) {
      request.log.warn({ err: error }, "legal retrieval gateway unreachable");
      return reply.code(503).send({ ok: false, code: "LEGAL_SEARCH_UNAVAILABLE" });
    }
  });
}
