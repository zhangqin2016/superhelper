#!/usr/bin/env node

import assert from "node:assert/strict";
import crypto from "node:crypto";
import macrosModule from "../src/main/character-worlds/macros.js";
import constantsModule from "../src/main/character-worlds/constants.js";
import prngModule from "../src/main/character-worlds/macro-prng.js";

const { expandSafeMacros } = macrosModule;
const { DEFAULT_MACRO_LIMITS: L } = constantsModule;
const { createMacroPrng, uniformInt } = prngModule;
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

function literal(input, context, code = "MACRO_CONTEXT_INVALID", limits) {
  const result = expandSafeMacros(input, context, limits);
  assert.equal(result.text, input);
  assert.deepEqual(result.warnings, [{ code }]);
  assert.equal(typeof result.stats, "object");
  return result;
}

console.log("character-macro-hardening:");

check("rejects proxies without invoking any proxy trap", () => {
  const trapCalls = [];
  const proxy = new Proxy({ user: "private" }, {
    get() {
      trapCalls.push("get");
      throw new Error("private get");
    },
    getOwnPropertyDescriptor() {
      trapCalls.push("descriptor");
      throw new Error("private descriptor");
    },
    getPrototypeOf() {
      trapCalls.push("prototype");
      throw new Error("private prototype");
    },
    ownKeys() {
      trapCalls.push("keys");
      throw new Error("private keys");
    },
  });
  literal("{{user}}", proxy);
  assert.deepEqual(trapCalls, []);
});

check("rejects symbols, custom prototypes, dangerous keys, and accessors", () => {
  let getterCalls = 0;
  const symbolContext = { user: "private", [Symbol("private")]: "value" };
  literal("{{user}}", symbolContext);

  const custom = Object.create({ inherited: "private" });
  custom.user = "private";
  literal("{{user}}", custom);

  for (const key of ["__proto__", "constructor", "prototype"]) {
    const context = { user: "private" };
    Object.defineProperty(context, key, {
      configurable: true,
      enumerable: true,
      value: "private-key",
    });
    literal("{{user}}", context);
  }

  const accessor = {};
  Object.defineProperty(accessor, "user", {
    enumerable: true,
    get() {
      getterCalls += 1;
      return "private-getter";
    },
  });
  literal("{{user}}", accessor);
  assert.equal(getterCalls, 0);
});

check("bounds every context string, aggregate bytes, and seed bytes exactly", () => {
  assert(Number.isSafeInteger(L.maxContextStringBytes));
  assert(Number.isSafeInteger(L.maxContextTotalBytes));
  assert(Number.isSafeInteger(L.maxSeedBytes));

  const exactUser = "é".repeat(L.maxContextStringBytes / 2);
  assert.equal(expandSafeMacros("{{user}}", { user: exactUser }).text, exactUser);
  literal("{{user}}", { user: `${exactUser}a` });

  const exactSeed = "s".repeat(L.maxSeedBytes);
  assert.match(
    expandSafeMacros("{{pick::a::b}}", { seed: exactSeed }).text,
    /^[ab]$/,
  );
  literal("{{pick::a::b}}", { seed: `${exactSeed}s` });

  const originalCreateHash = crypto.createHash;
  let hashCalls = 0;
  crypto.createHash = (...args) => {
    hashCalls += 1;
    return originalCreateHash(...args);
  };
  try {
    assert.throws(
      () => createMacroPrng(`${exactSeed}s`, 0).nextUInt32(),
      RangeError,
    );
    assert.equal(hashCalls, 0);
  } finally {
    crypto.createHash = originalCreateHash;
  }

  const half = "a".repeat(L.maxContextTotalBytes / 2);
  assert.equal(
    expandSafeMacros("{{user}}{{char}}", { user: half, char: half }).text.length,
    L.maxContextTotalBytes,
  );
  literal("{{user}}", { user: half, char: half, original: "x" });

  const now = "2024-01-02T03:04:05.000Z";
  const remaining = L.maxContextTotalBytes
    - Buffer.byteLength(now)
    - Buffer.byteLength("UTC")
    - Buffer.byteLength("en-US");
  const user = "u".repeat(L.maxContextStringBytes);
  const char = "c".repeat(remaining - user.length);
  assert.equal(
    expandSafeMacros("{{isodate}}", {
      user,
      char,
      now,
      timeZone: "UTC",
      locale: "en-US",
    }).text,
    "2024-01-02",
  );
  literal("{{isodate}}", {
    user,
    char: `${char}x`,
    now,
    timeZone: "UTC",
    locale: "en-US",
  });
});

check("validates Date range, locale support, and timezone before formatting", () => {
  for (const now of [new Date(NaN), 8.64e15 + 1, -8.64e15 - 1]) {
    literal("{{isodate}}", {
      now,
      timeZone: "UTC",
      locale: "en-US",
    });
  }
  literal("{{date}}", {
    now: 0,
    timeZone: "UTC",
    locale: "zz-ZZ",
  });
  literal("{{date}}", {
    now: 0,
    timeZone: "Invalid/Zone",
    locale: "en-US",
  });
});

check("turns unexpected Intl validation failures into stable literal results", () => {
  const OriginalDateTimeFormat = Intl.DateTimeFormat;
  Intl.DateTimeFormat = function ThrowingFormatter() {
    throw new Error("private formatter failure");
  };
  try {
    const result = literal("{{date}}", {
      now: 0,
      timeZone: "UTC",
      locale: "en-US",
    });
    assert(!JSON.stringify(result).includes("private formatter failure"));
  } finally {
    Intl.DateTimeFormat = OriginalDateTimeFormat;
  }
});

check("reserves every owner before recursively evaluating its arguments", () => {
  const prefix998 = "{{user}}".repeat(998);
  const exact = expandSafeMacros(`${prefix998}{{trim::{{user}}}}`, { user: "x" });
  assert.equal(exact.text, "x".repeat(999));
  assert.equal(exact.stats.expansionCount, 1_000);
  assert.deepEqual(exact.warnings, []);

  const prefix999 = "{{user}}".repeat(999);
  const nested = "{{trim::{{user}}}}";
  const limited = expandSafeMacros(`${prefix999}${nested}`, { user: "x" });
  assert.equal(limited.text, `${"x".repeat(999)}${nested}`);
  assert.equal(limited.stats.expansionCount, 1_000);
  assert.deepEqual(limited.warnings, [{ code: "MACRO_LIMIT_EXPANSIONS" }]);
});

check("applies argument byte limits again after nested expansion", () => {
  const source = "{{trim::{{user}}}}";
  const result = expandSafeMacros(source, {
    user: "expanded-private-value",
  }, {
    maxArgBytes: 32,
    maxTotalArgBytes: 10,
  });
  assert.equal(result.text, source);
  assert.deepEqual(result.warnings, [
    { code: "MACRO_LIMIT_ARG_BYTES", name: "trim" },
  ]);
  assert(!JSON.stringify(result.warnings).includes("expanded-private-value"));
});

check("shares operation budget with every deterministic dice draw", () => {
  const source = "{{roll::3d6}}";
  const baseline = expandSafeMacros(source, { seed: "operation-draws" });
  assert.match(baseline.text, /^\d+$/);
  const limited = expandSafeMacros(source, { seed: "operation-draws" }, {
    maxOperations: baseline.stats.operationCount - 1,
  });
  assert.equal(limited.text, source);
  assert.deepEqual(limited.warnings, [{ code: "MACRO_LIMIT_OPERATIONS" }]);
});

check("caps rejection draws and invokes the shared budget callback per word", () => {
  let draws = 0;
  const rejecting = {
    nextUInt32() {
      return 0xffff_ffff;
    },
  };
  const value = uniformInt(rejecting, 3, {
    maxDraws: 4,
    reserveDraw() {
      draws += 1;
      return true;
    },
  });
  assert.equal(value, null);
  assert.equal(draws, 4);

  draws = 0;
  assert.equal(uniformInt(rejecting, 3, {
    maxDraws: 0,
    reserveDraw() {
      draws += 1;
      return true;
    },
  }), null);
  assert.equal(draws, 0);
});

check("turns PRNG exhaustion and hashing failures into literal warnings", () => {
  const originalCreateHash = crypto.createHash;
  crypto.createHash = () => ({
    update() {
      return this;
    },
    digest() {
      return Buffer.alloc(32, 0xff);
    },
  });
  try {
    literal("{{roll::d3}}", { seed: "forced-rejection" }, "MACRO_PRNG_EXHAUSTED", {
      maxRandomDrawsPerChoice: 3,
    });
  } finally {
    crypto.createHash = originalCreateHash;
  }

  crypto.createHash = () => {
    throw new Error("private hash failure");
  };
  try {
    const result = literal(
      "{{pick::a::b}}",
      { seed: "hash-failure" },
      "MACRO_PRNG_ERROR",
    );
    assert(!JSON.stringify(result).includes("private hash failure"));
  } finally {
    crypto.createHash = originalCreateHash;
  }
});

check("normalizes tiny inconsistent byte overrides without partial output", () => {
  const rejected = expandSafeMacros("ééa", {}, {
    maxInputBytes: 10,
    maxOutputBytes: 4,
  });
  assert.equal(rejected.text, "");
  assert.equal(rejected.stats.outputBytes, 0);
  assert.deepEqual(rejected.warnings, [{ code: "MACRO_LIMIT_INPUT" }]);

  const exact = expandSafeMacros("éé", {}, {
    maxInputBytes: 10,
    maxOutputBytes: 4,
  });
  assert.equal(exact.text, "éé");
  assert.equal(exact.stats.outputBytes, 4);
});

check("rolls back output growth without slicing UTF-8 or macro source", () => {
  const immediate = "A{{user}}";
  const immediateResult = expandSafeMacros(immediate, {
    user: "é".repeat(20),
  }, {
    maxInputBytes: Buffer.byteLength(immediate),
    maxOutputBytes: Buffer.byteLength(immediate),
  });
  assert.equal(immediateResult.text, immediate);
  assert.deepEqual(immediateResult.warnings, [{ code: "MACRO_LIMIT_OUTPUT" }]);

  const late = "{{user}}-{{char}}";
  const lateResult = expandSafeMacros(late, {
    user: "1234567890123456",
    char: "é",
  }, {
    maxInputBytes: Buffer.byteLength(late),
    maxOutputBytes: Buffer.byteLength(late),
  });
  assert.equal(lateResult.text, late);
  assert.equal(lateResult.stats.outputBytes, Buffer.byteLength(late));
  assert.deepEqual(lateResult.warnings, [{ code: "MACRO_LIMIT_OUTPUT" }]);
});

check("keeps unknown and blocked source atomic at the output edge", () => {
  const input = "é{{unknown}}/{{exec::private}}";
  const bytes = Buffer.byteLength(input);
  const result = expandSafeMacros(input, {}, {
    maxInputBytes: bytes,
    maxOutputBytes: bytes,
  });
  assert.equal(result.text, input);
  assert.equal(result.stats.outputBytes, bytes);
  assert.deepEqual(result.warnings, [
    { code: "MACRO_UNKNOWN", name: "unknown" },
    { code: "MACRO_BLOCKED", name: "exec" },
  ]);
});

check("escaped closing delimiters end literal depth with stable backslash parity", () => {
  assert.equal(
    expandSafeMacros(String.raw`\{{x\}} {{user}}`, { user: "Alex" }).text,
    "{{x}} Alex",
  );
  assert.equal(
    expandSafeMacros(
      String.raw`\{{outer {{inner}} end\}} {{user}}`,
      { user: "Alex" },
    ).text,
    "{{outer {{inner}} end}} Alex",
  );
  assert.equal(
    expandSafeMacros(String.raw`\\{{user}}`, { user: "Alex" }).text,
    String.raw`\Alex`,
  );
  assert.equal(
    expandSafeMacros(String.raw`\\\{{user}}`, { user: "Alex" }).text,
    String.raw`\{{user}}`,
  );
});

check("reserves warning capacity for blocked and limit categories", () => {
  const unknown = Array.from({ length: 128 }, (_, index) => `{{unknown_${index}}}`).join("");
  const input = `${unknown}{{exec::private}}{{user}}`;
  const bytes = Buffer.byteLength(input);
  const result = expandSafeMacros(input, {
    user: "x".repeat(bytes),
  }, {
    maxInputBytes: bytes,
    maxOutputBytes: bytes,
  });
  assert.equal(result.warnings.length, 128);
  assert(result.warnings.some((warning) => warning.code === "MACRO_BLOCKED"));
  assert(result.warnings.some((warning) => warning.code === "MACRO_LIMIT_OUTPUT"));
  assert.deepEqual(result.warnings.at(-1), {
    code: "MACRO_WARNINGS_TRUNCATED",
    counts: { blocked: 0, error: 0, unknown: 3 },
  });
  assert(!JSON.stringify(result.warnings).includes("private"));
});

check("catches handler and public-path exceptions without private leakage", () => {
  const originalUppercase = String.prototype.toUpperCase;
  String.prototype.toUpperCase = function throwingUppercase() {
    throw new Error("private handler failure");
  };
  try {
    const result = literal(
      "{{uppercase::private-value}}",
      {},
      "MACRO_HANDLER_ERROR",
    );
    assert(!JSON.stringify(result).includes("private handler failure"));
  } finally {
    String.prototype.toUpperCase = originalUppercase;
  }

  const limits = new Proxy({}, {
    getOwnPropertyDescriptor() {
      throw new Error("private limits failure");
    },
  });
  const result = expandSafeMacros("{{user}}", { user: "private-value" }, limits);
  assert.equal(result.text, "");
  assert.deepEqual(result.warnings, [{ code: "MACRO_LIMITS_INVALID" }]);
  assert(!JSON.stringify(result).includes("private limits failure"));
  assert(!JSON.stringify(result.warnings).includes("private-value"));
});

console.log(`character-macro-hardening: ${checks} checks passed`);
