// Lily credits (积分): the one currency model usage is charged in.
//
// 1 yuan = 1000 credits (decided 2026-09-30). Each model consumes credits at its
// own rate per million tokens, split three ways because providers price them
// three ways: input served from the provider's cache, input not cached, and
// output. Rates live in feature_pricing_rules.metadata of the chat_model rule
// for that model (spec_key = model id), so a new model or a supplier price
// change is an admin edit, not a release:
//
//   metadata: { creditsPerMillion: { inputCached, input, output } }
//
// A model with no rate is charged at FALLBACK_RATE — the most expensive model
// we sell — so a missing rule can cost a user more, never cost us a loss.
// The wallet stores credits in the resource_type "token" balance (the column
// name predates credits; migration 065 converted the amounts).

export const CREDITS_PER_YUAN = 1000;

// deepseek-v4-pro at peak supplier price, sold at 30% gross margin.
export const FALLBACK_RATE = Object.freeze({ inputCached: 450, input: 13000, output: 39000 });

function positive(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/** The credit rate for a pricing rule (or the fallback), per million tokens. */
export function creditRateFor(rule) {
  const rate = rule?.metadata?.creditsPerMillion;
  const inputCached = positive(rate?.inputCached);
  const input = positive(rate?.input);
  const output = positive(rate?.output);
  if (input === null || output === null) return { ...FALLBACK_RATE, fallback: true };
  return { inputCached: inputCached ?? input, input, output, fallback: false };
}

/**
 * Credits for what the provider really reported. Whole credits, rounded up:
 * a request is never free because it was small.
 */
export function creditsForUsage({ cachedInputTokens = 0, inputTokens = 0, outputTokens = 0 } = {}, rate = FALLBACK_RATE) {
  const cached = Math.max(0, Math.trunc(Number(cachedInputTokens) || 0));
  const fresh = Math.max(0, Math.trunc(Number(inputTokens) || 0));
  const out = Math.max(0, Math.trunc(Number(outputTokens) || 0));
  const micro = cached * rate.inputCached + fresh * rate.input + out * rate.output;
  return micro > 0 ? Math.ceil(micro / 1_000_000) : 0;
}

/**
 * The up-front reservation before the provider answers: the estimated input
 * priced as if it were all cached (the cheapest case). It only has to prove the
 * balance can pay for the request; the real cost is charged when the answer
 * completes, so the floor never overcharges an agent whose context is cached.
 */
export function reserveCredits(estimatedInputTokens, rate = FALLBACK_RATE) {
  return Math.max(1, creditsForUsage({ cachedInputTokens: estimatedInputTokens }, rate));
}

/**
 * Old token balances in credits, by value: 1M tokens were charged one unit
 * each regardless of model, and the traffic was flash-dominant — worth about
 * 1,600 credits per million at today's flash rate with cache hits.
 */
export const LEGACY_CREDITS_PER_MILLION_TOKENS = 1600;
