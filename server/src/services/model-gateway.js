import { Readable } from "node:stream";
import { config } from "../config.js";
import {
  forwardAnthropic,
  forwardAnthropicCountTokens,
  forwardAnthropicModels,
} from "./model-gateway/anthropic-adapter.js";
import { signModelGatewayToken, verifyModelGatewayToken } from "./model-gateway/auth.js";
import {
  approximateAnthropicInputTokens,
  forwardOpenAi,
  forwardOpenAiModels,
  pipeOpenAiStreamAsAnthropic,
  sendJsonFromOpenAi,
} from "./model-gateway/openai-adapter.js";
import { listModelGatewayProviders } from "./model-gateway/providers.js";

export { signModelGatewayToken, verifyModelGatewayToken } from "./model-gateway/auth.js";
export { listModelGatewayProviders } from "./model-gateway/providers.js";

function syntheticModels(provider) {
  const models = provider.models?.length
    ? provider.models
    : [provider.model].filter(Boolean);
  return {
    data: models.map((id) => ({
      id,
      type: "model",
      display_name: id,
      created_at: null,
    })),
    has_more: false,
    first_id: models[0] || null,
    last_id: models[models.length - 1] || null,
  };
}

function authToken(request) {
  const auth = String(request.headers.authorization || "").trim();
  if (auth.toLowerCase().startsWith("bearer ")) return auth.slice(7).trim();
  return String(request.headers["x-api-key"] || "").trim();
}

async function handleGatewayRequest(request, reply) {
  if (!config.modelGatewayEnabled) return reply.code(404).send({ error: { type: "not_found", message: "model gateway disabled" } });
  const providerId = String(request.params.provider || config.modelGatewayDefaultProvider || "anthropic").trim();
  const providers = listModelGatewayProviders();
  const provider = providers[providerId];
  if (!provider) return reply.code(404).send({ error: { type: "not_found", message: "model provider not configured" } });

  const token = verifyModelGatewayToken(authToken(request), providerId);
  if (!token.ok) return reply.code(401).send({ error: { type: "authentication_error", message: token.code } });
  if (!provider.apiKey || !provider.baseUrl) {
    return reply.code(503).send({ error: { type: "configuration_error", message: "model provider is missing apiKey or baseUrl" } });
  }

  const body = request.body && typeof request.body === "object" ? request.body : {};
  let upstream;
  try {
    upstream = provider.type === "anthropic"
      ? await forwardAnthropic(provider, body, request)
      : await forwardOpenAi(provider, body);
  } catch (err) {
    // Fail LOUD: a dead/stalled upstream (e.g. a GLM model id the endpoint doesn't
    // serve) must surface as a readable error within the connect timeout, not hang
    // the turn at "正在启动…" forever. AbortError == our connect-timeout fired.
    const timedOut = err?.name === "AbortError" || err?.name === "TimeoutError";
    return reply.code(timedOut ? 504 : 502).send({
      error: {
        type: timedOut ? "upstream_timeout" : "upstream_error",
        message: timedOut
          ? `model provider '${providerId}' did not respond in time (check baseUrl/key/model)`
          : `model provider '${providerId}' request failed: ${err?.message || err}`,
      },
    });
  }

  if (provider.type === "anthropic") {
    reply.code(upstream.status);
    for (const [key, value] of upstream.headers.entries()) {
      if (["content-type", "cache-control"].includes(key.toLowerCase())) reply.header(key, value);
    }
    return reply.send(upstream.body ? Readable.fromWeb(upstream.body) : null);
  }

  if (!upstream.ok) return sendJsonFromOpenAi(upstream, reply, body);
  if (body.stream) return pipeOpenAiStreamAsAnthropic(upstream, reply, body);
  return sendJsonFromOpenAi(upstream, reply, body);
}

function providerForRequest(request, reply) {
  if (!config.modelGatewayEnabled) {
    reply.code(404).send({ error: { type: "not_found", message: "model gateway disabled" } });
    return null;
  }
  const providerId = String(request.params.provider || config.modelGatewayDefaultProvider || "deepseek").trim();
  const providers = listModelGatewayProviders();
  const provider = providers[providerId];
  if (!provider) {
    reply.code(404).send({ error: { type: "not_found", message: "model provider not configured" } });
    return null;
  }
  const token = verifyModelGatewayToken(authToken(request), providerId);
  if (!token.ok) {
    reply.code(401).send({ error: { type: "authentication_error", message: token.code } });
    return null;
  }
  if (!provider.apiKey || !provider.baseUrl) {
    reply.code(503).send({ error: { type: "configuration_error", message: "model provider is missing apiKey or baseUrl" } });
    return null;
  }
  return provider;
}

async function handleCountTokensRequest(request, reply) {
  const provider = providerForRequest(request, reply);
  if (!provider) return reply;
  const body = request.body && typeof request.body === "object" ? request.body : {};

  if (provider.type !== "anthropic") {
    return reply.send({ input_tokens: approximateAnthropicInputTokens(body) });
  }

  const upstream = await forwardAnthropicCountTokens(provider, body, request);
  reply.code(upstream.status);
  for (const [key, value] of upstream.headers.entries()) {
    if (["content-type", "cache-control"].includes(key.toLowerCase())) reply.header(key, value);
  }
  return reply.send(upstream.body ? Readable.fromWeb(upstream.body) : null);
}

async function handleModelsRequest(request, reply) {
  const provider = providerForRequest(request, reply);
  if (!provider) return reply;

  if (provider.models?.length || provider.model) {
    return reply.send(syntheticModels(provider));
  }

  const upstream = provider.type === "anthropic"
    ? await forwardAnthropicModels(provider, request)
    : await forwardOpenAiModels(provider);
  if (!upstream.ok) {
    const text = await upstream.text();
    return reply.code(upstream.status).send({ error: { type: "upstream_error", message: text } });
  }
  reply.code(upstream.status);
  for (const [key, value] of upstream.headers.entries()) {
    if (["content-type", "cache-control"].includes(key.toLowerCase())) reply.header(key, value);
  }
  return reply.send(upstream.body ? Readable.fromWeb(upstream.body) : null);
}

export async function modelGatewayRoutes(app) {
  const messagesSchema = {
    schema: {
      tags: ["gateway:model"],
      summary: "Proxy a chat/messages request to a model provider",
      description:
        "Authenticates the gateway token and forwards the Anthropic-compatible messages body to the upstream provider, streaming the response when requested.",
    },
  };
  const countTokensSchema = {
    schema: {
      tags: ["gateway:model"],
      summary: "Count input tokens for a messages request",
      description:
        "Forwards the request to the provider's count_tokens endpoint (or approximates for non-Anthropic providers).",
    },
  };
  const modelsSchema = {
    schema: {
      tags: ["gateway:model"],
      summary: "List models available for a provider",
      description: "Returns the provider's model list, synthesised from config when not fetched upstream.",
    },
  };
  app.post("/llm/:provider/v1/messages", messagesSchema, handleGatewayRequest);
  app.post("/llm/:provider/messages", messagesSchema, handleGatewayRequest);
  app.post("/llm/v1/messages", messagesSchema, handleGatewayRequest);
  app.post("/llm/messages", messagesSchema, handleGatewayRequest);
  app.post("/llm/:provider/v1/messages/count_tokens", countTokensSchema, handleCountTokensRequest);
  app.post("/llm/v1/messages/count_tokens", countTokensSchema, handleCountTokensRequest);
  app.get("/llm/:provider/v1/models", modelsSchema, handleModelsRequest);
  app.get("/llm/v1/models", modelsSchema, handleModelsRequest);
}
