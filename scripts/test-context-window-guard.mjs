#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const mod = await import(path.join(__dirname, "../resources/opencode-plugins/context-window-guard.js"));
const { ContextWindowGuardPlugin } = mod;

// export-only-the-factory regression guard (OpenCode instantiates every export)
{
  const exported = Object.keys(mod).filter((k) => k !== "default");
  assert.deepEqual(exported, ["ContextWindowGuardPlugin"], `plugin must export only the factory, got: ${exported.join(",")}`);
  assert.equal(typeof mod.default, "function", "default export is the factory");
}

process.env.LILY_CONTEXT_PART_MAX_CHARS = "";
process.env.LILY_CONTEXT_TOKEN_BUDGET = "";
const hooks = await ContextWindowGuardPlugin({});
const transform = hooks["experimental.chat.messages.transform"];
assert.equal(typeof transform, "function", "registers the messages.transform hook");
const MARKER = "content trimmed to fit the model context window";

// --- the smoking gun: a write tool-call INPUT holding a huge file -----------
{
  const huge = "D".repeat(2_000_000); // ~2 MB write content stored in history
  const msgs = [
    { info: { role: "user" }, parts: [{ type: "text", text: "build the data file" }] },
    {
      info: { role: "assistant" },
      parts: [
        {
          type: "tool",
          tool: "write",
          callID: "c1",
          state: { status: "completed", input: { filePath: "/points/data.json", content: huge }, output: "wrote 2000000 bytes" },
        },
      ],
    },
  ];
  await transform({}, { messages: msgs });
  const input = msgs[1].parts[0].state.input;
  assert.ok(input.content.length < huge.length, "the giant write INPUT is bounded (engine never trims tool input)");
  assert.ok(input.content.includes(MARKER), "trimmed input carries the marker");
  assert.equal(input.filePath, "/points/data.json", "small input fields are preserved");
  assert.equal(msgs[0].parts[0].text, "build the data file", "small text parts are untouched");
}

// --- large tool OUTPUT is bounded too ---------------------------------------
{
  const bigOut = "O".repeat(500_000);
  const msgs = [{ info: { role: "assistant" }, parts: [{ type: "tool", tool: "bash", callID: "c2", state: { status: "completed", input: { command: "cat big" }, output: bigOut } }] }];
  await transform({}, { messages: msgs });
  assert.ok(msgs[0].parts[0].state.output.length < bigOut.length, "oversized tool output is bounded");
}

// --- a healthy small session is left completely untouched (no dumber) -------
{
  const msgs = [
    { info: { role: "user" }, parts: [{ type: "text", text: "hello" }] },
    { info: { role: "assistant" }, parts: [{ type: "text", text: "hi, how can I help?" }, { type: "reasoning", text: "the user greeted me" }] },
  ];
  const before = JSON.stringify(msgs);
  await transform({}, { messages: msgs });
  assert.equal(JSON.stringify(msgs), before, "small sessions pass through byte-identical — the guard never trims within budget");
}

// --- many medium parts: total-budget pass tightens until under budget -------
{
  process.env.LILY_CONTEXT_TOKEN_BUDGET = "60000"; // force the second pass
  const hooks2 = await (await import(path.join(__dirname, "../resources/opencode-plugins/context-window-guard.js") + `?v=${2}`)).ContextWindowGuardPlugin({});
  const transform2 = hooks2["experimental.chat.messages.transform"];
  const msgs = [];
  for (let i = 0; i < 40; i += 1) {
    msgs.push({ info: { role: "assistant" }, parts: [{ type: "tool", tool: "read", callID: `k${i}`, state: { status: "completed", input: { path: `/f${i}` }, output: "M".repeat(40_000) } }] });
  }
  await transform2({}, { messages: msgs });
  const est = msgs.reduce((sum, m) => sum + m.parts[0].state.output.length, 0) * 0.28;
  assert.ok(est <= 60000 * 1.3, "the adaptive pass brings many-medium-parts under the token budget");
  // pairing preserved: still 40 tool parts, none dropped
  assert.equal(msgs.length, 40, "no messages/tool parts are dropped — pairing is preserved");
  process.env.LILY_CONTEXT_TOKEN_BUDGET = "";
}

// --- fail-open + kill switch ------------------------------------------------
await transform({}, null);
await transform({}, { messages: null });
await transform({}, { messages: [null, {}, { parts: [null, { type: "tool" }] }] });
{
  process.env.LILY_CONTEXT_GUARD = "0";
  const hooks3 = await (await import(path.join(__dirname, "../resources/opencode-plugins/context-window-guard.js") + `?v=${3}`)).ContextWindowGuardPlugin({});
  const transform3 = hooks3["experimental.chat.messages.transform"];
  const huge = "Z".repeat(2_000_000);
  const msgs = [{ info: { role: "assistant" }, parts: [{ type: "tool", tool: "write", callID: "x", state: { status: "completed", input: { content: huge }, output: "" } }] }];
  await transform3({}, { messages: msgs });
  assert.equal(msgs[0].parts[0].state.input.content.length, huge.length, "kill switch disables all trimming");
  delete process.env.LILY_CONTEXT_GUARD;
}

// --- MODEL-AWARE budget: the guard tracks the real model window -------------
// Lily derives LILY_CONTEXT_TOKEN_BUDGET from the active model's context window
// via resolveContextBudget. A deepseek-scale window must NOT over-trim content
// that fits (not dumber), while content beyond it is still bounded (never breaks).
{
  const require2 = (await import("node:module")).createRequire(import.meta.url);
  const { resolveContextBudget } = require2(path.join(__dirname, "../src/main/context-budget-manager.js"));

  const deepseek = resolveContextBudget({ contextWindowTokens: 1048565 });
  assert.ok(deepseek.usableInputTokens < 1048565 && deepseek.usableInputTokens > 800000,
    "a ~1M model yields a large-but-reserved budget, not a hardcoded guess");
  const small = resolveContextBudget({ contextWindowTokens: 32000 });
  assert.ok(small.usableInputTokens < 32000, "a 32k model yields a small budget so it never overflows");
  assert.ok(deepseek.usableInputTokens > small.usableInputTokens * 10, "the budget scales with the model window");

  process.env.LILY_CONTEXT_TOKEN_BUDGET = String(deepseek.usableInputTokens);
  const g = await (await import(path.join(__dirname, "../resources/opencode-plugins/context-window-guard.js") + `?v=ma`)).ContextWindowGuardPlugin({});
  const t = g["experimental.chat.messages.transform"];

  // ~500k tokens of content on a ~964k budget: fits → left intact (not dumber).
  const fits = [];
  for (let i = 0; i < 20; i += 1) fits.push({ info: { role: "assistant" }, parts: [{ type: "tool", tool: "read", callID: `f${i}`, state: { status: "completed", input: { path: `/f${i}` }, output: "本".repeat(24_000) } }] });
  const beforeFits = JSON.stringify(fits);
  await t({}, { messages: fits });
  assert.equal(JSON.stringify(fits), beforeFits, "content that fits the real model window is NOT trimmed — no capability lost");

  // ~1.3M tokens on the same budget: bounded back under it (never breaks).
  const over = [];
  for (let i = 0; i < 55; i += 1) over.push({ info: { role: "assistant" }, parts: [{ type: "tool", tool: "read", callID: `o${i}`, state: { status: "completed", input: { path: `/o${i}` }, output: "本".repeat(24_000) } }] });
  await t({}, { messages: over });
  const overTokens = over.reduce((sum, m) => sum + m.parts[0].state.output.length, 0); // CJK ≈ 1 token/char
  assert.ok(overTokens <= deepseek.usableInputTokens * 1.05, "an over-window session is bounded back under the real model budget");
  process.env.LILY_CONTEXT_TOKEN_BUDGET = "";
}

// registered as an engine plugin + Lily wires the model-aware budget
const poolSrc = fs.readFileSync(path.join(__dirname, "../src/main/session-runner-pool.js"), "utf8");
assert.ok(poolSrc.includes("context-window-guard.js"), "plugin must be registered in the runner plugin list");
assert.ok(/LILY_CONTEXT_TOKEN_BUDGET/.test(poolSrc) && /resolveContextBudget/.test(poolSrc),
  "Lily must set the model-aware LILY_CONTEXT_TOKEN_BUDGET for the engine");

console.log("context-window-guard: ok");
