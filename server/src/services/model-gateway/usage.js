import { approximateAnthropicInputTokens } from "./openai-adapter.js";

export function chatTokenUsage(body = {}) {
  const model = String(body.model || "").trim();
  return {
    feature: "chat_model",
    resourceType: "token",
    specKey: model || "default",
    model,
    units: approximateAnthropicInputTokens(body),
  };
}

export function gatewayAccountRequired({ token, enforcementEnabled = false } = {}) {
  if (token?.userId) return { ok: true };
  if (token?.licenseId) return { ok: true, licenseAuthorized: true };
  if (!enforcementEnabled) return { ok: true, anonymous: true };
  return { ok: false, code: "ACCOUNT_LOGIN_REQUIRED" };
}
