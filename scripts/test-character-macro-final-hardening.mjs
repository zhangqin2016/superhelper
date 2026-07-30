#!/usr/bin/env node

import assert from "node:assert/strict";
import crypto from "node:crypto";
import macrosModule from "../src/main/character-worlds/macros.js";
import constantsModule from "../src/main/character-worlds/constants.js";
import prngModule from "../src/main/character-worlds/macro-prng.js";

const { expandSafeMacros, lexMacros } = macrosModule;
const { DEFAULT_MACRO_LIMITS: L } = constantsModule;
const { createCounterPrng, uniformInt } = prngModule;
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

function assertContextLiteral(input, context) {
  const result = expandSafeMacros(input, context);
  assert.equal(result.text, input);
  assert.deepEqual(result.warnings, [{ code: "MACRO_CONTEXT_INVALID" }]);
}

console.log("character-macro-final-hardening:");

check("rejects every nested proxy value without invoking its traps or coercion", () => {
  const counters = { get: 0, getPrototypeOf: 0, valueOf: 0 };
  function nestedProxy(target) {
    Object.defineProperty(target, "valueOf", {
      configurable: true,
      value() {
        counters.valueOf += 1;
        throw new Error("private valueOf");
      },
    });
    return new Proxy(target, {
      get() {
        counters.get += 1;
        throw new Error("private get");
      },
      getPrototypeOf() {
        counters.getPrototypeOf += 1;
        throw new Error("private getPrototypeOf");
      },
    });
  }

  assertContextLiteral("{{date}}", {
    now: nestedProxy(new Date(0)),
    timeZone: "UTC",
    locale: "en-US",
  });
  assertContextLiteral("{{idle_duration}}", {
    idleDuration: nestedProxy(new Number(1)),
  });
  assertContextLiteral("{{user}}", {
    user: nestedProxy(new String("private")),
  });
  assert.deepEqual(counters, { get: 0, getPrototypeOf: 0, valueOf: 0 });
});

check("rejects ill-formed UTF-16 before expansion or seed hashing", () => {
  const illFormed = ["\ud800", "\udfff"];
  const originalCreateHash = crypto.createHash;
  let hashCalls = 0;
  crypto.createHash = (...args) => {
    hashCalls += 1;
    return originalCreateHash(...args);
  };
  try {
    for (const value of illFormed) {
      assertContextLiteral("{{user}}", { user: value });
      assertContextLiteral("{{pick::a::b}}", { seed: value });
      assert.throws(() => createCounterPrng(value, 0), RangeError);
    }
    assert.equal(hashCalls, 0);
  } finally {
    crypto.createHash = originalCreateHash;
  }

  const pair = "\ud83d\ude00";
  assert.equal(expandSafeMacros("{{user}}", { user: pair }).text, pair);
  assert.match(expandSafeMacros("{{pick::a::b}}", { seed: pair }).text, /^[ab]$/);
});

check("serializes only integer uint32 macro occurrences without truncation", () => {
  const zero = createCounterPrng("occurrence", 0);
  const maximum = createCounterPrng("occurrence", 0xffff_ffff);
  const zeroWords = Array.from({ length: 4 }, () => zero.nextUInt32());
  const maximumWords = Array.from({ length: 4 }, () => maximum.nextUInt32());
  assert.notDeepEqual(maximumWords, zeroWords);
  for (const occurrence of [-1, 1.5, 0x1_0000_0000, Number.MAX_SAFE_INTEGER]) {
    assert.throws(() => createCounterPrng("occurrence", occurrence), RangeError);
  }
});

check("clamps exported rejection probes to the centralized draw ceiling", () => {
  let draws = 0;
  const rejecting = {
    nextUInt32() {
      return 0xffff_ffff;
    },
  };
  const value = uniformInt(rejecting, 3, {
    maxDraws: Number.MAX_SAFE_INTEGER,
    reserveDraw() {
      draws += 1;
      return true;
    },
  });
  assert.equal(value, null);
  assert.equal(draws, L.maxRandomDrawsPerChoice);

  draws = 0;
  assert.equal(uniformInt(rejecting, 3, {
    maxDraws: Number.MAX_SAFE_INTEGER,
    reserveDraw() {
      draws += 1;
      return draws < 3;
    },
  }), null);
  assert.equal(draws, 3);
});

check("rejects ill-formed template UTF-16 before byte counting or lexing", () => {
  const originalByteLength = Buffer.byteLength;
  let byteLengthCalls = 0;
  Buffer.byteLength = (...args) => {
    byteLengthCalls += 1;
    return originalByteLength(...args);
  };
  try {
    for (const invalid of ["\ud800", "\udfff"]) {
      for (const input of [
        invalid,
        `{{uppercase::${invalid}}}`,
        `{{trim::{{uppercase::${invalid}}}}}`,
      ]) {
        const result = expandSafeMacros(input, {});
        assert.equal(result.text, "");
        assert.deepEqual(result.warnings, [{ code: "MACRO_INPUT_UNICODE_INVALID" }]);
        assert.equal(result.stats.failureCode, "MACRO_INPUT_UNICODE_INVALID");
        assert.equal(result.stats.invalidUnicode, true);
        assert.equal(result.stats.inputCodeUnits, input.length);
        assert.equal(result.stats.expansionCount, 0);
        assert.equal(result.stats.inputBytes, 0);
        assert.equal(result.stats.outputBytes, 0);
        assert.equal(result.stats.tokenCount, 0);
        for (const key of [
          "expansionCount", "inputBytes", "inputCodeUnits", "maxDepth",
          "operationCount", "outputBytes", "randomDrawCount", "tokenCount",
        ]) {
          assert.equal(Number.isSafeInteger(result.stats[key]), true);
          assert.ok(result.stats[key] >= 0);
        }
      }
    }

    const allZeroLimits = Object.fromEntries(
      Object.keys(L).filter((key) => key !== "version").map((key) => [key, 0]),
    );
    const oversizedInvalid = `${"a".repeat(650_000)}\ud800`;
    const started = performance.now();
    const bounded = expandSafeMacros(oversizedInvalid, {}, allZeroLimits);
    assert.equal(bounded.text, "");
    assert.deepEqual(bounded.warnings, []);
    assert.equal(bounded.stats.failureCode, "MACRO_LIMIT_INPUT");
    assert.equal(bounded.stats.inputCodeUnits, oversizedInvalid.length);
    assert.equal(bounded.stats.inputBytes, 0);
    assert.equal(bounded.stats.outputBytes, 0);
    assert.ok(performance.now() - started < 1_000);
    assert.equal(byteLengthCalls, 0);
  } finally {
    Buffer.byteLength = originalByteLength;
  }

  assert.equal(expandSafeMacros("{{uppercase::\ud83d\ude00a}}", {}).text, "\ud83d\ude00A");
});

check("accepts only canonical UTC string instants with real calendar components", () => {
  const input = "{{isodate}}T{{isotime}}";
  const base = { locale: "en-US", timeZone: "UTC" };
  for (const now of [
    "2024-02-29T23:59:59Z",
    "2024-02-29T23:59:59.1Z",
    "2024-02-29T23:59:59.12Z",
    "2024-02-29T23:59:59.123Z",
  ]) {
    assert.equal(expandSafeMacros(input, { ...base, now }).text, "2024-02-29T23:59:59");
  }

  for (const now of [
    "2023-02-29T00:00:00Z",
    "2024-00-01T00:00:00Z",
    "2024-13-01T00:00:00Z",
    "2024-01-00T00:00:00Z",
    "2024-04-31T00:00:00Z",
    "2024-01-01T24:00:00Z",
    "2024-01-01T00:60:00Z",
    "2024-01-01T00:00:60Z",
    "2024-01-01T00:00:00+00:00",
    "2024-01-01T00:00:00z",
    "2024-01-01 00:00:00Z",
    "2024-01-01T00:00Z",
    "2024-01-01T00:00:00.Z",
    "2024-01-01T00:00:00.1234Z",
    "2024-01-01",
  ]) {
    assertContextLiteral("{{isodate}}", { ...base, now });
  }
});

check("pins canonical base locales and rejects locale extensions", () => {
  const input = "{{isodate}}";
  const base = { now: "2024-01-02T03:04:05Z", timeZone: "UTC" };
  for (const locale of ["en-US-u-ca-foobar", "en-US-u-nu-foobar", "en-US-u-ca-buddhist",
    "en-US-x-private", "x-private"]) {
    assertContextLiteral(input, { ...base, locale });
  }
  for (const locale of ["EN-us", "en", "zh-cn", "zh-Hant", "iw-IL"]) {
    const result = expandSafeMacros(input, { ...base, locale });
    assert.equal(result.text, "2024-01-02");
    assert.deepEqual(result.warnings, []);
  }
});

check("classifies unknown and blocked macros before touching nested arguments", () => {
  const unknown = "{{unknown::{{roll::100d6}}}}";
  const unknownBudget = unknown.length + lexMacros(unknown).length;
  const unknownResult = expandSafeMacros(unknown, { user: 42, seed: "private" }, {
    maxExpansions: 0,
    maxOperations: unknownBudget,
    maxRandomDrawsPerChoice: 0,
  });
  assert.equal(unknownResult.text, unknown);
  assert.deepEqual(unknownResult.warnings, [{ code: "MACRO_UNKNOWN", name: "unknown" }]);
  assert.equal(unknownResult.stats.expansionCount, 0);
  assert.equal(unknownResult.stats.operationCount, unknownBudget);
  assert.equal(unknownResult.stats.randomDrawCount, 0);

  const blocked = "{{exec::{{unknown}}}}";
  const blockedBudget = blocked.length + lexMacros(blocked).length;
  const blockedResult = expandSafeMacros(blocked, { user: 42 }, {
    maxExpansions: 0,
    maxOperations: blockedBudget,
  });
  assert.equal(blockedResult.text, blocked);
  assert.deepEqual(blockedResult.warnings, [{ code: "MACRO_BLOCKED", name: "exec" }]);
  assert.equal(blockedResult.stats.expansionCount, 0);
  assert.equal(blockedResult.stats.operationCount, blockedBudget);
  assert.equal(blockedResult.stats.randomDrawCount, 0);
});

check("rejects limit proxies without invoking any trap", () => {
  const counters = {
    get: 0,
    getOwnPropertyDescriptor: 0,
    getPrototypeOf: 0,
    ownKeys: 0,
  };
  const limits = new Proxy({}, {
    get() {
      counters.get += 1;
      throw new Error("private get");
    },
    getOwnPropertyDescriptor() {
      counters.getOwnPropertyDescriptor += 1;
      throw new Error("private descriptor");
    },
    getPrototypeOf() {
      counters.getPrototypeOf += 1;
      throw new Error("private prototype");
    },
    ownKeys() {
      counters.ownKeys += 1;
      throw new Error("private keys");
    },
  });
  const result = expandSafeMacros("{{user}}", { user: "private" }, limits);
  assert.equal(result.text, "");
  assert.deepEqual(result.warnings, [{ code: "MACRO_LIMITS_INVALID" }]);
  assert.equal(result.stats.failureCode, "MACRO_LIMITS_INVALID");
  assert.throws(
    () => lexMacros("{{user}}", limits),
    (error) => error?.code === "MACRO_LIMITS_INVALID",
  );
  assert.deepEqual(counters, {
    get: 0,
    getOwnPropertyDescriptor: 0,
    getPrototypeOf: 0,
    ownKeys: 0,
  });
});

check("rejects certain input and elapsed limits before Unicode or UTF-8 scans", () => {
  const huge = "a".repeat(50_000_000);
  const elapsedInput = "a".repeat(200_000);
  const originalByteLength = Buffer.byteLength;
  const originalCharCodeAt = String.prototype.charCodeAt;
  let byteScans = 0;
  let unicodeScans = 0;
  let inputResult;
  let elapsedResult;
  let zeroResult;
  let elapsedMs;
  Buffer.byteLength = () => {
    byteScans += 1;
    throw new Error("unexpected UTF-8 scan");
  };
  String.prototype.charCodeAt = function countedCharCodeAt(...args) {
    unicodeScans += 1;
    return originalCharCodeAt.apply(this, args);
  };
  try {
    const started = performance.now();
    inputResult = expandSafeMacros(huge, {}, {
      maxInputBytes: 1,
      maxOutputBytes: 1,
    });
    elapsedResult = expandSafeMacros(elapsedInput, {}, {
      maxElapsedMs: 0,
    });
    zeroResult = expandSafeMacros("a", {}, {
      maxInputBytes: 0,
      maxOutputBytes: 0,
      maxWarnings: 0,
    });
    elapsedMs = performance.now() - started;
  } finally {
    Buffer.byteLength = originalByteLength;
    String.prototype.charCodeAt = originalCharCodeAt;
  }
  assert.equal(inputResult.text, "");
  assert.deepEqual(inputResult.warnings, [{ code: "MACRO_LIMIT_INPUT" }]);
  assert.equal(inputResult.stats.failureCode, "MACRO_LIMIT_INPUT");
  assert.equal(inputResult.stats.inputCodeUnits, huge.length);
  assert.equal(inputResult.stats.inputBytes, 0);
  assert.equal(inputResult.stats.outputBytes, 0);
  assert.equal(elapsedResult.text, "");
  assert.deepEqual(elapsedResult.warnings, [{ code: "MACRO_LIMIT_ELAPSED" }]);
  assert.equal(elapsedResult.stats.failureCode, "MACRO_LIMIT_ELAPSED");
  assert.equal(zeroResult.text, "");
  assert.deepEqual(zeroResult.warnings, []);
  assert.equal(zeroResult.stats.failureCode, "MACRO_LIMIT_INPUT");
  assert.equal(byteScans, 0);
  assert.equal(unicodeScans, 0);
  assert.ok(elapsedMs < 1_000, `fast rejection took ${elapsedMs}ms`);
});

check("keeps concrete error and blocked warnings ahead of unknown summaries", () => {
  const input = "{{unknown}}{{exec}}{{user}}";
  const bytes = Buffer.byteLength(input);
  const context = { user: "x".repeat(bytes) };
  const one = expandSafeMacros(input, context, {
    maxInputBytes: bytes,
    maxOutputBytes: bytes,
    maxWarnings: 1,
  });
  assert.deepEqual(one.warnings, [{ code: "MACRO_LIMIT_OUTPUT" }]);

  const two = expandSafeMacros(input, context, {
    maxInputBytes: bytes,
    maxOutputBytes: bytes,
    maxWarnings: 2,
  });
  assert.deepEqual(two.warnings, [
    { code: "MACRO_BLOCKED", name: "exec" },
    { code: "MACRO_LIMIT_OUTPUT" },
  ]);
});

check("reserves blocked and truncation slots under an error flood", () => {
  const input = `${"}}".repeat(128)}{{exec}}`;
  const result = expandSafeMacros(input, {});
  assert.equal(result.text, input);
  assert.equal(result.warnings.length, L.maxWarnings);
  assert.equal(
    result.warnings.filter((warning) => warning.code === "MACRO_MALFORMED").length,
    L.maxWarnings - 2,
  );
  assert.deepEqual(result.warnings.at(-2), { code: "MACRO_BLOCKED", name: "exec" });
  assert.deepEqual(result.warnings.at(-1), {
    code: "MACRO_WARNINGS_TRUNCATED",
    counts: { blocked: 0, error: 2, unknown: 0 },
  });

  const expectedByLimit = [
    [],
    [{ code: "MACRO_MALFORMED" }],
    [
      { code: "MACRO_MALFORMED" },
      { code: "MACRO_BLOCKED", name: "exec" },
    ],
    [
      { code: "MACRO_MALFORMED" },
      { code: "MACRO_BLOCKED", name: "exec" },
      {
        code: "MACRO_WARNINGS_TRUNCATED",
        counts: { blocked: 0, error: 127, unknown: 0 },
      },
    ],
  ];
  for (let maxWarnings = 0; maxWarnings <= 3; maxWarnings += 1) {
    const bounded = expandSafeMacros(input, {}, { maxWarnings });
    assert.equal(bounded.text, input);
    assert.deepEqual(bounded.warnings, expectedByLimit[maxWarnings]);
    assert.ok(bounded.warnings.length <= maxWarnings);
  }
});

check("enforces limits on the exported lexer contract", () => {
  assert.equal(lexMacros("é", { maxInputBytes: 2 }).length, 1);
  for (const [text, limits, code] of [
    ["a", { maxInputBytes: 0 }, "MACRO_LIMIT_INPUT"],
    ["{{user}}", { maxTokens: 2 }, "MACRO_LIMIT_TOKENS"],
    ["a", { maxElapsedMs: 0 }, "MACRO_LIMIT_ELAPSED"],
    ["\ud800", {}, "MACRO_INPUT_UNICODE_INVALID"],
  ]) {
    assert.throws(
      () => lexMacros(text, limits),
      (error) => error?.code === code && error.message === code,
    );
  }
});

console.log(`character-macro-final-hardening: ${checks} checks passed`);
