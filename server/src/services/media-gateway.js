import crypto from "node:crypto";
import { config } from "../config.js";
import { verifyModelGatewayToken } from "./model-gateway/auth.js";
import { listModelGatewayProviders } from "./model-gateway/providers.js";

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

async function forwardJson(reply, upstream) {
  const text = await upstream.text();
  reply.code(upstream.status);
  const contentType = upstream.headers.get("content-type");
  reply.header("content-type", contentType || "application/json");
  return reply.send(text);
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
  dashscope: { credId: "vision", fallbackKey: () => config.dashscopeApiKey, baseUrl: () => config.dashscopeMediaBaseUrl },
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

// Transparent proxy for async media (image / video / TTS). `fixedProvider` is
// set for the back-compat /llm/dashscope-media/* alias; otherwise the provider
// comes from the :provider route param.
function mediaHandler(fixedProvider) {
  return async function handleMedia(request, reply) {
    if (!config.modelGatewayEnabled) {
      return reply.code(404).send({ error: { type: "not_found", message: "gateway disabled" } });
    }
    const providerId = String(fixedProvider || request.params.provider || "").toLowerCase();
    const spec = MEDIA_PROVIDERS[providerId];
    if (!spec) {
      return reply.code(404).send({ error: { type: "not_found", message: "unknown media provider" } });
    }
    const token = verifyModelGatewayToken(bearerToken(request), spec.credId);
    if (!token.ok) {
      return reply.code(401).send({ error: { type: "authentication_error", message: token.code } });
    }
    const resolved = resolveCredential(spec.credId, spec.fallbackKey(), spec.baseUrl());
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
    const rest = String(request.params["*"] || "").replace(/^\/+/, "");
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
