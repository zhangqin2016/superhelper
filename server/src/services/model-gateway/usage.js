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

// A signed, server-issued trial window still valid at `nowMs`. The client cannot
// forge this: trialEndsAt is HMAC-signed into the token at config time from the
// device's server-side trial_ends_at (set once on first device registration).
export function tokenTrialActive(token, nowMs = Date.now()) {
  const endsAt = Date.parse(String(token?.trialEndsAt || ""));
  return Number.isFinite(endsAt) && endsAt > nowMs;
}

export function gatewayAccountRequired({ token, enforcementEnabled = false, nowMs = Date.now() } = {}) {
  if (token?.userId) return { ok: true };
  if (token?.licenseId) return { ok: true, licenseAuthorized: true };
  // Downloaded-but-not-logged-in devices get the operator-configured free trial
  // (license_trial_days). Honored even when usage enforcement is on — otherwise
  // the trial is silently dead and every fresh user hits ACCOUNT_LOGIN_REQUIRED.
  if (tokenTrialActive(token, nowMs)) return { ok: true, trial: true };
  if (!enforcementEnabled) return { ok: true, anonymous: true };
  return { ok: false, code: "ACCOUNT_LOGIN_REQUIRED" };
}
