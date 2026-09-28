// Keep the conversation within the model's context window by bounding oversized
// PART CONTENT right before every model call — the engine-side escape from the
// "too big to run, too big to compact" deadlock.
//
// THE BUG: a data-heavy session accumulates enormous parts in stored history —
// above all a `write`/`edit` tool call whose INPUT holds a whole large file
// (6 MB), plus large tool OUTPUTS. The engine's own `truncateToolOutput` trims
// only tool OUTPUT, and only on the compaction path — never tool INPUT, never on
// the build path. So the request grows past the model limit (e.g. deepseek
// 1,048,565 tokens). Then the engine tries to COMPACT, but compaction must send
// the whole head to the summarizer, which ALSO overflows → it can never shrink →
// the engine retries build/compaction in a loop, each round appending and
// growing the context further. Deadlock.
//
// WHY HERE: `experimental.chat.messages.transform` fires on BOTH the turn path
// (prompt.ts) and the compaction path (compaction.ts), before `toModelMessages`.
// Bounding here makes BOTH calls fit, so compaction can finally summarize and the
// turn can run — breaking the loop model-agnostically.
//
// SAFE BY DESIGN: only oversized string CONTENT is trimmed (tool input/output,
// text/reasoning) to head+tail+marker; whole messages and tool-call/result
// PAIRING are never dropped (dropping a tool call or its result would itself
// crash the provider). With a known window the guard acts only when the whole
// request would not fit that window, measured against the engine's reported
// usage; only with an UNKNOWN window does it cap single oversized parts, so it
// never makes a healthy session dumber. The trimmed file/output already
// lives on disk; the model can re-read it with file tools if it needs the rest.
//
// NOT ALL CONTENT MAY BE EXCERPTED. A tool output or an earlier answer survives
// head+tail trimming — the model reasons about it and some text beats none. The
// INPUT of a write/edit call does not: it is a file body the model may be asked
// to REPRODUCE, and head+tail reads as a whole file, so the model completes the
// middle from imagination and writes that back. Those slots are replaced by a
// pointer to the file on disk instead — which cannot be mistaken for the whole,
// says where the whole is, and costs a line instead of thousands of characters,
// leaving that budget to parts that are still worth keeping. See
// lib/history-elision.cjs.
//
// FAIL OPEN: never throws. Kill switch: LILY_CONTEXT_GUARD=0.
// Budgets: LILY_CONTEXT_TOKEN_BUDGETS (per model, JSON), LILY_CONTEXT_TOKEN_BUDGET
//          (fallback input limit; absent = unknown), LILY_CONTEXT_PART_MAX_CHARS
//          (per-part cap used only when the window is unknown, default 48000).
//
// NOTE: only the plugin factory is exported (named + default) — the OpenCode
// loader instantiates every export as a plugin factory, so a helper export would
// crash. Keep all helpers INTERNAL.

import elision from "./lib/history-elision.cjs";

const PART_MAX_CHARS = Math.max(4_000, Number(process.env.LILY_CONTEXT_PART_MAX_CHARS) || 48_000);
// Lily sets LILY_CONTEXT_TOKEN_BUDGET per-run to the ACTIVE model's real input
// limit (its window minus the output reserve) — and only when that window is
// known. There is no fallback guess: an unknown window used to become ~110,000
// here, and a 1M model then had every request trimmed, down to the question
// in the user's own message (2026-09-27). Without a budget only the per-part
// cap applies, and the engine compacts when the provider reports an overflow.
const TOKEN_BUDGET = Number(process.env.LILY_CONTEXT_TOKEN_BUDGET) > 0
  ? Math.max(1_000, Number(process.env.LILY_CONTEXT_TOKEN_BUDGET))
  : 0;
// One serve runs every model in its config, so each turn is measured against
// the budget of the model it actually runs on ("providerID/modelID" → tokens,
// from LILY_CONTEXT_TOKEN_BUDGETS); the single budget is the fallback.
const MODEL_BUDGETS = (() => {
  try {
    const parsed = JSON.parse(process.env.LILY_CONTEXT_TOKEN_BUDGETS || "{}");
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
})();

function budgetFor(messages, requestIndex) {
  const model = messages[requestIndex]?.info?.model;
  const own = model ? Number(MODEL_BUDGETS[`${model.providerID}/${model.modelID}`]) : 0;
  return own > 0 ? Math.max(1_000, own) : TOKEN_BUDGET;
}
// Used only before the engine has reported any usage: the estimate covers the
// trimmable parts, not the system prompt and tool schemas beside them.
const UNMEASURED_HEADROOM = 0.85;
const MARKER = elision.elide({ what: "content", action: "Re-read the source if you need the rest." });

// Rough, CJK-aware token estimate (no tokenizer in a plugin). CJK ~1 token/char,
// other text ~0.28 token/char. Deliberately conservative so we act early enough.
function estimateTokens(text) {
  const s = String(text || "");
  if (!s) return 0;
  let cjk = 0;
  for (let i = 0; i < s.length; i += 1) {
    const c = s.charCodeAt(i);
    if (c >= 0x3040 && c <= 0x9fff) cjk += 1;
    else if (c >= 0xac00 && c <= 0xd7a3) cjk += 1;
  }
  return Math.ceil(cjk + (s.length - cjk) * 0.28);
}

function trim(text, maxChars) {
  const s = String(text || "");
  // A trimmed string ends up shorter than its cap, so this length check alone is
  // idempotent (re-running at the same cap is a no-op) while still allowing pass
  // 2 to re-trim an already-marked string down to a SMALLER cap. head/tail slices
  // never include the middle where the old marker sat, so only one marker
  // survives a re-trim.
  if (s.length <= maxChars) return s;
  const headLen = Math.floor(maxChars * 0.7);
  const tailLen = Math.max(0, maxChars - headLen - 200);
  const head = s.slice(0, headLen);
  const tail = tailLen > 0 ? s.slice(-tailLen) : "";
  return `${head}\n\n${MARKER}: ${s.length} chars; middle omitted. Re-read the source file/tool result if you need the rest.\n\n${tail}`;
}

// The large string fields carried by a stored part. Returns [{get,set}] accessors
// so we can measure and rewrite in place without knowing every part variant.
function filePathFromInput(input) {
  for (const key of ["filePath", "file_path", "path", "filename", "file"]) {
    const value = input && input[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function stringSlots(part) {
  const slots = [];
  if (!part || typeof part !== "object") return slots;
  if ((part.type === "text" || part.type === "reasoning") && typeof part.text === "string") {
    slots.push({ get: () => part.text, set: (v) => { part.text = v; } });
  }
  if (part.type === "tool" && part.state && typeof part.state === "object") {
    const st = part.state;
    const tool = String(part.tool || "");
    if (typeof st.output === "string") slots.push({ get: () => st.output, set: (v) => { st.output = v; } });
    if (typeof st.error === "string") slots.push({ get: () => st.error, set: (v) => { st.error = v; } });
    if (st.input && typeof st.input === "object") {
      const path = filePathFromInput(st.input);
      for (const key of Object.keys(st.input)) {
        if (typeof st.input[key] === "string") {
          slots.push({
            get: () => st.input[key],
            set: (v) => { st.input[key] = v; },
            // A file body may be reproduced, so it is pointed at rather than excerpted.
            reproducible: elision.isReproducible(tool, key),
            path,
          });
        }
      }
    }
  }
  return slots;
}

// The message the model is being asked to answer: the latest user message that
// carries text the user (or Lily for them) wrote — not an engine-synthetic one.
function currentRequestIndex(messages) {
  let fallback = -1;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message?.info?.role !== "user" || !Array.isArray(message.parts)) continue;
    if (fallback < 0) fallback = i;
    if (message.parts.some((part) => part?.type === "text" && !part.synthetic && String(part.text || "").trim())) return i;
  }
  return fallback;
}

function collectSlots(messages) {
  const slots = [];
  const request = currentRequestIndex(messages);
  messages.forEach((message, index) => {
    const parts = message && Array.isArray(message.parts) ? message.parts : null;
    if (!parts) return;
    for (const part of parts) {
      for (const slot of stringSlots(part)) slots.push({ ...slot, index, request: index === request });
    }
  });
  return slots;
}

// The request size the engine last reported: an assistant message's tokens are
// its latest step's, input + cache + output — the same count the engine's own
// overflow check uses.
function reportedTokens(info) {
  const t = info && info.tokens;
  if (!t || typeof t !== "object") return 0;
  const cache = t.cache || {};
  return Number(t.total) || (Number(t.input) || 0) + (Number(t.output) || 0) + (Number(cache.read) || 0) + (Number(cache.write) || 0);
}

// What the next request will cost. Measured where the engine has reported: the
// last reported request, minus what trimming saves from it, plus what was
// added since. The report is the provider's own count, so it wins over the
// character estimate (which over-counts Chinese by design) — except right after
// this guard trimmed that session: the report then counted a trimmed history,
// so the untrimmed estimate plus the overhead the report revealed is the floor.
// Estimated with headroom when nothing has been reported yet.
const sessions = new Map(); // sessionID -> { overhead, trimmed }
function sessionNote(sessionID, patch) {
  if (!sessionID) return;
  const next = { ...(sessions.get(sessionID) || {}), ...patch };
  sessions.delete(sessionID);
  sessions.set(sessionID, next);
  if (sessions.size > 256) sessions.delete(sessions.keys().next().value);
}

function projector(messages, slots) {
  let anchor = -1;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i]?.info?.role === "assistant" && reportedTokens(messages[i].info) > 0) { anchor = i; break; }
  }
  const original = slots.map((slot) => estimateTokens(slot.get()));
  if (anchor < 0) return { sessionID: "", project: () => slots.reduce((sum, slot) => sum + estimateTokens(slot.get()), 0) / UNMEASURED_HEADROOM };
  const reported = reportedTokens(messages[anchor].info);
  const sessionID = String(messages[anchor].info.sessionID || "");
  const prior = sessions.get(sessionID) || {};
  const upToAnchor = slots.reduce((sum, slot, i) => sum + (slot.index <= anchor ? original[i] : 0), 0);
  const measured = reported - upToAnchor;
  if (measured > 0 && !prior.trimmed) sessionNote(sessionID, { overhead: measured });
  const overhead = measured > 0 && !prior.trimmed ? measured : prior.overhead || 0;
  return {
    sessionID,
    project: () => {
      let all = 0, saved = 0, after = 0;
      slots.forEach((slot, i) => {
        const now = estimateTokens(slot.get());
        all += now;
        if (slot.index <= anchor) saved += original[i] - now; else after += now;
      });
      const fromReport = reported - saved + after;
      return prior.trimmed ? Math.max(fromReport, all + overhead) : fromReport;
    },
  };
}

export const ContextWindowGuardPlugin = async () => ({
  "experimental.chat.messages.transform": async (_input, output) => {
    try {
      if (process.env.LILY_CONTEXT_GUARD === "0") return;
      const messages = output && Array.isArray(output.messages) ? output.messages : null;
      if (!messages) return;
      const slots = collectSlots(messages);
      if (!slots.length) return;
      const budget = budgetFor(messages, currentRequestIndex(messages));

      // Pass 1 — ONLY when the window is unknown. With nothing to measure
      // against, a single oversized part (a multi-megabyte write input) is
      // capped so the request and its compaction can fit at all: the deadlock
      // escape. With a known window it used to run anyway and cut the middle
      // out of every part over 48k chars — a long report the user then asked to
      // revise — however much room the model had; measured pressure below
      // decides instead.
      if (!budget) {
        for (const slot of slots) {
          const value = slot.get();
          if (value.length <= PART_MAX_CHARS) continue;
          slot.set(slot.reproducible ? elision.elideFileBody({ path: slot.path, bytes: value.length }) : trim(value, PART_MAX_CHARS));
        }
        return;
      }

      // Pass 2: only when the request would not fit the known limit —
      // compaction (Lily's before the turn, the engine's after each step) acts
      // below this line, so the guard is the last resort, not the everyday
      // trimmer. Tighten the cap largest-first until it fits or a floor.
      // The current request is history's reader, not history: it is never
      // excerpted to make room. Field case 2026-09-27: a new question arrived
      // in a long session over budget; its 10,870-char message was cut to head
      // + tail, which kept the platform context and the attachment note and
      // dropped the question in the middle, and the model — reasoning "there
      // is no user request" — resumed the previous task instead.
      const { sessionID, project: projected } = projector(messages, slots);
      if (projected() <= budget) { sessionNote(sessionID, { trimmed: false }); return; }
      sessionNote(sessionID, { trimmed: true });
      // The largest per-part cap that fits: trimmed only as far as needed, so
      // the request lands just under the limit — where the engine's usage
      // report makes compaction fire next — instead of far below it, where
      // nothing would ever compact and every later call would be trimmed too.
      const trimmable = slots.filter((s) => !s.request).map((s) => ({ s, value: s.get() }));
      const apply = (cap) => {
        for (const { s, value } of trimmable) {
          s.set(value.length <= cap ? value : s.reproducible ? elision.elideFileBody({ path: s.path, bytes: value.length }) : trim(value, cap));
        }
      };
      // Upper bound: the longest part, so a request that fits once one 200k part
      // is cut to 150k is not cut to 48k.
      let lo = 2_000, hi = Math.max(lo, ...trimmable.map(({ value }) => value.length));
      apply(lo);
      if (projected() > budget) return; // the floor is all that can be done
      while (hi - lo > 500) {
        const mid = Math.floor((lo + hi) / 2);
        apply(mid);
        if (projected() <= budget) lo = mid; else hi = mid;
      }
      apply(lo);
    } catch {
      /* fail open — this guard must never break a turn or compaction */
    }
  },
});

export default ContextWindowGuardPlugin;
