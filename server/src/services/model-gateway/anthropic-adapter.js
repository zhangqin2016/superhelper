import { DEFAULT_ANTHROPIC_VERSION } from "./utils.js";

export async function forwardAnthropic(provider, body, request) {
  const target = `${provider.baseUrl}/v1/messages`;
  return fetch(target, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": provider.apiKey,
      "anthropic-version": String(request.headers["anthropic-version"] || DEFAULT_ANTHROPIC_VERSION),
      ...provider.headers,
    },
    body: JSON.stringify(body),
  });
}

export async function forwardAnthropicCountTokens(provider, body, request) {
  const target = `${provider.baseUrl}/v1/messages/count_tokens`;
  return fetch(target, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": provider.apiKey,
      "anthropic-version": String(request.headers["anthropic-version"] || DEFAULT_ANTHROPIC_VERSION),
      ...provider.headers,
    },
    body: JSON.stringify(body),
  });
}

export async function forwardAnthropicModels(provider, request) {
  const target = `${provider.baseUrl}/v1/models`;
  return fetch(target, {
    method: "GET",
    headers: {
      "x-api-key": provider.apiKey,
      "anthropic-version": String(request.headers["anthropic-version"] || DEFAULT_ANTHROPIC_VERSION),
      ...provider.headers,
    },
  });
}
