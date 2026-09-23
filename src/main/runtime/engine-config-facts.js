"use strict";

/**
 * What an engine config MEANS — read once, here, instead of re-derived by every
 * caller that needs a piece of it.
 *
 * Two questions kept being answered ad hoc, and both answers went wrong in the
 * field (2026-09-23):
 *
 *   1. "Did the model actually change, or did a credential just rotate?"
 *      The restart decision hashed the whole provider object, credentials
 *      included, so an hourly gateway-token rotation looked exactly like the
 *      operator picking a different model — and the restart path throws the
 *      conversation's resume id away. A new serve process is unavoidable (the
 *      engine reads its config once, at boot); losing the conversation is not.
 *
 *   2. "Is this provider/model reference one the running engine can resolve?"
 *      Nothing checked, so a compaction issued against an engine still running
 *      an older config asked for `lily/…` on a serve that only knew
 *      `lily-model-<hash>/…` and died with ProviderModelNotFoundError. A long
 *      session that cannot compact grows until it deadlocks.
 *
 * Everything here is pure and total: malformed input yields the answer that
 * reproduces today's behaviour, never an exception and never a stricter rule
 * than the caller had before.
 */

/**
 * The one definition of "this field carries a credential".
 *
 * Deliberately conservative: it matches well-known credential names as whole
 * words (optionally prefixed, e.g. `x-api-key`) rather than any field merely
 * containing "key". Over-matching would hide a real routing field — a redacted
 * baseURL would make a genuine endpoint change invisible — while under-matching
 * only falls back to the previous behaviour of treating the change as real.
 * The failure mode therefore degrades to baseline, per CAPABILITY-GATE Rule 13.
 */
const SECRET_KEY_RE = /^(?:[A-Za-z0-9]+[-_])*(?:api[-_]?key|key|token|secret|password|authorization|credential)s?$/i;

const REDACTED = "[secret]";

function isSecretKey(key) {
  return SECRET_KEY_RE.test(String(key || ""));
}

/**
 * A deep copy with every credential-bearing leaf replaced by one constant, so
 * two configs that differ ONLY in their secrets compare equal.
 *
 * Redaction reaches into nested objects (a token lives in `options.headers
 * .Authorization`, not at the top level) while leaving its siblings intact —
 * `x-lily-organization-id` rides in those same headers and genuinely selects a
 * different upstream pool, so it must keep counting as a routing difference.
 */
function redactSecrets(value) {
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (!value || typeof value !== "object") return value;
  const out = {};
  for (const key of Object.keys(value).sort()) {
    out[key] = isSecretKey(key) ? REDACTED : redactSecrets(value[key]);
  }
  return out;
}

function parseConfig(configContent) {
  try {
    const parsed = JSON.parse(String(configContent || "{}"));
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function splitRef(ref) {
  const text = String(ref || "");
  const slash = text.indexOf("/");
  return slash >= 0
    ? { providerID: text.slice(0, slash), modelID: text.slice(slash + 1) }
    : { providerID: "", modelID: text };
}

/**
 * The providers and model references a config actually declares — i.e. what an
 * engine booted from it is able to resolve.
 */
function declaredModels(configContent = "") {
  const parsed = parseConfig(configContent);
  if (!parsed) return { ok: false, providers: [], refs: [], defaultRef: "" };
  const providers = Object.keys(parsed.provider || {});
  const refs = [];
  for (const provider of providers) {
    for (const model of Object.keys(parsed.provider[provider]?.models || {})) {
      refs.push(`${provider}/${model}`);
    }
  }
  return { ok: true, providers, refs, defaultRef: String(parsed.model || "") };
}

/**
 * The model reference it is SAFE to send to an engine running `configContent`.
 *
 * Asking for a provider the engine never loaded is a hard error that costs the
 * whole operation, so a reference that cannot be resolved is replaced by the
 * config's own default, and failing that omitted entirely — an omitted
 * reference makes the engine fall back to the session's own model, which by
 * construction exists there.
 *
 * `reason` explains the outcome so the caller can say WHY it substituted,
 * rather than silently papering over a config desync.
 *
 * @returns {{ providerID?: string, modelID?: string, reason: string }}
 */
function reconcileModelRef({ configContent = "", providerID = "", modelID = "" } = {}) {
  const requested = { providerID: String(providerID || ""), modelID: String(modelID || "") };
  if (!requested.providerID && !requested.modelID) return { reason: "unset" };

  const declared = declaredModels(configContent);
  // Nothing trustworthy to compare against: keep the caller's reference exactly
  // as it was, so an unreadable config can never be worse than before.
  if (!declared.ok || !declared.providers.length) return { ...requested, reason: "unverified" };
  if (declared.providers.includes(requested.providerID)) return { ...requested, reason: "declared" };

  const fallback = splitRef(declared.defaultRef);
  if (fallback.providerID && declared.providers.includes(fallback.providerID)) {
    return { ...fallback, reason: "substituted_default" };
  }
  return { reason: "omitted" };
}

module.exports = {
  REDACTED,
  declaredModels,
  isSecretKey,
  reconcileModelRef,
  redactSecrets,
  splitRef,
};
