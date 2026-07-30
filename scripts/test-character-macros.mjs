#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import macrosModule from "../src/main/character-worlds/macros.js";
import constantsModule from "../src/main/character-worlds/constants.js";
import prngModule from "../src/main/character-worlds/macro-prng.js";

const { expandSafeMacros, lexMacros, parseMacros } = macrosModule;
const { DEFAULT_MACRO_LIMITS } = constantsModule;
const { createMacroPrng, uniformInt } = prngModule;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let checks = 0;

function check(name, fn) {
  try {
    fn();
    checks += 1;
    console.log(`  ok - ${name}`);
  } catch (error) {
    console.error(`  not ok - ${name}`);
    throw error;
  }
}

console.log("character-macros:");

check("expands identity macros without changing Unicode content", () => {
  const input = "Hello {{USER}}, I am {{char}}. {{original}}";
  const context = {
    user: "张三",
    char: "Luna",
    original: "Original Lily",
    seed: "turn-1",
  };
  const result = expandSafeMacros(input, context);
  assert.equal(result.text, "Hello 张三, I am Luna. Original Lily");
  assert.deepEqual(result.warnings, []);
  assert.equal(result.stats.expansionCount, 3);
  assert.equal(input, "Hello {{USER}}, I am {{char}}. {{original}}");
  assert.deepEqual(context, {
    user: "张三",
    char: "Luna",
    original: "Original Lily",
    seed: "turn-1",
  });
});

check("seeded random selection is replayable", () => {
  const input = "{{random::red::blue::green}}/{{pick::one::two::three}}";
  const first = expandSafeMacros(input, { seed: "turn-1" });
  const replay = expandSafeMacros(input, { seed: "turn-1" });
  assert.deepEqual(replay, first);
  assert.match(first.text, /^(red|blue|green)\/(one|two|three)$/);
});

check("unknown and blocked names stay exact and warn without arguments", () => {
  const input = "{{unknown::private-value}} {{exec::rm -rf secret}}";
  const result = expandSafeMacros(input, { seed: "turn-1" });
  assert.equal(result.text, input);
  assert.deepEqual(result.warnings, [
    { code: "MACRO_UNKNOWN", name: "unknown" },
    { code: "MACRO_BLOCKED", name: "exec" },
  ]);
  assert(!JSON.stringify(result.warnings).includes("private-value"));
  assert(!JSON.stringify(result.warnings).includes("rm -rf secret"));
});

check("lexes escaped delimiters and parses nested macro arguments", () => {
  const escaped = String.raw`\{{user}} \}} \:: \\ {{uppercase::{{trim:: hello {{user}} }}}}`;
  const result = expandSafeMacros(escaped, { user: "张三", seed: "syntax" });
  assert.equal(result.text, String.raw`{{user}} }} :: \ HELLO 张三`);
  assert.deepEqual(result.warnings, []);

  const generated = expandSafeMacros("{{user}}", {
    user: "{{exec::not-run}}",
    seed: "syntax",
  });
  assert.equal(generated.text, "{{exec::not-run}}");
  assert.deepEqual(generated.warnings, []);

  const tokens = lexMacros("a{{trim::{{user}}}}b");
  const ast = parseMacros(tokens, DEFAULT_MACRO_LIMITS);
  assert.deepEqual(tokens.map((token) => token.type), [
    "text", "open", "text", "separator", "open", "text", "close", "close", "text",
  ]);
  assert.equal(ast[1].type, "macro");
  assert.equal(ast[1].name, "trim");
  assert.equal(ast[1].args[0][0].name, "user");
});

check("keeps malformed and unclosed delimiters literal", () => {
  const input = "before }} middle {{user after";
  const result = expandSafeMacros(input, { user: "private", seed: "syntax" });
  assert.equal(result.text, input);
  assert.deepEqual(result.warnings, [
    { code: "MACRO_MALFORMED" },
    { code: "MACRO_MALFORMED" },
  ]);
  assert(!JSON.stringify(result.warnings).includes("private"));
});

check("runs locale-independent transforms with strict argument counts", () => {
  const input = [
    "{{trim::  keep  }}",
    "{{uppercase::Straße 张三}}",
    "{{lowercase::İSTANBUL ABC}}",
    "{{uppercase::one::private-two}}",
  ].join("|");
  const result = expandSafeMacros(input, { seed: "transforms" });
  assert.equal(
    result.text,
    "keep|STRASSE 张三|i̇stanbul abc|{{uppercase::one::private-two}}",
  );
  assert.deepEqual(result.warnings, [
    { code: "MACRO_ARGUMENT_INVALID", name: "uppercase" },
  ]);
  assert(!JSON.stringify(result.warnings).includes("private-two"));
});

check("formats one supplied instant in an explicit timezone and locale", () => {
  const realDateNow = Date.now;
  Date.now = () => {
    throw new Error("clock read");
  };
  try {
    const result = expandSafeMacros(
      "{{time}}|{{date}}|{{weekday}}|{{isotime}}|{{isodate}}|{{idle_duration}}",
      {
        now: "2024-01-02T03:04:05.000Z",
        timeZone: "UTC",
        locale: "en-US",
        idleDuration: 3_661_000,
        seed: "time",
      },
    );
    assert.equal(result.text, "03:04:05|01/02/2024|Tuesday|03:04:05|2024-01-02|1h 1m 1s");
    assert.deepEqual(result.warnings, []);
  } finally {
    Date.now = realDateNow;
  }
});

check("invalid date, timezone, locale, and idle snapshots fail literal", () => {
  for (const context of [
    { now: "not-a-date", timeZone: "UTC", locale: "en-US", seed: "bad" },
    { now: "2024-01-02T03:04:05Z", timeZone: "Not/AZone", locale: "en-US", seed: "bad" },
    { now: "2024-01-02T03:04:05Z", timeZone: "UTC", locale: "not_a_locale", seed: "bad" },
    { idleDuration: -1, seed: "bad" },
  ]) {
    const input = context.idleDuration === -1 ? "{{idle_duration}}" : "{{date}}";
    const result = expandSafeMacros(input, context);
    assert.equal(result.text, input);
    assert.deepEqual(result.warnings, [{ code: "MACRO_CONTEXT_INVALID" }]);
  }
});

check("never invokes context getters", () => {
  let getterCalls = 0;
  const context = {};
  Object.defineProperty(context, "user", {
    enumerable: true,
    get() {
      getterCalls += 1;
      return "private-user";
    },
  });
  const result = expandSafeMacros("{{user}}", context);
  assert.equal(getterCalls, 0);
  assert.equal(result.text, "{{user}}");
  assert.deepEqual(result.warnings, [{ code: "MACRO_CONTEXT_INVALID" }]);
  assert(!JSON.stringify(result).includes("private-user"));
});

check("prototype and side-effect names never resolve dynamically", () => {
  const names = [
    "constructor", "__proto__", "toString",
    "exec", "shell", "js", "eval", "fetch", "http",
    "file", "env", "system", "command", "api", "tool",
  ];
  const input = names.map((name) => `{{${name}::private}}`).join(" ");
  const result = expandSafeMacros(input, { seed: "blocked" });
  assert.equal(result.text, input);
  assert.deepEqual(result.warnings, names.map((name) => ({
    code: [
      "exec", "shell", "js", "eval", "fetch", "http",
      "file", "env", "system", "command", "api", "tool",
    ].includes(name.toLowerCase()) ? "MACRO_BLOCKED" : "MACRO_UNKNOWN",
    name: name.toLowerCase(),
  })));
  assert(!JSON.stringify(result.warnings).includes("private"));
});

check("roll accepts only bounded dice grammar and is deterministic", () => {
  const input = "{{roll::d6}}/{{roll::2d6+3}}/{{roll::100d1-5}}";
  const first = expandSafeMacros(input, { seed: "dice" });
  assert.deepEqual(expandSafeMacros(input, { seed: "dice" }), first);
  const values = first.text.split("/").map(Number);
  assert(values[0] >= 1 && values[0] <= 6);
  assert(values[1] >= 5 && values[1] <= 15);
  assert.equal(values[2], 95);
  assert.equal(first.stats.randomDrawCount, 103);

  for (const dice of [
    "", "2dd6", "0d6", "d0", "101d6", "1d1000001",
    "1d6+1000001", "1d6-1000001", "1d6 + 2", "9007199254740991d6",
  ]) {
    const source = `{{roll::${dice}}}`;
    const result = expandSafeMacros(source, { seed: "dice" });
    assert.equal(result.text, source);
    assert.deepEqual(result.warnings, [{ code: "MACRO_DICE_INVALID", name: "roll" }]);
    if (dice) assert(!JSON.stringify(result.warnings).includes(dice));
  }
});

check("counter PRNG rejects biased words and varies uniformly across seeds", () => {
  let rejection = null;
  for (let index = 0; index < 64 && !rejection; index += 1) {
    const prng = createMacroPrng(`reject-${index}`, 0);
    const value = uniformInt(prng, 0x8000_0001);
    if (prng.wordsRead > 1) rejection = { value, wordsRead: prng.wordsRead };
  }
  assert(rejection, "statistical fixture must exercise rejection sampling");
  assert(rejection.value >= 0 && rejection.value < 0x8000_0001);
  assert(rejection.wordsRead > 1);

  const counts = [0, 0, 0];
  const outputs = new Set();
  for (let index = 0; index < 6_000; index += 1) {
    const value = uniformInt(createMacroPrng(`probe-${index}`, 7), 3);
    counts[value] += 1;
    outputs.add(value);
  }
  assert.equal(outputs.size, 3);
  for (const count of counts) assert(count > 1_800 && count < 2_200, counts.join(","));

  const macroOutputs = new Set();
  for (let index = 0; index < 24; index += 1) {
    macroOutputs.add(expandSafeMacros(
      "{{pick::one::two::three}}",
      { seed: `macro-seed-${index}` },
    ).text);
  }
  assert.equal(macroOutputs.size, 3);
});

check("enforces exact UTF-8 input and output byte boundaries", () => {
  const atInput = expandSafeMacros("éé", {}, { maxInputBytes: 4 });
  assert.equal(atInput.text, "éé");
  assert.deepEqual(atInput.warnings, []);
  const overInput = expandSafeMacros("ééa", {}, { maxInputBytes: 4 });
  assert.equal(overInput.text, "ééa");
  assert.deepEqual(overInput.warnings, [{ code: "MACRO_LIMIT_INPUT" }]);

  const outputLimits = { maxInputBytes: 8, maxOutputBytes: 8 };
  const atOutput = expandSafeMacros("{{user}}", { user: "éééé" }, outputLimits);
  assert.equal(atOutput.text, "éééé");
  assert.equal(atOutput.stats.outputBytes, 8);
  const overOutput = expandSafeMacros("{{user}}", { user: "ééééa" }, outputLimits);
  assert.equal(overOutput.text, "{{user}}");
  assert.equal(overOutput.stats.outputBytes, 8);
  assert.deepEqual(overOutput.warnings, [{ code: "MACRO_LIMIT_OUTPUT" }]);
});

check("enforces token, nesting, expansion, and warning limits", () => {
  const tokenLimited = expandSafeMacros("{{user}}", { user: "x" }, { maxTokens: 2 });
  assert.equal(tokenLimited.text, "{{user}}");
  assert.deepEqual(tokenLimited.warnings, [{ code: "MACRO_LIMIT_TOKENS" }]);

  const nest = (depth) => `${"{{trim::".repeat(depth)}x${"}}".repeat(depth)}`;
  assert.equal(expandSafeMacros(nest(8), {}).text, "x");
  const nested = expandSafeMacros(nest(9), {});
  assert.equal(nested.text, nest(9));
  assert.deepEqual(nested.warnings, [{ code: "MACRO_LIMIT_NESTING" }]);

  const thousand = "{{user}}".repeat(DEFAULT_MACRO_LIMITS.maxExpansions);
  assert.equal(
    expandSafeMacros(thousand, { user: "x" }).text,
    "x".repeat(DEFAULT_MACRO_LIMITS.maxExpansions),
  );
  const expansionLimited = expandSafeMacros(`${thousand}{{user}}`, { user: "x" });
  assert(expansionLimited.text.endsWith("{{user}}"));
  assert.deepEqual(expansionLimited.warnings, [{ code: "MACRO_LIMIT_EXPANSIONS" }]);

  const warnings = expandSafeMacros(
    Array.from({ length: 10 }, (_, index) => `{{unknown_${index}}}`).join(""),
    {},
    { maxWarnings: 3 },
  ).warnings;
  assert.equal(warnings.length, 3);
  assert.deepEqual(warnings.at(-1), {
    code: "MACRO_WARNINGS_TRUNCATED",
    counts: { blocked: 0, error: 0, unknown: 8 },
  });
  assert.deepEqual(
    expandSafeMacros("{{unknown}}", {}, { maxWarnings: 0 }).warnings,
    [],
  );
  assert.deepEqual(
    expandSafeMacros("abc", {}, { maxInputBytes: 2, maxWarnings: 0 }).warnings,
    [],
  );
});

check("bounds argument count and UTF-8 argument bytes", () => {
  const options64 = Array.from({ length: 64 }, (_, index) => `v${index}`);
  assert.match(
    expandSafeMacros(`{{pick::${options64.join("::")}}}`, { seed: "args" }).text,
    /^v\d+$/,
  );
  const tooMany = `{{pick::${[...options64, "private-65"].join("::")}}}`;
  const countResult = expandSafeMacros(tooMany, { seed: "args" });
  assert.equal(countResult.text, tooMany);
  assert.deepEqual(countResult.warnings, [{ code: "MACRO_LIMIT_ARGS", name: "pick" }]);

  assert.equal(
    expandSafeMacros("{{trim::éé}}", {}, { maxArgBytes: 4 }).text,
    "éé",
  );
  const byteResult = expandSafeMacros("{{trim::éé}}", {}, { maxArgBytes: 3 });
  assert.equal(byteResult.text, "{{trim::éé}}");
  assert.deepEqual(byteResult.warnings, [{ code: "MACRO_LIMIT_ARG_BYTES", name: "trim" }]);

  const totalResult = expandSafeMacros(
    "{{pick::é::é}}",
    { seed: "args" },
    { maxTotalArgBytes: 3 },
  );
  assert.equal(totalResult.text, "{{pick::é::é}}");
  assert.deepEqual(totalResult.warnings, [
    { code: "MACRO_LIMIT_ARG_BYTES", name: "pick" },
  ]);

  const huge = `{{trim::${"a".repeat(DEFAULT_MACRO_LIMITS.maxArgBytes + 1)}}}`;
  const hugeResult = expandSafeMacros(huge, {});
  assert.equal(hugeResult.text, huge);
  assert.deepEqual(hugeResult.warnings, [
    { code: "MACRO_LIMIT_ARG_BYTES", name: "trim" },
  ]);

  for (const source of ["{{random}}", "{{pick::}}", "{{random::one::::three}}"]) {
    const result = expandSafeMacros(source, { seed: "args" });
    assert.equal(result.text, source);
    assert.deepEqual(result.warnings, [
      { code: "MACRO_ARGUMENT_INVALID", name: source.includes("pick") ? "pick" : "random" },
    ]);
  }
});

check("operation and elapsed budgets stop safely and deterministically", () => {
  const operation = expandSafeMacros("{{user}}", { user: "private" }, { maxOperations: 1 });
  assert.equal(operation.text, "{{user}}");
  assert.deepEqual(operation.warnings, [{ code: "MACRO_LIMIT_OPERATIONS" }]);
  const elapsed = expandSafeMacros("{{user}}", { user: "private" }, { maxElapsedMs: 0 });
  assert.equal(elapsed.text, "");
  assert.deepEqual(elapsed.warnings, [{ code: "MACRO_LIMIT_ELAPSED" }]);
  assert(!JSON.stringify([operation.warnings, elapsed.warnings]).includes("private"));
});

check("caller overrides lower but never raise centralized hard limits", () => {
  const input = "{{user}}".repeat(DEFAULT_MACRO_LIMITS.maxExpansions + 1);
  const result = expandSafeMacros(
    input,
    { user: "x" },
    { maxExpansions: DEFAULT_MACRO_LIMITS.maxExpansions + 10_000 },
  );
  assert(result.text.endsWith("{{user}}"));
  assert.deepEqual(result.warnings, [{ code: "MACRO_LIMIT_EXPANSIONS" }]);
  assert.equal(Object.isFrozen(DEFAULT_MACRO_LIMITS), true);
});

check("implementation has no dynamic code, ambient authority, or Math.random", () => {
  const files = ["macros.js", "macro-parser.js", "macro-prng.js"];
  const source = files
    .map((name) => fs.readFileSync(path.join(ROOT, "src/main/character-worlds", name), "utf8"))
    .join("\n");
  assert(!source.includes("Math.random"));
  assert(!source.includes("process.env"));
  assert(!source.includes("globalThis"));
  assert(!source.includes("new Function"));
  assert(!/\beval\s*\(/.test(source));
  assert(!/require\s*\(\s*[^"'`]/.test(source), "require targets must be static literals");
});

check("near-maximum literal input remains bounded and fast", () => {
  const input = `${"é".repeat((DEFAULT_MACRO_LIMITS.maxInputBytes - 8) / 2)}{{user}}`;
  const started = process.hrtime.bigint();
  const result = expandSafeMacros(input, { user: "x" });
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  assert.equal(result.stats.inputBytes, DEFAULT_MACRO_LIMITS.maxInputBytes);
  assert(result.text.endsWith("x"));
  assert(elapsedMs < DEFAULT_MACRO_LIMITS.maxElapsedMs, `elapsed ${elapsedMs}ms`);
});

console.log(`character-macros: ${checks} checks passed`);
