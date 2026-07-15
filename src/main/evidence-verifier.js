"use strict";

// Semantic claim verification (LLM-as-judge) — the frontier upgrade to the regex
// evidence-gate. Given the assistant's ANSWER and the EVIDENCE it actually
// gathered this turn (tool outputs / file reads from the EvidenceLedger), a cheap
// verifier model judges which factual claims are NOT backed by that evidence.
// This moves us from "detecting the SHAPE of grounding" (regex markers) to
// "checking the CONTENT" (does the evidence actually support this number/cause?).
//
// Design contract:
// - PURE + TESTABLE: the model call is injected as `callModel({system,user}) ->
//   string`, so the core has no network dependency.
// - FAIL OPEN: any error/timeout/unparseable output => { ok:true, unsupported:[],
//   degraded:true } — we NEVER block or downgrade an answer on a verifier failure;
//   we fall back to the existing regex gate. A verifier that goes down must not
//   make the platform dumber than baseline.
// - Bounded: inputs are truncated, output is a small JSON list.

const crypto = require("node:crypto");

const VERIFIER_SYSTEM = [
  "You are a strict fact-checker for an AI assistant's answer.",
  "You are given the EVIDENCE the assistant actually gathered this turn (tool outputs, file reads) and its ANSWER.",
  "Judge ONLY concrete factual claims: numbers/counts/percentages, causes ('because/root cause'), data completeness/coverage, and 'fixed/verified/deployed/done' claims.",
  "A claim is SUPPORTED only if the EVIDENCE directly backs it. If the evidence does not contain support, the claim is UNSUPPORTED even when it sounds plausible.",
  "Do NOT flag opinions, plans, recommendations, hedged/uncertain statements, or claims already marked unverified/unknown.",
  'Output ONLY compact JSON on one line: {"unsupported":["<claim copied verbatim, short>", ...]}. Use an empty array if every factual claim is supported.',
].join("\n");

const MAX_EVIDENCE_CHARS = 12_000;
const MAX_ANSWER_CHARS = 12_000;

function buildVerifierMessages({ answer = "", evidenceText = "" } = {}) {
  const user = [
    "=== EVIDENCE (what the assistant actually gathered this turn) ===",
    (String(evidenceText || "").trim() || "(no evidence was gathered)").slice(0, MAX_EVIDENCE_CHARS),
    "",
    "=== ANSWER ===",
    String(answer || "").slice(0, MAX_ANSWER_CHARS),
    "",
    'Return the UNSUPPORTED factual claims as JSON: {"unsupported":[...]}.',
  ].join("\n");
  return { system: VERIFIER_SYSTEM, user };
}

// Parse the verifier's reply. Tolerant: finds the first JSON object; on anything
// unexpected returns a supported verdict (fail-open — never invent unsupported
// claims from a garbled reply).
function parseVerdict(text) {
  try {
    const match = String(text || "").match(/\{[\s\S]*\}/);
    if (!match) return { ok: true, unsupported: [], parsed: false };
    const data = JSON.parse(match[0]);
    const unsupported = Array.isArray(data && data.unsupported)
      ? data.unsupported.map((x) => String(x || "").trim()).filter(Boolean).slice(0, 20)
      : [];
    return { ok: unsupported.length === 0, unsupported, parsed: true };
  } catch {
    return { ok: true, unsupported: [], parsed: false };
  }
}

async function verifyAnswer({ answer = "", evidenceText = "", callModel, timeoutMs = 12_000 } = {}) {
  try {
    if (typeof callModel !== "function") return { ok: true, unsupported: [], degraded: true };
    if (!String(answer || "").trim()) return { ok: true, unsupported: [], degraded: true };
    const { system, user } = buildVerifierMessages({ answer, evidenceText });
    const out = await Promise.race([
      Promise.resolve(callModel({ system, user })),
      new Promise((_, reject) => setTimeout(() => reject(new Error("verifier_timeout")), Math.max(1_000, timeoutMs))),
    ]);
    return { ...parseVerdict(out), degraded: false };
  } catch {
    return { ok: true, unsupported: [], degraded: true };
  }
}

// Build the injected caller from a resolved model endpoint (managed gateway OR a
// user's custom BYOK endpoint — model-agnostic). OpenAI-compatible /chat/completions.
// Returns null when the endpoint is incomplete, so the caller degrades cleanly.
function makeChatCaller({ baseUrl = "", apiKey = "", model = "", maxTokens = 400, temperature = 0 } = {}) {
  const url = String(baseUrl || "").trim().replace(/\/+$/, "");
  if (!url || !String(model || "").trim()) return null;
  return async ({ system, user }) => {
    const response = await fetch(`${url}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        max_tokens: maxTokens,
        temperature,
        stream: false,
      }),
    });
    if (!response.ok) throw new Error(`verifier http ${response.status}`);
    const data = await response.json();
    return data?.choices?.[0]?.message?.content || "";
  };
}

// A short, specific hint for the verify-before-assert retry, naming the exact
// claims the verifier found unsupported (far more actionable than the generic hint).
function unsupportedClaimsHint(unsupported = [], zh = false) {
  const list = (Array.isArray(unsupported) ? unsupported : []).slice(0, 8).map((c) => `- ${c}`).join("\n");
  if (!list) return "";
  return zh
    ? [
        "[系统纠正] 以下断言未被你本轮收集到的证据支撑,不能当作事实:",
        list,
        "请先用工具逐条核实(读文件/跑检查,给出 file:line 或命令输出),核实不了就明说未验证,再作答。",
      ].join("\n")
    : [
        "[system correction] These claims are NOT supported by the evidence you gathered this turn and must not be stated as fact:",
        list,
        "Verify each with a tool first (read the file / run the check, cite file:line or command output); if it cannot be verified, say so. Then answer.",
      ].join("\n");
}

function verdictId(unsupported = []) {
  return crypto.createHash("sha1").update((Array.isArray(unsupported) ? unsupported : []).join("|")).digest("hex").slice(0, 8);
}

module.exports = {
  VERIFIER_SYSTEM,
  buildVerifierMessages,
  parseVerdict,
  verifyAnswer,
  makeChatCaller,
  unsupportedClaimsHint,
  verdictId,
};
