import { config } from "../config.js";
import { verifyModelGatewayToken } from "./model-gateway/auth.js";
import { listModelGatewayProviders } from "./model-gateway/providers.js";

// Resolve a service credential from the DB-backed gateway registry (reserved
// ids "vision" / "search"), falling back to server env for back-compat. Keeping
// these in the same registry means all keys live in the DB and are managed in
// the one admin panel.
function resolveCredential(id, fallbackKey, fallbackBaseUrl) {
  let apiKey = "";
  let baseUrl = "";
  try {
    const provider = listModelGatewayProviders()[id];
    if (provider) {
      apiKey = provider.apiKey || "";
      baseUrl = provider.baseUrl || "";
    }
  } catch {
    // registry unavailable — fall back to env below
  }
  return { apiKey: apiKey || fallbackKey || "", baseUrl: baseUrl || fallbackBaseUrl || "" };
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

// Transparent proxy for DashScope async media (image / video / TTS). The skill
// scripts hit ${base}/llm/dashscope-media + the DashScope path (create:
// /services/..., poll: /tasks/{id}); we map that onto the real api/v1 host and
// inject the key. Uses the same "vision" credential/token (same DashScope
// account). Result files are public OSS URLs the client downloads directly.
async function handleDashscopeMedia(request, reply) {
  if (!config.modelGatewayEnabled) {
    return reply.code(404).send({ error: { type: "not_found", message: "gateway disabled" } });
  }
  const token = verifyModelGatewayToken(bearerToken(request), "vision");
  if (!token.ok) {
    return reply.code(401).send({ error: { type: "authentication_error", message: token.code } });
  }
  const { apiKey } = resolveCredential("vision", config.dashscopeApiKey, "");
  if (!apiKey) {
    return reply.code(503).send({ error: { type: "configuration_error", message: "dashscope key not configured" } });
  }
  const rest = String(request.params["*"] || "").replace(/^\/+/, "");
  const queryIndex = request.url.indexOf("?");
  const query = queryIndex >= 0 ? request.url.slice(queryIndex) : "";
  const url = `${config.dashscopeMediaBaseUrl.replace(/\/+$/, "")}/${rest}${query}`;
  const headers = { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" };
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
  app.post(
    "/llm/dashscope-media/*",
    {
      schema: {
        tags: ["gateway:media"],
        summary: "Proxy a DashScope media request",
        description:
          "Transparently proxies DashScope async media (image/video/TTS) create/poll calls, injecting the server-side key.",
      },
    },
    handleDashscopeMedia,
  );
  app.get(
    "/llm/dashscope-media/*",
    {
      schema: {
        tags: ["gateway:media"],
        summary: "Poll a DashScope media task",
        description: "Transparently proxies DashScope async media task-status polls, injecting the server-side key.",
      },
    },
    handleDashscopeMedia,
  );
}
