"use strict";

/**
 * LLM evidence-entailment judge — the general (non-hardcoded) escalation path
 * for claim support. The deterministic checks in entity-claim-evidence are the
 * FAST PATH and the SAFETY FLOOR: string/regex matching over evidence windows,
 * zero latency, immune to prompt injection. But "does this evidence support
 * this claim?" is a semantic entailment question, and regex vocabularies can
 * never enumerate every domain's defining facts (see the 2026-07-20 informal-
 * classification field failure, memory/2026-07-20-evidence-gate-model-first.md). When the deterministic pass says "unsupported" AND real evidence
 * windows exist for the claim, this judge asks the active session model to rule
 * on entailment — judging ONLY from the quoted excerpts, never from its own
 * knowledge.
 *
 * Hard floors that keep this safe:
 *   - A claim with NO evidence window is never judged (fabricated entities have
 *     nothing to quote, so they can never be laundered through the judge).
 *   - Conflicts detected deterministically are never overridable.
 *   - Accepted labels only WHITELIST the string-level support check; the full
 *     gate re-runs afterwards and every other check still applies.
 *   - Fail-open: no key, unsupported protocol, timeout, or malformed output
 *     simply returns no acceptances — the deterministic verdict stands.
 * Kill switch: LILY_EVIDENCE_LLM_JUDGE=0.
 */

const MAX_JUDGED_CLAIMS = 8;
const MAX_SEMANTIC_SOURCES = 6;
const DEFAULT_TIMEOUT_MS = 8_000;

function judgeEnabled() {
  return process.env.LILY_EVIDENCE_LLM_JUDGE !== "0";
}

/** Resolve a directly callable model connection from the ACTIVE PRESET's own
 *  env — never from the multi-layer merged env (field lesson: stale global
 *  gateway / settings leftovers stitched an OICM+ base onto a deepseek key onto
 *  a Qwen model name → guaranteed 401). Custom presets carry their own BYOK
 *  key; managed presets carry the server-injected gateway token and may use a
 *  relative /llm/<provider> base, which is resolved against the service API
 *  base. Anything unresolved (expired token cache, placeholder) skips cleanly —
 *  the deterministic verdict stands (fail-open, never a crash). */
function resolveJudgeConnection() {
  try {
    const presets = require("./model-presets");
    const preset = presets.getActivePreset?.();
    if (!preset) return null;
    const env = preset.custom
      ? (typeof presets.getUserApiEnv === "function" ? presets.getUserApiEnv() : null)
      : (typeof presets.getActivePresetEnv === "function" ? presets.getActivePresetEnv() : null);
    let baseUrl = String(env?.LILY_API_BASE_URL || "").trim();
    const apiKey = String(env?.LILY_API_KEY || "").trim();
    const model = String(env?.LILY_MODEL || preset.model || "").trim();
    const protocol = String(env?.LILY_OPENCODE_PROTOCOL || "openai").trim().toLowerCase();
    if (baseUrl.startsWith("/")) {
      const serviceBase = String(require("./service-client").configuredServiceApiBaseUrl?.() || "").trim();
      if (serviceBase) baseUrl = `${serviceBase.replace(/\/+$/, "")}${baseUrl}`;
    }
    if (!/^https?:\/\//i.test(baseUrl) || !apiKey || !model || apiKey.startsWith("$")) return null;
    return { baseUrl, apiKey, model, protocol };
  } catch {
    return null;
  }
}

function trimUrl(value = "") {
  return String(value || "").replace(/\/+$/, "");
}

async function postJudgeChat({ connection, prompt, timeoutMs }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("JUDGE_TIMEOUT")), timeoutMs);
  try {
    if (connection.protocol === "anthropic") {
      const response = await fetch(`${trimUrl(connection.baseUrl)}/v1/messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": connection.apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: connection.model,
          max_tokens: 2000,
          messages: [{ role: "user", content: prompt }],
        }),
        signal: controller.signal,
      });
      if (!response.ok) return "";
      const json = await response.json().catch(() => null);
      const parts = Array.isArray(json?.content) ? json.content : [];
      return parts.map((part) => (typeof part?.text === "string" ? part.text : "")).join("");
    }
    const response = await fetch(`${trimUrl(connection.baseUrl)}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${connection.apiKey}`,
      },
      body: JSON.stringify({
        model: connection.model,
        max_tokens: 2000,
        temperature: 0,
        messages: [{ role: "user", content: prompt }],
      }),
      signal: controller.signal,
    });
    if (!response.ok) return "";
    const json = await response.json().catch(() => null);
    const message = json?.choices?.[0]?.message || {};
    // Thinking models may spend the budget on reasoning_content and leave
    // content empty — the verdict JSON is often written there. The verdict
    // parser extracts the JSON block wherever it lives.
    return [message.content, message.reasoning_content, message.reasoning]
      .filter((part) => typeof part === "string" && part.trim())
      .join("\n");
  } catch {
    return "";
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Unified semantic verdict — ONE judge call per turn replacing the per-domain
 * regex vocabularies (classification support, conflict rules, forbidden
 * inferences, gov-domain authority, informal-label detection). The model rules
 * on everything that is inherently semantic; the deterministic layer keeps
 * everything literal (URL/entity/number presence). Hard floors unchanged:
 * only claims with REAL evidence windows are judged, and a malformed/absent
 * verdict degrades to null (caller fail-opens ordinary tiers, fail-closes
 * high-stakes).
 */
function buildSemanticJudgePrompt({ userText = "", claims = [], urls = [] } = {}) {
  const claimBlocks = claims.map((claim, index) => [
    `[claim ${index + 1}] entity: ${claim.label}`,
    `answer sentence: ${claim.sentence || "(not provided)"}`,
    ...claim.windows.map((win, i) => `evidence excerpt ${i + 1}: ${win}`),
  ].join("\n"));
  const urlBlocks = urls.map((url, index) => `[source ${index + 1}] ${url}`);
  const sections = [
    "You are a strict evidence auditor reviewing an AI assistant's answer against evidence collected during this turn.",
    `user question: ${String(userText || "").slice(0, 400)}`,
  ];
  if (claimBlocks.length) {
    sections.push(
      "CLAIMS — for each claim, decide whether the quoted evidence excerpts STATE OR DIRECTLY ENTAIL that the entity satisfies what the answer sentence asserts about it, in the context of the user's question.\nRules:\n- Judge ONLY from the quoted excerpts. Do not use any outside knowledge.\n- 'Directly entail' includes an excerpt stating the DEFINING underlying fact of an informal label (e.g. an appointment announced by the body whose appointments define the category).\n- If the excerpts are unrelated, ambiguous, or merely mention the entity without supporting the assertion, answer unsupported.",
      ...claimBlocks,
    );
  }
  if (urlBlocks.length) {
    sections.push(
      "SOURCES — for each cited URL, decide whether its PUBLISHER is an authoritative or original publication channel for the kind of fact the user asks about (the responsible body, an official organ that formally releases such facts, or the original publisher of the record). You MAY use general knowledge about publishers. General news portals, aggregators, blogs, and social platforms are NOT authoritative even when accurate. When unsure what a domain is, answer not authoritative.",
      ...urlBlocks,
    );
  }
  sections.push(
    "Also answer these meta questions:",
    '- "conflicts": indices of claims whose quoted evidence directly CONTRADICTS the answer sentence (e.g. the entity was merged away, revoked, downgraded, or renamed).',
    '- "informalLabel": true when the label or category the user asks about is an informal convention or an interpretation of underlying facts, rather than an official designation with a published roster.',
    '- "framingNote": when informalLabel is true, ONE short sentence in the user question\'s language stating the honest framing (what the informal label means and which underlying facts it rests on); otherwise an empty string.',
    '- "stakes": "high" only when wrong specifics could cause serious real-world harm (medical, legal, or financial decisions); otherwise "low".',
    'Reply with ONLY this JSON, no other text: {"claims":[{"claim":1,"supported":true|false}],"sources":[{"source":1,"authoritative":true|false}],"conflicts":[2],"informalLabel":false,"framingNote":"","stakes":"low"}',
  );
  return sections.join("\n\n");
}

function parseSemanticVerdict(raw = "", claimCount = 0, sourceCount = 0) {
  const match = String(raw || "").match(/\{[\s\S]*\}/);
  if (!match) return null;
  let parsed = null;
  try {
    parsed = JSON.parse(match[0]);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const supported = new Set();
  for (const verdict of Array.isArray(parsed.claims) ? parsed.claims : []) {
    const index = Number(verdict?.claim);
    if (Number.isInteger(index) && index >= 1 && index <= claimCount && verdict?.supported === true) {
      supported.add(index - 1);
    }
  }
  const authoritative = new Set();
  for (const verdict of Array.isArray(parsed.sources) ? parsed.sources : []) {
    const index = Number(verdict?.source);
    if (Number.isInteger(index) && index >= 1 && index <= sourceCount && verdict?.authoritative === true) {
      authoritative.add(index - 1);
    }
  }
  const conflicts = new Set();
  for (const value of Array.isArray(parsed.conflicts) ? parsed.conflicts : []) {
    const index = Number(value);
    if (Number.isInteger(index) && index >= 1 && index <= claimCount) conflicts.add(index - 1);
  }
  return {
    supported,
    authoritative,
    conflicts,
    informalLabel: parsed.informalLabel === true,
    framingNote: typeof parsed.framingNote === "string" ? parsed.framingNote.trim().slice(0, 300) : "",
    stakes: parsed.stakes === "high" ? "high" : "low",
  };
}

/**
 * @param {{ claims: Array<{label:string, windows:string[], sentence:string}>,
 *           urls: string[], userText: string, timeoutMs?: number,
 *           transport?: Function }} params
 * @returns {Promise<null | { supportedClaims: string[], unsupportedClaims: string[],
 *   authoritativeUrls: string[], conflictingClaims: string[],
 *   informalLabel: boolean, framingNote: string, stakes: "low"|"high" }>}
 *   null = judge unavailable/failed (caller applies the fail boundary).
 */
async function judgeTurnSemantics({
  claims = [],
  urls = [],
  userText = "",
  timeoutMs = Number(process.env.LILY_EVIDENCE_JUDGE_TIMEOUT_MS || DEFAULT_TIMEOUT_MS),
  transport = postJudgeChat,
} = {}) {
  if (!judgeEnabled()) return null;
  const judgedClaims = (Array.isArray(claims) ? claims : [])
    .filter((claim) => claim && Array.isArray(claim.windows) && claim.windows.length)
    .slice(0, MAX_JUDGED_CLAIMS);
  const judgedUrls = [...new Set((Array.isArray(urls) ? urls : [])
    .map((url) => String(url || "").trim())
    .filter((url) => /^https?:\/\//i.test(url)))].slice(0, MAX_SEMANTIC_SOURCES);
  if (!judgedClaims.length && !judgedUrls.length) return null;
  const connection = resolveJudgeConnection();
  if (!connection && transport === postJudgeChat) return null;
  const raw = await transport({
    connection,
    prompt: buildSemanticJudgePrompt({ userText, claims: judgedClaims, urls: judgedUrls }),
    timeoutMs,
  });
  const parsed = parseSemanticVerdict(raw, judgedClaims.length, judgedUrls.length);
  if (!parsed) return null;
  return {
    supportedClaims: judgedClaims.filter((_, index) => parsed.supported.has(index)).map((claim) => claim.label),
    unsupportedClaims: judgedClaims.filter((_, index) => !parsed.supported.has(index)).map((claim) => claim.label),
    authoritativeUrls: judgedUrls.filter((_, index) => parsed.authoritative.has(index)),
    conflictingClaims: judgedClaims.filter((_, index) => parsed.conflicts.has(index)).map((claim) => claim.label),
    informalLabel: parsed.informalLabel,
    framingNote: parsed.framingNote,
    stakes: parsed.stakes,
  };
}

module.exports = {
  buildSemanticJudgePrompt,
  judgeTurnSemantics,
  parseSemanticVerdict,
  resolveJudgeConnection,
};
