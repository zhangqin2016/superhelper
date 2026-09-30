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

// Track the REAL token counts the upstream provider reports, incrementally, from
// a streamed SSE body or a JSON body. Anthropic emits usage.input_tokens in the
// message_start event and a growing usage.output_tokens across message_delta
// events; OpenAI reports prompt_tokens/completion_tokens (final chunk needs
// stream_options.include_usage). We keep the MAX seen for each — that yields the
// final input + cumulative output whether streamed or not. `prev` lets a caller
// fold successive chunks. Returns { inputTokens, outputTokens, seen }.
export function scanRealTokenUsage(text, prev = null) {
  const acc = {
    inputTokens: Number(prev?.inputTokens || 0),
    outputTokens: Number(prev?.outputTokens || 0),
    // Cache split, for credit pricing. Anthropic reports cached input apart
    // from input_tokens (cache_read_input_tokens; cache_creation is fresh
    // input); OpenAI-style APIs include cached input INSIDE prompt_tokens and
    // name the cached part (DeepSeek prompt_cache_hit_tokens, OpenAI
    // prompt_tokens_details.cached_tokens).
    cacheReadTokens: Number(prev?.cacheReadTokens || 0),
    cacheWriteTokens: Number(prev?.cacheWriteTokens || 0),
    promptCacheHitTokens: Number(prev?.promptCacheHitTokens || 0),
    format: prev?.format || "",
    seen: Boolean(prev?.seen),
  };
  const chunk = String(text || "");
  const takeMax = (key, current) => {
    let best = current;
    const re = new RegExp(`"${key}"\\s*:\\s*(\\d+)`, "g");
    let m;
    while ((m = re.exec(chunk))) {
      const value = Number(m[1]);
      if (Number.isFinite(value) && value > best) best = value;
    }
    return best;
  };
  if (!acc.format && /"prompt_tokens"/.test(chunk)) acc.format = "openai";
  if (!acc.format && /"input_tokens"/.test(chunk)) acc.format = "anthropic";
  acc.cacheReadTokens = takeMax("cache_read_input_tokens", acc.cacheReadTokens);
  acc.cacheWriteTokens = takeMax("cache_creation_input_tokens", acc.cacheWriteTokens);
  acc.promptCacheHitTokens = Math.max(takeMax("prompt_cache_hit_tokens", acc.promptCacheHitTokens), takeMax("cached_tokens", acc.promptCacheHitTokens));
  const nextInput = Math.max(takeMax("input_tokens", acc.inputTokens), takeMax("prompt_tokens", acc.inputTokens));
  const nextOutput = Math.max(takeMax("output_tokens", acc.outputTokens), takeMax("completion_tokens", acc.outputTokens));
  if (nextInput !== acc.inputTokens || nextOutput !== acc.outputTokens || /"(input|output|prompt|completion)_tokens"/.test(chunk)) {
    acc.seen = true;
  }
  acc.inputTokens = nextInput;
  acc.outputTokens = nextOutput;
  return acc;
}

// Total billable token units = real input + real output. This is what a metered
// (account/wallet) request should ultimately cost — NOT the input-only char/4
// estimate, which ignores output entirely and under-counts CJK text badly.
export function billableRealTokens(usage) {
  const input = Math.max(0, Math.trunc(Number(usage?.inputTokens || 0)));
  const output = Math.max(0, Math.trunc(Number(usage?.outputTokens || 0)));
  return input + output;
}

/**
 * The real usage split the way providers price it: cached input, fresh input,
 * output. Whatever the wire format, cached tokens are counted once.
 */
export function realTokenSplit(usage) {
  const n = (v) => Math.max(0, Math.trunc(Number(v) || 0));
  const output = n(usage?.outputTokens);
  if (usage?.format === "anthropic") {
    return { cachedInputTokens: n(usage.cacheReadTokens), inputTokens: n(usage.inputTokens) + n(usage.cacheWriteTokens), outputTokens: output };
  }
  const prompt = n(usage?.inputTokens);
  const cached = Math.min(prompt, n(usage?.promptCacheHitTokens));
  return { cachedInputTokens: cached, inputTokens: prompt - cached, outputTokens: output };
}

// A signed, server-issued trial window still valid at `nowMs`. The client cannot
// forge this: trialEndsAt is HMAC-signed into the token at config time from the
// device's server-side trial_ends_at (set once on first device registration).
export function tokenTrialActive(token, nowMs = Date.now()) {
  const endsAt = Date.parse(String(token?.trialEndsAt || ""));
  return Number.isFinite(endsAt) && endsAt > nowMs;
}

export function gatewayAccountRequired({ token, enforcementEnabled = false, nowMs = Date.now() } = {}) {
  // A server-validated activation authorizes the device independently of whether
  // the same token also carries a logged-in account. Check it first: otherwise a
  // user who signs in after activating is incorrectly switched back to wallet
  // billing and can hit ENTITLEMENT_INSUFFICIENT despite a valid license.
  if (token?.licenseId) return { ok: true, licenseAuthorized: true };
  if (token?.userId) return { ok: true };
  // Downloaded-but-not-logged-in devices get the operator-configured free trial
  // (license_trial_days). Honored even when usage enforcement is on — otherwise
  // the trial is silently dead and every fresh user hits ACCOUNT_LOGIN_REQUIRED.
  if (tokenTrialActive(token, nowMs)) return { ok: true, trial: true };
  if (!enforcementEnabled) return { ok: true, anonymous: true };
  return { ok: false, code: "ACCOUNT_LOGIN_REQUIRED" };
}
