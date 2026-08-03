import crypto from "node:crypto";
import { config } from "../config.js";
import { verifyModelGatewayToken } from "./model-gateway/auth.js";
import { listModelGatewayProviders } from "./model-gateway/providers.js";
import { gatewayAccountRequired } from "./model-gateway/usage.js";
import { resolveOrgContextForRequest } from "./organization-context.js";
import { consumeEntitlement, fetchFeaturePricing } from "./wallet.js";

// Mint a short-lived HS256 JWT for Kling-style auth (iss=accessKey, exp=+1800,
// nbf=-5s skew). Done server-side so the SecretKey never reaches the client.
function signKlingJwt(accessKey, secretKey) {
  const b64url = (input) =>
    Buffer.from(input).toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = b64url(JSON.stringify({ iss: accessKey, exp: now + 1800, nbf: now - 5 }));
  const signature = crypto
    .createHmac("sha256", secretKey)
    .update(`${header}.${payload}`)
    .digest("base64")
    .replace(/=+$/, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
  return `${header}.${payload}.${signature}`;
}

// Resolve a service credential from the DB-backed gateway registry (reserved
// ids "vision" / "search"), falling back to server env for back-compat. Keeping
// these in the same registry means all keys live in the DB and are managed in
// the one admin panel.
function resolveCredential(id, fallbackKey, fallbackBaseUrl) {
  let apiKey = "";
  let baseUrl = "";
  let secretKey = "";
  let metadata = {};
  try {
    const provider = listModelGatewayProviders()[id];
    if (provider) {
      apiKey = provider.apiKey || "";
      baseUrl = provider.baseUrl || "";
      secretKey = provider.secretKey || "";
      metadata = provider.metadata || {};
    }
  } catch {
    // registry unavailable — fall back to env below
  }
  return { apiKey: apiKey || fallbackKey || "", baseUrl: baseUrl || fallbackBaseUrl || "", secretKey, metadata };
}

function resolveMediaCredential(spec) {
  const resolved = resolveCredential(spec.credId, spec.fallbackKey(), spec.baseUrl());
  if (!spec.baseCredId) return resolved;
  const baseResolved = resolveCredential(spec.baseCredId, "", spec.baseUrl());
  return {
    ...resolved,
    apiKey: resolved.apiKey || baseResolved.apiKey,
    baseUrl: baseResolved.baseUrl || spec.baseUrl() || resolved.baseUrl,
    metadata: { ...baseResolved.metadata, ...resolved.metadata },
  };
}

// Server-side proxies for vision (image recognition) and web search, so their
// API keys stay on the server. Clients call these with a short-lived gateway
// token (providerId "vision" / "search"); the server injects the real key and
// forwards. The client request/response shapes are unchanged (OpenAI-compatible
// chat/completions for vision, IQS unified for search), so existing clients work
// once the delivered runtime.env points DASHSCOPE_BASE_URL / WEBSEARCH_IQS_API_URL
// at these routes (see withGatewayRuntimeConfig).

function bearerToken(request) {
  const auth = String(request.headers.authorization || "").trim();
  if (auth.toLowerCase().startsWith("bearer ")) return auth.slice(7).trim();
  return String(request.headers["x-api-key"] || "").trim();
}

function usageIdempotencyKey(request) {
  return String(request.headers["x-lily-idempotency-key"] || "").trim().slice(0, 200);
}

function inferMediaUsage(providerId, rest, body) {
  const text = `${providerId}/${rest} ${JSON.stringify(body || {})}`.toLowerCase();
  if (text.includes("video") || text.includes("t2v") || text.includes("i2v") || text.includes("wan")) {
    return { feature: "ai_video", resourceType: "video_generation", specKey: providerId || "default" };
  }
  if (text.includes("image") || text.includes("text2image") || text.includes("tti") || text.includes("seedream") || text.includes("cogview")) {
    return { feature: "ai_image", resourceType: "image_generation", specKey: providerId || "default" };
  }
  return null;
}

async function requireMediaEntitlement(request, reply, token, providerId, rest) {
  if (request.method !== "POST") return true;
  const usage = inferMediaUsage(providerId, rest, request.body);
  if (!usage) return true;
  const account = gatewayAccountRequired({ token, enforcementEnabled: config.accountUsageEnforcementEnabled });
  if (!account.ok) {
    reply.code(402).send({ error: { type: "payment_required", message: account.code } });
    return false;
  }
  if (account.licenseAuthorized || account.trial || account.anonymous) return true;
  const orgId = await resolveOrgContextForRequest(request, reply, token);
  if (orgId === null) return false;
  const pricing = await fetchFeaturePricing({
    feature: usage.feature,
    provider: providerId,
    specKey: usage.specKey,
  });
  const consumed = await consumeEntitlement({
    userId: token.userId,
    deviceId: token.deviceId || "",
    licenseId: token.licenseId || "",
    provider: providerId,
    feature: usage.feature,
    specKey: usage.specKey,
    resourceType: usage.resourceType,
    units: 1,
    unitCost: pricing.unitCost,
    idempotencyKey: usageIdempotencyKey(request),
    metadata: { path: rest },
    organizationId: orgId,
  });
  if (!consumed.ok) {
    reply.code(402).send({
      error: {
        type: "payment_required",
        message: consumed.code || "ENTITLEMENT_INSUFFICIENT",
        resourceType: usage.resourceType,
        requiredUnits: consumed.requiredUnits || 1,
        availableUnits: consumed.availableUnits || 0,
      },
    });
    return false;
  }
  return true;
}

async function forwardJson(reply, upstream) {
  const text = await upstream.text();
  reply.code(upstream.status);
  const contentType = upstream.headers.get("content-type");
  reply.header("content-type", contentType || "application/json");
  return reply.send(text);
}

async function forwardResponse(reply, upstream) {
  const contentType = upstream.headers.get("content-type") || "";
  reply.code(upstream.status);
  if (contentType) reply.header("content-type", contentType);
  if (/^application\/json\b/i.test(contentType) || /^text\//i.test(contentType)) {
    return reply.send(await upstream.text());
  }
  return reply.send(Buffer.from(await upstream.arrayBuffer()));
}

function forwardedHeader(request, name) {
  const value = request.headers?.[name];
  if (Array.isArray(value)) return String(value[0] || "").trim();
  return String(value || "").split(",")[0].trim();
}

function publicRequestBaseUrl(request) {
  const configured = String(config.publicBaseUrl || "").trim().replace(/\/+$/, "");
  if (configured) return configured;
  const proto = forwardedHeader(request, "x-forwarded-proto") || request.protocol || "https";
  const host = forwardedHeader(request, "x-forwarded-host") || forwardedHeader(request, "host");
  return host ? `${proto}://${host}` : "";
}

async function handleVision(request, reply) {
  if (!config.modelGatewayEnabled) {
    return reply.code(404).send({ error: { type: "not_found", message: "gateway disabled" } });
  }
  const token = verifyModelGatewayToken(bearerToken(request), "vision");
  if (!token.ok) {
    return reply.code(401).send({ error: { type: "authentication_error", message: token.code } });
  }
  const { apiKey, baseUrl } = resolveCredential("vision", config.dashscopeApiKey, config.visionUpstreamBaseUrl);
  if (!apiKey) {
    return reply.code(503).send({ error: { type: "configuration_error", message: "vision key not configured" } });
  }
  const url = `${baseUrl.replace(/\/+$/, "")}/chat/completions`;
  let upstream;
  try {
    upstream = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(request.body && typeof request.body === "object" ? request.body : {}),
    });
  } catch (error) {
    return reply.code(502).send({ error: { type: "upstream_error", message: String(error?.message || error) } });
  }
  return forwardJson(reply, upstream);
}

// Semantic memory recall for managed (gateway-mode) clients. They reuse the
// vision base+token already in their DASHSCOPE_BASE_URL/DASHSCOPE_API_KEY slots
// (client posts {DASHSCOPE_BASE_URL}/embeddings → /llm/vision/embeddings), so the
// same server-side DashScope key (compatible-mode, supports text-embedding-v3)
// serves embeddings with no extra credential delivery.
async function handleVisionEmbeddings(request, reply) {
  if (!config.modelGatewayEnabled) {
    return reply.code(404).send({ error: { type: "not_found", message: "gateway disabled" } });
  }
  const token = verifyModelGatewayToken(bearerToken(request), "vision");
  if (!token.ok) {
    return reply.code(401).send({ error: { type: "authentication_error", message: token.code } });
  }
  const { apiKey, baseUrl } = resolveCredential("vision", config.dashscopeApiKey, config.visionUpstreamBaseUrl);
  if (!apiKey) {
    return reply.code(503).send({ error: { type: "configuration_error", message: "vision key not configured" } });
  }
  const url = `${baseUrl.replace(/\/+$/, "")}/embeddings`;
  let upstream;
  try {
    upstream = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(request.body && typeof request.body === "object" ? request.body : {}),
    });
  } catch (error) {
    return reply.code(502).send({ error: { type: "upstream_error", message: String(error?.message || error) } });
  }
  return forwardJson(reply, upstream);
}

async function handleSearch(request, reply) {
  if (!config.modelGatewayEnabled) {
    return reply.code(404).send({ error: { type: "not_found", message: "gateway disabled" } });
  }
  const token = verifyModelGatewayToken(bearerToken(request), "search");
  if (!token.ok) {
    return reply.code(401).send({ error: { type: "authentication_error", message: token.code } });
  }
  const { apiKey, baseUrl } = resolveCredential("search", config.webSearchIqsApiKey, config.webSearchIqsApiUrl);
  if (!apiKey) {
    return reply.code(503).send({ error: { type: "configuration_error", message: "search key not configured" } });
  }
  let upstream;
  try {
    upstream = await fetch(baseUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(request.body && typeof request.body === "object" ? request.body : {}),
    });
  } catch (error) {
    return reply.code(502).send({ error: { type: "upstream_error", message: String(error?.message || error) } });
  }
  return forwardJson(reply, upstream);
}

// Per-provider media proxy table. Each entry maps a media provider id onto its
// DB-registry credential id (same "env seed + DB override" registry as chat
// providers), the env fallback key, and the upstream base URL. The skill scripts
// hit ${base}/llm/media/<provider> + the provider's own path; we map that onto
// the real host and inject the server-side key, so the key never reaches the
// client. Result files are public/signed URLs the client downloads directly.
//
// To add a provider: add an entry here and a runtime.env block in
// client-config.js. `auth` selects how the upstream Authorization header is
// built: "bearer" (default) injects the resolved key; "kling-jwt" mints a JWT
// from the AccessKey (resolved key) + SecretKey. `groupId` (MiniMax) appends a
// GroupId query param when configured.
const MEDIA_PROVIDERS = {
  dashscope: {
    credId: "vision",
    baseCredId: "dashscope-media",
    fallbackKey: () => config.dashscopeApiKey,
    baseUrl: () => config.dashscopeMediaBaseUrl,
  },
  volcengine: { credId: "volcengine-media", fallbackKey: () => config.volcengineApiKey, baseUrl: () => config.volcengineBaseUrl },
  kling: {
    credId: "kling-media",
    fallbackKey: () => config.klingAccessKey,
    baseUrl: () => config.klingBaseUrl,
    auth: "kling-jwt",
    secretKey: () => config.klingSecretKey,
  },
  minimax: {
    credId: "minimax-media",
    fallbackKey: () => config.minimaxApiKey,
    baseUrl: () => config.minimaxBaseUrl,
    groupId: () => config.minimaxGroupId,
  },
  zhipu: { credId: "zhipu-media", fallbackKey: () => config.zhipuApiKey, baseUrl: () => config.zhipuBaseUrl },
};

const LILY_MEDIA_KINDS = new Set(["image", "video", "speech"]);
const LILY_SPEECH_SUPPORTED_VOICES = new Set(["aiden", "dylan", "eric", "ono_anna", "ryan", "serena", "sohee", "uncle_fu", "vivian"]);
const LILY_SPEECH_LEGACY_DEFAULT_VOICES = new Set(["", "default", "longanyang"]);

function lilyMediaConfig(kind) {
  if (kind === "image") {
    return {
      endpoint: config.lilyMediaImageEndpoint,
      baseUrl: config.lilyMediaImageBaseUrl,
      sharedPath: "image",
    };
  }
  if (kind === "video") {
    return {
      endpoint: config.lilyMediaVideoEndpoint,
      baseUrl: config.lilyMediaVideoBaseUrl,
      sharedPath: "video",
    };
  }
  if (kind === "speech") {
    return {
      endpoint: config.lilyMediaSpeechEndpoint,
      baseUrl: config.lilyMediaSpeechBaseUrl,
      sharedPath: "speech",
    };
  }
  return null;
}

function lilyMediaUrl(kind, rest, query = "") {
  const cfg = lilyMediaConfig(kind);
  if (!cfg) return "";
  const cleanRest = String(rest || "").replace(/^\/+/, "");
  if (cfg.endpoint) {
    // Explicit endpoints identify the concrete GPU service route, e.g. the
    // private tunnel's /generate. Keep the public gateway path stable while
    // avoiding accidental forwarding to arbitrary paths on that service.
    if (!cleanRest || cleanRest === "generate") return `${cfg.endpoint}${query}`;
    return "";
  }
  if (cfg.baseUrl) return `${cfg.baseUrl.replace(/\/+$/, "")}/${cleanRest}${query}`;
  if (config.lilyMediaBaseUrl) {
    return `${config.lilyMediaBaseUrl.replace(/\/+$/, "")}/${cfg.sharedPath}/${cleanRest}${query}`;
  }
  return "";
}

function lilyMediaReferenceUrl(kind) {
  const cfg = lilyMediaConfig(kind);
  if (!cfg) return "";
  if (cfg.endpoint) return cfg.endpoint;
  if (cfg.baseUrl) return `${cfg.baseUrl.replace(/\/+$/, "")}/`;
  if (config.lilyMediaBaseUrl) return `${config.lilyMediaBaseUrl.replace(/\/+$/, "")}/${cfg.sharedPath}/`;
  return "";
}

function normalizeLilyMediaRequestBody(kind, body) {
  const normalized = body && typeof body === "object" && !Array.isArray(body) ? { ...body } : {};
  if (kind !== "speech") return { ok: true, body: normalized };
  const requested = String(normalized.voice || "").trim();
  const configured = String(config.lilyMediaSpeechVoice || process.env.LILY_MEDIA_TTS_VOICE || process.env.LILY_GPU_TTS_VOICE || "").trim();
  const voice = LILY_SPEECH_LEGACY_DEFAULT_VOICES.has(requested) ? (configured || "aiden") : requested;
  if (!LILY_SPEECH_SUPPORTED_VOICES.has(voice)) {
    return {
      ok: false,
      statusCode: 400,
      error: {
        type: "invalid_request_error",
        message: `Unsupported Lily speech voice: ${voice}. Supported: ${[...LILY_SPEECH_SUPPORTED_VOICES].join(", ")}`,
      },
    };
  }
  normalized.voice = voice;
  return { ok: true, body: normalized };
}

function isPrivateHost(hostname) {
  const host = String(hostname || "").toLowerCase();
  if (!host) return false;
  if (host === "localhost" || host === "::1" || host === "[::1]") return true;
  if (/^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host)) return true;
  const match = /^172\.(\d+)\./.exec(host);
  return Boolean(match && Number(match[1]) >= 16 && Number(match[1]) <= 31);
}

function normalizeLilyAssetTarget(kind, rawUrl) {
  const raw = String(rawUrl || "").trim();
  if (!raw) return "";
  const reference = lilyMediaReferenceUrl(kind);
  if (!reference) return "";
  let referenceUrl;
  try {
    referenceUrl = new URL(reference);
  } catch {
    return "";
  }
  if (/^file:/i.test(raw)) return "";
  if (raw.startsWith("/mnt/media-services/outputs/")) {
    return `${referenceUrl.origin}/file?path=${encodeURIComponent(raw)}`;
  }
  let target;
  try {
    target = /^https?:\/\//i.test(raw) ? new URL(raw) : new URL(raw, referenceUrl);
  } catch {
    return "";
  }
  if (!/^https?:$/.test(target.protocol)) return "";
  const sameOrigin = target.origin === referenceUrl.origin;
  if (!sameOrigin && !isPrivateHost(target.hostname)) return "";
  return `${referenceUrl.origin}${target.pathname}${target.search}`;
}

function shouldProxyLilyAssetUrl(kind, rawUrl) {
  return Boolean(normalizeLilyAssetTarget(kind, rawUrl));
}

function lilyAssetProxyUrl(request, kind, rawUrl) {
  const base = publicRequestBaseUrl(request);
  if (!base) return rawUrl;
  const token = bearerToken(request);
  const authQuery = token ? `&access_token=${encodeURIComponent(token)}` : "";
  return `${base}/llm/media/lily/${kind}/asset?url=${encodeURIComponent(String(rawUrl || ""))}${authQuery}`;
}

const LILY_MEDIA_URL_KEYS = new Set([
  "audio",
  "audio_url",
  "download_url",
  "file",
  "file_url",
  "image",
  "image_url",
  "public_url",
  "result_url",
  "url",
  "video",
  "video_url",
]);

function rewriteLilyMediaUrls(value, kind, request, key = "") {
  if (typeof value === "string") {
    return LILY_MEDIA_URL_KEYS.has(key) && shouldProxyLilyAssetUrl(kind, value) ? lilyAssetProxyUrl(request, kind, value) : value;
  }
  if (Array.isArray(value)) return value.map((item) => rewriteLilyMediaUrls(item, kind, request, key));
  if (!value || typeof value !== "object") return value;
  const next = {};
  for (const [key, item] of Object.entries(value)) {
    next[key] = rewriteLilyMediaUrls(item, kind, request, key);
  }
  return next;
}

async function forwardLilyMediaResponse(request, reply, upstream, kind) {
  const contentType = upstream.headers.get("content-type") || "";
  if (!/^application\/json\b/i.test(contentType)) return forwardResponse(reply, upstream);
  const text = await upstream.text();
  reply.code(upstream.status);
  reply.header("content-type", contentType || "application/json");
  if (!text) return reply.send(text);
  try {
    const data = JSON.parse(text);
    return reply.send(JSON.stringify(rewriteLilyMediaUrls(data, kind, request)));
  } catch {
    return reply.send(text);
  }
}

async function handleLilyAsset(request, reply, kind) {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return reply.code(405).send({ error: { type: "invalid_request_error", message: "asset proxy only supports GET/HEAD" } });
  }
  const parsed = new URL(request.url, "https://lily.local");
  const target = normalizeLilyAssetTarget(kind, parsed.searchParams.get("url"));
  if (!target) {
    return reply.code(400).send({ error: { type: "invalid_request_error", message: "invalid Lily media asset URL" } });
  }
  const headers = {};
  if (config.lilyMediaApiKey) headers.Authorization = `Bearer ${config.lilyMediaApiKey}`;
  let upstream;
  try {
    upstream = await fetch(target, { method: request.method, headers, signal: AbortSignal.timeout(300_000) });
  } catch (error) {
    return reply.code(502).send({ error: { type: "upstream_error", message: String(error?.message || error) } });
  }
  return forwardResponse(reply, upstream);
}

async function handleLilyMedia(request, reply) {
  const requestUrl = new URL(request.url, "https://lily.local");
  const rawToken = bearerToken(request) || String(requestUrl.searchParams.get("access_token") || requestUrl.searchParams.get("token") || "").trim();
  const token = verifyModelGatewayToken(rawToken, "lily-media");
  if (!token.ok) {
    return reply.code(401).send({ error: { type: "authentication_error", message: token.code } });
  }
  const rest = String(request.params["*"] || "").replace(/^\/+/, "");
  const [kind, ...parts] = rest.split("/");
  if (!LILY_MEDIA_KINDS.has(kind)) {
    return reply.code(404).send({ error: { type: "not_found", message: "unknown Lily media kind" } });
  }
  if (parts.join("/") === "asset") {
    return handleLilyAsset(request, reply, kind);
  }
  if (!(await requireMediaEntitlement(request, reply, token, "lily", rest))) return reply;

  const queryIndex = request.url.indexOf("?");
  const query = queryIndex >= 0 ? request.url.slice(queryIndex) : "";
  const url = lilyMediaUrl(kind, parts.join("/"), query);
  if (!url) {
    return reply.code(503).send({ error: { type: "configuration_error", message: `${kind} Lily media endpoint not configured` } });
  }
  const headers = { "Content-Type": "application/json" };
  if (config.lilyMediaApiKey) headers.Authorization = `Bearer ${config.lilyMediaApiKey}`;
  const init = { method: request.method, headers };
  if (request.method !== "GET" && request.method !== "HEAD") {
    const normalized = normalizeLilyMediaRequestBody(kind, request.body);
    if (!normalized.ok) return reply.code(normalized.statusCode).send({ error: normalized.error });
    init.body = JSON.stringify(normalized.body);
  }
  let upstream;
  try {
    upstream = await fetch(url, init);
  } catch (error) {
    return reply.code(502).send({ error: { type: "upstream_error", message: String(error?.message || error) } });
  }
  return forwardLilyMediaResponse(request, reply, upstream, kind);
}

// Transparent proxy for async media (image / video / TTS). `fixedProvider` is
// set for the back-compat /llm/dashscope-media/* alias; otherwise the provider
// comes from the :provider route param.
function mediaHandler(fixedProvider) {
  return async function handleMedia(request, reply) {
    if (!config.modelGatewayEnabled) {
      return reply.code(404).send({ error: { type: "not_found", message: "gateway disabled" } });
    }
    const providerId = String(fixedProvider || request.params.provider || "").toLowerCase();
    if (providerId === "lily") return handleLilyMedia(request, reply);
    const spec = MEDIA_PROVIDERS[providerId];
    if (!spec) {
      return reply.code(404).send({ error: { type: "not_found", message: "unknown media provider" } });
    }
    const token = verifyModelGatewayToken(bearerToken(request), spec.credId);
    if (!token.ok) {
      return reply.code(401).send({ error: { type: "authentication_error", message: token.code } });
    }
    const rest = String(request.params["*"] || "").replace(/^\/+/, "");
    if (!(await requireMediaEntitlement(request, reply, token, providerId, rest))) return reply;
    const resolved = resolveMediaCredential(spec);
    const { apiKey, baseUrl } = resolved;
    if (!apiKey) {
      return reply.code(503).send({ error: { type: "configuration_error", message: `${providerId} key not configured` } });
    }
    // Build the upstream bearer per provider auth type. Kling mints a JWT from
    // AccessKey (apiKey) + SecretKey; others inject the key directly. Secrets
    // resolve from the DB registry first, then the env fallback.
    let bearer = apiKey;
    if (spec.auth === "kling-jwt") {
      const secretKey = resolved.secretKey || spec.secretKey?.() || "";
      if (!secretKey) {
        return reply.code(503).send({ error: { type: "configuration_error", message: `${providerId} secret not configured` } });
      }
      bearer = signKlingJwt(apiKey, secretKey);
    }
    const queryIndex = request.url.indexOf("?");
    let query = queryIndex >= 0 ? request.url.slice(queryIndex) : "";
    // MiniMax (China) needs GroupId on the query; inject it server-side if the
    // client didn't already include one.
    const groupId = resolved.metadata?.groupId || spec.groupId?.() || "";
    if (groupId && !/[?&]GroupId=/.test(query)) {
      query += `${query ? "&" : "?"}GroupId=${encodeURIComponent(groupId)}`;
    }
    const url = `${baseUrl.replace(/\/+$/, "")}/${rest}${query}`;
    const headers = { Authorization: `Bearer ${bearer}`, "Content-Type": "application/json" };
    if (request.headers["x-dashscope-async"]) headers["X-DashScope-Async"] = request.headers["x-dashscope-async"];
    const init = { method: request.method, headers };
    if (request.method !== "GET" && request.method !== "HEAD") {
      init.body = JSON.stringify(request.body && typeof request.body === "object" ? request.body : {});
    }
    let upstream;
    try {
      upstream = await fetch(url, init);
    } catch (error) {
      return reply.code(502).send({ error: { type: "upstream_error", message: String(error?.message || error) } });
    }
    return forwardJson(reply, upstream);
  };
}

export async function mediaGatewayRoutes(app) {
  app.post(
    "/llm/vision/chat/completions",
    {
      schema: {
        tags: ["gateway:media"],
        summary: "Proxy a vision chat/completions request",
        description:
          "Injects the server-side vision key and forwards the OpenAI-compatible chat/completions body upstream.",
      },
    },
    handleVision,
  );
  app.post(
    "/llm/vision/embeddings",
    {
      schema: {
        tags: ["gateway:media"],
        summary: "Proxy a vision-key embeddings request",
        description:
          "Injects the server-side vision (DashScope compatible-mode) key and forwards the OpenAI-compatible /embeddings body upstream. Powers semantic memory recall for managed clients, reusing the vision token.",
      },
    },
    handleVisionEmbeddings,
  );
  app.post(
    "/llm/search",
    {
      schema: {
        tags: ["gateway:media"],
        summary: "Proxy a web search request",
        description: "Injects the server-side search key and forwards the request to the upstream search API.",
      },
    },
    handleSearch,
  );
  // Back-compat alias: existing clients still target /llm/dashscope-media/*.
  const dashscopeHandler = mediaHandler("dashscope");
  app.post("/llm/dashscope-media/*", { schema: { tags: ["gateway:media"], summary: "Proxy a DashScope media request" } }, dashscopeHandler);
  app.get("/llm/dashscope-media/*", { schema: { tags: ["gateway:media"], summary: "Poll a DashScope media task" } }, dashscopeHandler);

  // Generic per-provider media proxy: /llm/media/<provider>/<upstream path>.
  const genericHandler = mediaHandler(null);
  app.post(
    "/llm/media/:provider/*",
    {
      schema: {
        tags: ["gateway:media"],
        summary: "Proxy a media provider request",
        description:
          "Transparently proxies async media (image/video) create/poll calls for the named provider, injecting the server-side key.",
      },
    },
    genericHandler,
  );
  app.get(
    "/llm/media/:provider/*",
    {
      schema: {
        tags: ["gateway:media"],
        summary: "Poll a media provider task",
        description: "Transparently proxies media provider task-status polls, injecting the server-side key.",
      },
    },
    genericHandler,
  );
}
