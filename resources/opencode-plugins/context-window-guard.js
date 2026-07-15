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
// crash the provider). Normal-sized sessions are untouched — the guard only acts
// when a part exceeds the per-part cap or the whole request exceeds the budget,
// so it never makes a healthy session dumber. The trimmed file/output already
// lives on disk; the model can re-read it with file tools if it needs the rest.
//
// FAIL OPEN: never throws. Kill switch: LILY_CONTEXT_GUARD=0.
// Budgets: LILY_CONTEXT_PART_MAX_CHARS (per part, default 48000),
//          LILY_CONTEXT_TOKEN_BUDGET (whole request estimate, default 700000).
//
// NOTE: only the plugin factory is exported (named + default) — the OpenCode
// loader instantiates every export as a plugin factory, so a helper export would
// crash. Keep all helpers INTERNAL.

const PART_MAX_CHARS = Math.max(4_000, Number(process.env.LILY_CONTEXT_PART_MAX_CHARS) || 48_000);
// Lily sets LILY_CONTEXT_TOKEN_BUDGET per-run from the ACTIVE model's real
// context window (server-delivered LILY_CONTEXT_WINDOW_TOKENS → resolveContextBudget
// → usableInputTokens), so the budget tracks the model instead of guessing. The
// fallback below is only for headless/tests or if that wiring is absent — kept
// CONSERVATIVE (safe for a ~128k model) so an unknown window never overflows;
// it is never a large guess that could break a small model.
const TOKEN_BUDGET = Math.max(50_000, Number(process.env.LILY_CONTEXT_TOKEN_BUDGET) || 110_000);
const MARKER = "[lily: content trimmed to fit the model context window]";

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
function stringSlots(part) {
  const slots = [];
  if (!part || typeof part !== "object") return slots;
  if ((part.type === "text" || part.type === "reasoning") && typeof part.text === "string") {
    slots.push({ get: () => part.text, set: (v) => { part.text = v; } });
  }
  if (part.type === "tool" && part.state && typeof part.state === "object") {
    const st = part.state;
    if (typeof st.output === "string") slots.push({ get: () => st.output, set: (v) => { st.output = v; } });
    if (typeof st.error === "string") slots.push({ get: () => st.error, set: (v) => { st.error = v; } });
    if (st.input && typeof st.input === "object") {
      for (const key of Object.keys(st.input)) {
        if (typeof st.input[key] === "string") {
          slots.push({ get: () => st.input[key], set: (v) => { st.input[key] = v; } });
        }
      }
    }
  }
  return slots;
}

function collectSlots(messages) {
  const slots = [];
  for (const message of messages) {
    const parts = message && Array.isArray(message.parts) ? message.parts : null;
    if (!parts) continue;
    for (const part of parts) slots.push(...stringSlots(part));
  }
  return slots;
}

export const ContextWindowGuardPlugin = async () => ({
  "experimental.chat.messages.transform": async (_input, output) => {
    try {
      if (process.env.LILY_CONTEXT_GUARD === "0") return;
      const messages = output && Array.isArray(output.messages) ? output.messages : null;
      if (!messages) return;
      const slots = collectSlots(messages);
      if (!slots.length) return;

      // Pass 1: hard-cap any single oversized part (kills the giant write-input /
      // tool-output blobs). This alone resolves the common concentrated-blob case.
      for (const slot of slots) {
        const value = slot.get();
        if (value.length > PART_MAX_CHARS) slot.set(trim(value, PART_MAX_CHARS));
      }

      // Pass 2: if the whole request still exceeds the token budget (many medium
      // parts), tighten the cap largest-first until under budget or a floor.
      let total = slots.reduce((sum, s) => sum + estimateTokens(s.get()), 0);
      let cap = PART_MAX_CHARS;
      for (let i = 0; i < 6 && total > TOKEN_BUDGET; i += 1) {
        cap = Math.max(2_000, Math.floor(cap / 2));
        const ranked = slots
          .map((s) => ({ s, len: s.get().length }))
          .sort((a, b) => b.len - a.len);
        for (const { s, len } of ranked) {
          if (len > cap) s.set(trim(s.get(), cap));
        }
        total = slots.reduce((sum, sl) => sum + estimateTokens(sl.get()), 0);
      }
    } catch {
      /* fail open — this guard must never break a turn or compaction */
    }
  },
});

export default ContextWindowGuardPlugin;
