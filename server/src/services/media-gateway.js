import { config } from "../config.js";
import { verifyModelGatewayToken } from "./model-gateway/auth.js";

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
  if (!config.dashscopeApiKey) {
    return reply.code(503).send({ error: { type: "configuration_error", message: "vision key not configured" } });
  }
  const url = `${config.visionUpstreamBaseUrl.replace(/\/+$/, "")}/chat/completions`;
  let upstream;
  try {
    upstream = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.dashscopeApiKey}`,
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
  if (!config.webSearchIqsApiKey) {
    return reply.code(503).send({ error: { type: "configuration_error", message: "search key not configured" } });
  }
  let upstream;
  try {
    upstream = await fetch(config.webSearchIqsApiUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.webSearchIqsApiKey}`,
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

export async function mediaGatewayRoutes(app) {
  app.post("/llm/vision/chat/completions", handleVision);
  app.post("/llm/search", handleSearch);
}
