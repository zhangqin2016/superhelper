import { Readable, Transform } from "node:stream";
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
  forwardOpenAiChatCompletions,
  forwardOpenAiModels,
  pipeOpenAiStreamAsAnthropic,
  sendJsonFromOpenAi,
} from "./model-gateway/openai-adapter.js";
import { listModelGatewayProviders } from "./model-gateway/providers.js";
import { discoveredModelMetadataSync } from "./model-gateway/model-discovery.js";
import { chatTokenUsage, gatewayAccountRequired, scanRealTokenUsage, billableRealTokens } from "./model-gateway/usage.js";
import { consumeEntitlement, fetchFeaturePricing } from "./wallet.js";

export { signModelGatewayToken, verifyModelGatewayToken } from "./model-gateway/auth.js";
export { listModelGatewayProviders } from "./model-gateway/providers.js";

function syntheticModels(provider) {
  const models = provider.models?.length
    ? provider.models
    : [provider.model].filter(Boolean);
  const providerMetadata = provider.metadata && typeof provider.metadata === "object" && !Array.isArray(provider.metadata)
    ? provider.metadata
    : {};
  const metadataByModel = providerMetadata.models && typeof providerMetadata.models === "object" && !Array.isArray(providerMetadata.models)
    ? providerMetadata.models
    : {};
  return {
    data: models.map((id) => {
      const configured = metadataByModel[id] && typeof metadataByModel[id] === "object" && !Array.isArray(metadataByModel[id])
        ? metadataByModel[id]
        : {};
      const discovered = discoveredModelMetadataSync(provider, id);
      const maxModelLen = Number(
        configured.maxModelLen ??
          configured.max_model_len ??
          configured.contextWindowTokens ??
          configured.context_window_tokens ??
          discovered.maxModelLen ??
          discovered.max_model_len ??
          discovered.contextWindowTokens ??
          discovered.context_window_tokens,
      );
      return {
        id,
        type: "model",
        display_name: id,
        created_at: null,
        ...(Number.isFinite(maxModelLen) && maxModelLen > 0 ? { max_model_len: Math.floor(maxModelLen) } : {}),
      };
    }),
    has_more: false,
    first_id: models[0] || null,
    last_id: models[models.length - 1] || null,
  };
}

async function upstreamOpenAiModelsOrSynthetic(provider) {
  const configured = provider.models?.length ? new Set(provider.models) : null;
  try {
    const upstream = await forwardOpenAiModels(provider);
    if (!upstream.ok) return syntheticModels(provider);
    const payload = await upstream.json();
    const list = Array.isArray(payload?.data) ? payload.data : Array.isArray(payload?.models) ? payload.models : [];
    const seen = new Set();
    const data = [];
    for (const item of list) {
      const id = String(item?.id || item?.name || "").trim();
      if (!id || seen.has(id)) continue;
      if (configured && !configured.has(id)) continue;
      seen.add(id);
      data.push({ ...item, id });
    }
    if (configured) {
      const synthetic = syntheticModels(provider).data;
      for (const item of synthetic) {
        if (!seen.has(item.id)) data.push(item);
      }
    }
    if (!data.length) return syntheticModels(provider);
    return {
      object: payload?.object || "list",
      data,
      ...(payload?.has_more !== undefined ? { has_more: payload.has_more } : {}),
      ...(payload?.first_id !== undefined ? { first_id: payload.first_id } : {}),
      ...(payload?.last_id !== undefined ? { last_id: payload.last_id } : {}),
    };
  } catch {
    return syntheticModels(provider);
  }
}

function authToken(request) {
  const auth = String(request.headers.authorization || "").trim();
  if (auth.toLowerCase().startsWith("bearer ")) return auth.slice(7).trim();
  return String(request.headers["x-api-key"] || "").trim();
}

function providerContextForRequest(request, reply, defaultProvider = "deepseek") {
  if (!config.modelGatewayEnabled) {
    reply.code(404).send({ error: { type: "not_found", message: "model gateway disabled" } });
    return null;
  }
  const providerId = String(request.params.provider || config.modelGatewayDefaultProvider || defaultProvider).trim();
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
  return { providerId, provider, token };
}

// Reserve (input-estimate) phase. Gates the request: rejects an empty wallet up
// front and returns a billing context so the caller can RECONCILE against the
// provider's real token usage once the response completes. Returns
// { ok:false } (reply already sent) on rejection, or { ok:true, billing } where
// billing is null for non-metered access (license / trial / anonymous).
async function consumeChatUsage({ request, reply, token, providerId, provider, body }) {
  const account = gatewayAccountRequired({ token, enforcementEnabled: config.accountUsageEnforcementEnabled });
  if (!account.ok) {
    reply.code(402).send({ error: { type: "payment_required", message: account.code } });
    return { ok: false };
  }
  if (account.licenseAuthorized || account.trial || account.anonymous) return { ok: true, billing: null };
  const usage = chatTokenUsage({ ...body, model: body.model || provider.model || "" });
  const pricing = await fetchFeaturePricing({
    feature: usage.feature,
    provider: providerId,
    model: usage.model,
    specKey: usage.specKey,
  });
  const idempotencyKey = String(request.headers["x-lily-idempotency-key"] || "").trim().slice(0, 200);
  const consumed = await consumeEntitlement({
    userId: token.userId,
    deviceId: token.deviceId || "",
    licenseId: token.licenseId || "",
    provider: providerId,
    model: usage.model,
    feature: usage.feature,
    specKey: usage.specKey,
    resourceType: usage.resourceType,
    units: usage.units,
    unitCost: pricing.unitCost,
    idempotencyKey,
    metadata: { phase: "input_estimate" },
  });
  if (!consumed.ok) {
    reply.code(402).send({
      error: {
        type: "payment_required",
        message: consumed.code || "ENTITLEMENT_INSUFFICIENT",
        resourceType: usage.resourceType,
        requiredUnits: consumed.requiredUnits || usage.units,
        availableUnits: consumed.availableUnits || 0,
      },
    });
    return { ok: false };
  }
  return {
    ok: true,
    billing: {
      userId: token.userId,
      deviceId: token.deviceId || "",
      licenseId: token.licenseId || "",
      providerId,
      model: usage.model,
      feature: usage.feature,
      specKey: usage.specKey,
      resourceType: usage.resourceType,
      unitCost: pricing.unitCost,
      estimateUnits: usage.units,
      idempotencyKey,
    },
  };
}

// Reconcile phase: charge the DELTA between the provider's real usage
// (input + output tokens) and the already-charged input estimate. Best-effort —
// the estimate is a floor, so we never refund and never fail the turn here.
async function reconcileChatUsage(billing, usage) {
  if (!billing || !usage?.seen) return;
  const realUnits = billableRealTokens(usage);
  const extra = realUnits - Math.max(0, Math.trunc(Number(billing.estimateUnits || 0)));
  if (extra <= 0) return;
  try {
    await consumeEntitlement({
      userId: billing.userId,
      deviceId: billing.deviceId,
      licenseId: billing.licenseId,
      provider: billing.providerId,
      model: billing.model,
      feature: billing.feature,
      specKey: billing.specKey,
      resourceType: billing.resourceType,
      units: extra,
      unitCost: billing.unitCost,
      idempotencyKey: billing.idempotencyKey ? `${billing.idempotencyKey}:final` : "",
      metadata: { phase: "usage_reconcile", inputTokens: usage.inputTokens, outputTokens: usage.outputTokens },
    });
  } catch {
    // The input estimate was already charged; a failed reconcile must not break
    // the response the user already received.
  }
}

// Tee an upstream (SSE or JSON) body through to the client UNCHANGED while
// scanning it for the provider's real token usage, then reconcile on completion.
// Streaming is unaffected: every chunk is forwarded immediately.
function meteredPassthrough(billing) {
  const decoder = new TextDecoder();
  let usage = null;
  const meter = new Transform({
    transform(chunk, _enc, cb) {
      try { usage = scanRealTokenUsage(decoder.decode(chunk, { stream: true }), usage); } catch { /* forward regardless */ }
      cb(null, chunk);
    },
  });
  let settled = false;
  const settle = () => {
    if (settled) return;
    settled = true;
    reconcileChatUsage(billing, usage || { seen: false });
  };
  meter.on("end", settle);
  meter.on("close", settle);
  return meter;
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

  let billing = null;
  if (upstream.ok) {
    const gate = await consumeChatUsage({ request, reply, token, providerId, provider, body });
    if (!gate.ok) return reply;
    billing = gate.billing;
  }

  if (provider.type === "anthropic") {
    reply.code(upstream.status);
    for (const [key, value] of upstream.headers.entries()) {
      if (["content-type", "cache-control"].includes(key.toLowerCase())) reply.header(key, value);
    }
    if (!upstream.body) return reply.send(null);
    const source = Readable.fromWeb(upstream.body);
    if (!billing) return reply.send(source);
    // Meter real usage from the passthrough, then reconcile the wallet debit.
    return reply.send(source.pipe(meteredPassthrough(billing)));
  }

  const onUsage = billing ? (usage) => reconcileChatUsage(billing, usage) : null;
  if (!upstream.ok) return sendJsonFromOpenAi(upstream, reply, body);
  if (body.stream) return pipeOpenAiStreamAsAnthropic(upstream, reply, body, { onUsage });
  return sendJsonFromOpenAi(upstream, reply, body, { onUsage });
}

function providerForRequest(request, reply) {
  return providerContextForRequest(request, reply)?.provider || null;
}

async function handleOpenAiChatCompletionsRequest(request, reply) {
  const context = providerContextForRequest(request, reply);
  if (!context) return reply;
  const { providerId, provider, token } = context;
  if (provider.type !== "openai") {
    return reply.code(400).send({
      error: {
        type: "invalid_request_error",
        message: "OpenAI chat/completions gateway requires an OpenAI-compatible provider",
      },
    });
  }

  const body = request.body && typeof request.body === "object" ? request.body : {};
  let upstream;
  try {
    upstream = await forwardOpenAiChatCompletions(provider, body);
  } catch (err) {
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

  let billing = null;
  if (upstream.ok) {
    const gate = await consumeChatUsage({ request, reply, token, providerId, provider, body });
    if (!gate.ok) return reply;
    billing = gate.billing;
  }

  reply.code(upstream.status);
  for (const [key, value] of upstream.headers.entries()) {
    if (["content-type", "cache-control"].includes(key.toLowerCase())) reply.header(key, value);
  }
  if (!upstream.body) return reply.send(null);
  const source = Readable.fromWeb(upstream.body);
  if (!billing) return reply.send(source);
  return reply.send(source.pipe(meteredPassthrough(billing)));
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

  if (provider.type === "openai") {
    return reply.send(await upstreamOpenAiModelsOrSynthetic(provider));
  }

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
  const openAiChatSchema = {
    schema: {
      tags: ["gateway:model"],
      summary: "Proxy an OpenAI-compatible chat/completions request",
      description:
        "Authenticates the gateway token and forwards the OpenAI-compatible chat/completions body to an OpenAI-compatible upstream provider without Anthropic conversion.",
    },
  };
  app.post("/llm/:provider/v1/messages", messagesSchema, handleGatewayRequest);
  app.post("/llm/:provider/messages", messagesSchema, handleGatewayRequest);
  app.post("/llm/v1/messages", messagesSchema, handleGatewayRequest);
  app.post("/llm/messages", messagesSchema, handleGatewayRequest);
  app.post("/llm/:provider/v1/chat/completions", openAiChatSchema, handleOpenAiChatCompletionsRequest);
  app.post("/llm/v1/chat/completions", openAiChatSchema, handleOpenAiChatCompletionsRequest);
  app.post("/llm/:provider/v1/messages/count_tokens", countTokensSchema, handleCountTokensRequest);
  app.post("/llm/v1/messages/count_tokens", countTokensSchema, handleCountTokensRequest);
  app.get("/llm/:provider/v1/models", modelsSchema, handleModelsRequest);
  app.get("/llm/v1/models", modelsSchema, handleModelsRequest);
}
