#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import {
  parseCharacterCard,
} from "../src/main/character-worlds/card-parser.js";
import validation from "../src/main/character-worlds/validation.js";
const {
  assertPlainData,
  cloneInert,
  decodeJsonBuffer,
  decodeJsonDocument,
  normalizeString,
  normalizeStringArray,
  serializePreservedJson,
  stableJson,
} = validation;
import {
  DEFAULT_IMPORT_LIMITS,
} from "../src/main/character-worlds/constants.js";
import compatibilityModule from "../src/main/character-worlds/compatibility-report.js";
import pointerModule from "../src/main/character-worlds/json-pointer.js";

const { CompatibilityReport } = compatibilityModule;
const { JsonPointerStack } = pointerModule;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURES = path.join(ROOT, "fixtures", "character-worlds");
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

function fixture(name) {
  return fs.readFileSync(path.join(FIXTURES, name));
}

function parse(buffer, options = {}) {
  return parseCharacterCard(buffer, {
    fileName: "fixture.json",
    mime: "application/json",
    ...options,
  });
}

function decodeData(buffer, limits = {}) {
  return decodeJsonBuffer(buffer, limits).data;
}

function throwsCode(fn, code, details = {}) {
  assert.throws(fn, (error) => {
    assert.equal(error?.code, code);
    for (const [key, expected] of Object.entries(details)) {
      assert.deepEqual(error?.[key], expected, `${code}.${key}`);
    }
    assert.equal("content" in error, false);
    assert.equal("snippet" in error, false);
    assert.equal(Object.hasOwn(error, "path"), false);
    assert.equal(Object.hasOwn(error, "pathFingerprint"), false);
    assert.equal(Object.hasOwn(error, "offset"), false);
    assert.equal(Object.hasOwn(error, "index"), false);
    assert(Number.isInteger(error.pathDepth));
    return true;
  });
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function assertPrivateSafeError(fn, expectedCode, secrets, secretPointers) {
  assert.throws(fn, (error) => {
    assert.equal(error?.code, expectedCode);
    const ownProperties = Object.getOwnPropertyNames(error)
      .map((key) => `${key}:${String(error[key])}`)
      .join("\n");
    const surfaces = [
      error.message,
      error.stack || "",
      ownProperties,
      JSON.stringify(error),
    ];
    const prohibited = [
      ...secrets,
      ...secretPointers.flatMap((pointer) => [
        sha256(pointer),
        `sha256:${sha256(pointer)}`,
      ]),
    ];
    for (const surface of surfaces) {
      for (const value of prohibited) assert(!surface.includes(value), value);
    }
    assert.equal(Object.hasOwn(error, "path"), false);
    assert.equal(Object.hasOwn(error, "pathFingerprint"), false);
    assert.equal(Object.hasOwn(error, "offset"), false);
    assert.equal(Object.hasOwn(error, "index"), false);
    assert(Number.isInteger(error.pathDepth));
    return true;
  });
}

function plain(value) {
  return JSON.parse(stableJson(value));
}

function canonical(overrides) {
  return {
    schemaVersion: 1,
    name: "",
    description: "",
    personality: "",
    scenario: "",
    firstMessage: "",
    alternateGreetings: [],
    exampleDialogue: "",
    creatorNotes: "",
    systemPrompt: "",
    postHistoryInstructions: "",
    tags: [],
    creator: "",
    characterVersion: "",
    ...overrides,
  };
}

const common = {
  description: "Navigator of the quiet routes.",
  personality: "Calm, precise, and curious.",
  scenario: "A research station circles a blue moon.",
  firstMessage: "The next window is open. Shall we go?",
  alternateGreetings: ["Course plotted.", "I kept the lights on."],
  exampleDialogue: "<START>\n{{char}}: The route is stable.",
  systemPrompt: "Use concise navigational language.",
  postHistoryInstructions: "Keep established route facts consistent.",
  tags: ["space", "navigator"],
  creator: "Lily Fixtures",
};

console.log("character-card-parser:");

check("V1 aliases migrate to the exact canonical schema", () => {
  const result = parse(fixture("v1-character.json"));
  assert.equal(result.ok, true);
  assert.equal(result.format, "v1_json");
  assert.deepEqual(plain(result.canonical), canonical({
    ...common,
    name: "Luna V1",
    creatorNotes: "Legacy fixture notes.",
    characterVersion: "1.2",
  }));
  assert.deepEqual(result.compatibility.migrated, [
    "/char_greeting",
    "/char_persona",
    "/character_version",
    "/creator_notes",
    "/example_dialogue",
    "/post_history_instructions",
    "/system_prompt",
    "/world_scenario",
  ]);
  assert.deepEqual(result.compatibility.preservedInert, ["/unknown_v1/keep"]);
  assert.equal(result.compatibility.level, "preserved_inert");
});

check("V1 char_name is a recognized migrated identity alias", () => {
  const result = parse(Buffer.from(JSON.stringify({
    char_name: "Legacy Name",
    char_persona: "Legacy persona",
  })));
  assert.equal(result.format, "v1_json");
  assert.equal(result.canonical.name, "Legacy Name");
  assert.deepEqual(result.compatibility.migrated, ["/char_name", "/char_persona"]);
  assert.equal(result.compatibility.level, "lossless_data");
});

check("V2 data fields migrate deterministically", () => {
  const result = parse(fixture("v2-character.json"));
  assert.equal(result.ok, true);
  assert.equal(result.format, "v2_json");
  assert.deepEqual(plain(result.canonical), canonical({
    ...common,
    name: "Luna V2",
    creatorNotes: "V2 fixture notes.",
    characterVersion: "2.1",
  }));
  assert.deepEqual(result.compatibility.supported, [
    "/data/alternate_greetings",
    "/data/creator",
    "/data/description",
    "/data/name",
    "/data/personality",
    "/data/scenario",
    "/data/tags",
    "/spec",
    "/spec_version",
  ]);
  assert.deepEqual(result.compatibility.preservedInert, ["/data/vendor_data/color"]);
});

check("V3 declared by spec produces canonical data and truthful compatibility", () => {
  const result = parse(fixture("v3-character.json"));
  assert.equal(result.ok, true);
  assert.equal(result.format, "v3_json");
  assert.deepEqual(plain(result.canonical), canonical({
    ...common,
    name: "Luna V3",
    creatorNotes: "V3 fixture notes.",
    characterVersion: "3.0",
  }));
  assert.equal(result.preserved.schemaVersion, 1);
  assert.equal(result.preserved.data.spec, "chara_card_v3");
  assert.deepEqual(result.compatibility.rejectedExecutable, [
    "/data/extensions/stscript",
  ]);
  assert.deepEqual(result.compatibility.preservedInert, [
    "/data/extensions/vendor_theme",
  ]);
  assert.equal(result.compatibility.level, "safe_behavior");
});

check("a compatible V3 declared version is recognized without a spec marker", () => {
  const result = parse(Buffer.from(JSON.stringify({
    spec_version: "3.1",
    data: { name: "Version-only V3" },
  })));
  assert.equal(result.format, "v3_json");
  assert.equal(result.canonical.name, "Version-only V3");
  assert.deepEqual(result.compatibility.supported, [
    "/data/name",
    "/spec_version",
  ]);
});

check("a numeric declared version is detected from its exact retained lexeme", () => {
  const result = parse(Buffer.from('{"spec_version":3.10,"data":{"name":"Numeric V3"}}'));
  assert.equal(result.format, "v3_json");
  assert.deepEqual(result.preserved.numberLexemes, [{
    pointer: "/spec_version",
    lexeme: "3.10",
  }]);
  assert.equal(result.preserved.data.spec_version, null);
  assert(serializePreservedJson(result.preserved).includes('"spec_version":3.10'));
  assert.equal("sourceMetadata" in result, false);
});

check("bounded decoding never separates numeric convenience from exact lexemes", () => {
  const document = decodeJsonBuffer(Buffer.from("1e400"));
  assert.equal(document?.schemaVersion, 1);
  assert.equal(document?.data, null);
  assert.deepEqual(document?.numberLexemes, [{ pointer: "", lexeme: "1e400" }]);
  assert.equal(serializePreservedJson(document), "1e400");
});

check("an exact compatible V2 version marker is accepted without spec", () => {
  const result = parse(Buffer.from('{"spec_version":"2.0","data":{"name":"Version V2"}}'));
  assert.equal(result.format, "v2_json");
  assert.equal(result.canonical.name, "Version V2");
});

check("arbitrary JSON is not accepted as V1", () => {
  for (const source of [
    '{"arbitrary":true}',
    '{"data":{"other":"value"}}',
    "{}",
    '{"name":"Only a generic name"}',
    fixture("false-positive-name-description.json"),
    fixture("false-positive-package.json"),
    '{"char_name":"Legacy without narrative"}',
    '{"name":"Modern","personality":"Only one strong field"}',
    '{"name":"Modern","char_name":"Legacy","char_persona":"Only one strong field"}',
    '{"name":"generic","personality":1,"scenario":false}',
    '{"name":"generic","personality":"   ","scenario":"\\n\\t"}',
    '{"char_name":"generic","char_greeting":{}}',
    '{"char_name":"generic","char_greeting":"   "}',
  ]) {
    const buffer = Buffer.isBuffer(source) ? source : Buffer.from(source);
    throwsCode(() => parse(buffer), "NOT_A_CHARACTER_CARD", { pathDepth: 0 });
  }
});

check("minimal legacy and modern V1 fingerprints remain accepted", () => {
  const legacy = parse(fixture("minimal-v1-legacy.json"));
  const modern = parse(fixture("minimal-v1-modern.json"));
  assert.equal(legacy.format, "v1_json");
  assert.equal(legacy.canonical.name, "Legacy Minimal");
  assert.equal(modern.format, "v1_json");
  assert.equal(modern.canonical.name, "Modern Minimal");
});

check("canonical names are trimmed, nonblank, and preserve exact source text", () => {
  const result = parse(Buffer.from(JSON.stringify({
    name: "  Trimmed Name \n",
    personality: "Calm",
    scenario: "Lab",
  })));
  assert.equal(result.canonical.name, "Trimmed Name");
  assert.equal(result.preserved.data.name, "  Trimmed Name \n");
  throwsCode(
    () => parse(Buffer.from(JSON.stringify({
      name: " \n\t ",
      personality: "Calm",
      scenario: "Lab",
    }))),
    "CARD_ROOT_INVALID",
    { pathDepth: 1 },
  );
});

check("format markers reject spoofed versions, unknown specs, and conflicts", () => {
  const shaped = '"data":{"name":"Marker"}';
  for (const source of [
    `{"spec":"chara_card_v4",${shaped}}`,
    `{"spec":"CHARA_CARD_V3",${shaped}}`,
    `{"spec_version":"3.foo",${shaped}}`,
    `{"spec_version":"03.0",${shaped}}`,
    `{"spec_version":"3.",${shaped}}`,
    `{"spec_version":"3.0-beta",${shaped}}`,
    `{"spec_version":{"major":3},${shaped}}`,
  ]) {
    throwsCode(() => parse(Buffer.from(source)), "NOT_A_CHARACTER_CARD", { pathDepth: 0 });
  }
  throwsCode(
    () => parse(Buffer.from(`{"spec":"chara_card_v2","spec_version":"3.0",${shaped}}`)),
    "CARD_FORMAT_CONFLICT",
    { pathDepth: 1 },
  );
  throwsCode(
    () => parse(Buffer.from(`{"spec":"chara_card_v3","spec_version":"2.0",${shaped}}`)),
    "CARD_FORMAT_CONFLICT",
    { pathDepth: 1 },
  );
});

check("malformed JSON is rejected without echoing private input", () => {
  const secret = "PRIVATE-CARD-CONTENT";
  assert.throws(
    () => parse(Buffer.from(`{"name":"${secret}",}`)),
    (error) => error.code === "CARD_JSON_INVALID"
      && !error.message.includes(secret)
      && !JSON.stringify(error).includes(secret),
  );
});

check("all parser errors replace private paths with safe diagnostics", () => {
  const secretKey = "PRIVATE-KEY-7fb343";
  const secretValue = "PRIVATE-VALUE-93fd81";
  assertPrivateSafeError(
    () => parse(Buffer.from(
      `{"name":"Card","personality":"Calm","scenario":"Lab","outer":{"${secretKey}":"${secretValue}","${secretKey}":2}}`,
    )),
    "CARD_DUPLICATE_KEY",
    [secretKey, secretValue],
    [`/outer/${secretKey}`],
  );
  assertPrivateSafeError(
    () => decodeData(Buffer.from(
      `{"outer":{"${secretKey}":"${secretValue}"}}`,
    ), { maxStringBytes: 4 }),
    "CARD_LIMIT_EXCEEDED",
    [secretKey, secretValue],
    [`/outer/${secretKey}`],
  );
  assertPrivateSafeError(
    () => assertPlainData({ [secretKey]: { constructor: secretValue } }),
    "CARD_DANGEROUS_KEY",
    [secretKey, secretValue],
    [`/${secretKey}/constructor`],
  );
});

check("compatibility invariant errors never expose private pointers", () => {
  const secretKey = "PRIVATE-COMPATIBILITY-KEY-47e2";
  const pointer = new JsonPointerStack();
  pointer.push(secretKey);
  const report = new CompatibilityReport(DEFAULT_IMPORT_LIMITS);
  report.add("supported", pointer);
  assertPrivateSafeError(
    () => report.add("migrated", pointer),
    "CARD_JSON_INVALID",
    [secretKey],
    [`/${secretKey}`],
  );
});

check("invalid UTF-8 is rejected fatally", () => {
  throwsCode(
    () => parse(Buffer.from([0x7b, 0x22, 0x6e, 0x61, 0x6d, 0x65, 0x22, 0x3a, 0x22, 0xc3, 0x28, 0x22, 0x7d])),
    "CARD_UTF8_INVALID",
  );
});

check("one leading UTF-8 BOM is accepted and all other BOM positions fail", () => {
  const json = Buffer.from(
    '{"name":"BOM","personality":"Calm","scenario":"Recognizable card"}',
  );
  const leading = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), json]);
  assert.equal(parse(leading).canonical.name, "BOM");
  throwsCode(
    () => parse(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf, 0xef, 0xbb, 0xbf]), json])),
    "CARD_JSON_INVALID",
  );
  throwsCode(
    () => parse(Buffer.concat([Buffer.from(" "), Buffer.from([0xef, 0xbb, 0xbf]), json])),
    "CARD_JSON_INVALID",
  );
});

check("escaped Unicode combines exact surrogate pairs in nested keys and values", () => {
  const document = decodeJsonDocument(Buffer.from(
    '{"key\\uD83D\\uDE80":{"value":"\\uD83D\\uDE80"}}',
  ));
  assert.deepEqual(plain(document.data), {
    "key🚀": { value: "🚀" },
  });
  const result = parse(Buffer.from(
    '{"char_name":"\\uD83D\\uDE80","char_persona":"Pair","nested":{"\\uD83D\\uDE80":"\\uD83D\\uDE80"}}',
  ));
  assert.equal(result.canonical.name, "🚀");
  assert.equal(result.preserved.data.nested["🚀"], "🚀");
  assert.deepEqual(result.compatibility.preservedInert, ["/nested/🚀"]);
});

check("escaped Unicode rejects lone or malformed surrogates in keys and values", () => {
  const malformed = [
    '{"value":"\\uD800"}',
    '{"value":"\\uDC00"}',
    '{"value":"\\uD800\\u0041"}',
    '{"value":"\\uD800x"}',
    '{"nested":{"value":"\\uDFFF"}}',
    '{"nested":{"\\uD800":"value"}}',
    '{"nested":{"\\uDC00":"value"}}',
  ];
  for (const source of malformed) {
    throwsCode(() => decodeData(Buffer.from(source)), "CARD_JSON_INVALID");
  }
});

check("string and key limits count decoded UTF-8 bytes at exact four-byte boundaries", () => {
  const rocket = "🚀";
  const exactValue = rocket.repeat(DEFAULT_IMPORT_LIMITS.maxStringBytes / 4);
  const exactKey = rocket.repeat(DEFAULT_IMPORT_LIMITS.maxKeyBytes / 4);
  assert.equal(
    decodeData(Buffer.from(JSON.stringify(exactValue))),
    exactValue,
  );
  assert.equal(
    decodeData(Buffer.from(JSON.stringify({ [exactKey]: true })))[exactKey],
    true,
  );
  throwsCode(
    () => decodeData(Buffer.from(JSON.stringify(`${exactValue}${rocket}`))),
    "CARD_LIMIT_EXCEEDED",
    {
      limit: "maxStringBytes",
      maximum: DEFAULT_IMPORT_LIMITS.maxStringBytes,
      actual: DEFAULT_IMPORT_LIMITS.maxStringBytes + 4,
    },
  );
  throwsCode(
    () => decodeData(Buffer.from(JSON.stringify({ [`${exactKey}${rocket}`]: true }))),
    "CARD_LIMIT_EXCEEDED",
    {
      limit: "maxKeyBytes",
      maximum: DEFAULT_IMPORT_LIMITS.maxKeyBytes,
      actual: DEFAULT_IMPORT_LIMITS.maxKeyBytes + 4,
    },
  );
});

check("escaped surrogate pairs and aggregate strings use decoded UTF-8 byte limits", () => {
  const escapedRocket = "\\uD83D\\uDE80";
  const exactEscaped = escapedRocket.repeat(DEFAULT_IMPORT_LIMITS.maxStringBytes / 4);
  assert.equal(
    decodeData(Buffer.from(`"${exactEscaped}"`)),
    "🚀".repeat(DEFAULT_IMPORT_LIMITS.maxStringBytes / 4),
  );
  throwsCode(
    () => decodeData(Buffer.from(`"${exactEscaped}${escapedRocket}"`)),
    "CARD_LIMIT_EXCEEDED",
    {
      limit: "maxStringBytes",
      maximum: DEFAULT_IMPORT_LIMITS.maxStringBytes,
      actual: DEFAULT_IMPORT_LIMITS.maxStringBytes + 4,
    },
  );
  assert.deepEqual(
    decodeData(Buffer.from('["🚀","🚀"]'), { maxTotalStringBytes: 8 }),
    ["🚀", "🚀"],
  );
  throwsCode(
    () => decodeData(
      Buffer.from('["🚀","🚀","a"]'),
      { maxTotalStringBytes: 8 },
    ),
    "CARD_LIMIT_EXCEEDED",
    { limit: "maxTotalStringBytes", maximum: 8, actual: 9 },
  );
  assert.deepEqual(
    plain(decodeData(
      Buffer.from('{"🚀":true,"🛰️":false}'),
      { maxTotalKeyBytes: 11 },
    )),
    { "🚀": true, "🛰️": false },
  );
  throwsCode(
    () => decodeData(
      Buffer.from('{"🚀":true,"🛰️":false,"a":null}'),
      { maxTotalKeyBytes: 11 },
    ),
    "CARD_LIMIT_EXCEEDED",
    { limit: "maxTotalKeyBytes", maximum: 11, actual: 12 },
  );
});

check("canonical text uses the full 1 MiB UTF-8 byte allowance", () => {
  const threeHundredThousandAscii = "a".repeat(300_000);
  const exactBoundary = "b".repeat(DEFAULT_IMPORT_LIMITS.maxStringBytes);
  const base = {
    name: "Text Limits",
    personality: "Calm",
    scenario: "Lab",
  };
  const accepted = parse(Buffer.from(JSON.stringify({
    ...base,
    description: threeHundredThousandAscii,
  })));
  assert.equal(accepted.canonical.description.length, 300_000);
  const exact = parse(Buffer.from(JSON.stringify({
    ...base,
    description: exactBoundary,
  })));
  assert.equal(
    Buffer.byteLength(exact.canonical.description, "utf8"),
    DEFAULT_IMPORT_LIMITS.maxStringBytes,
  );
  throwsCode(
    () => parse(Buffer.from(JSON.stringify({
      ...base,
      description: `${exactBoundary}x`,
    }))),
    "CARD_LIMIT_EXCEEDED",
    {
      limit: "maxStringBytes",
      maximum: DEFAULT_IMPORT_LIMITS.maxStringBytes,
      actual: DEFAULT_IMPORT_LIMITS.maxStringBytes + 1,
    },
  );
  assert(
    DEFAULT_IMPORT_LIMITS.maxCanonicalFieldChars
      >= DEFAULT_IMPORT_LIMITS.maxStringBytes,
  );
});

check("synchronous parse operation and elapsed budgets fail deterministically", () => {
  throwsCode(
    () => decodeData(Buffer.from("{}"), { maxParseOperations: 0 }),
    "CARD_PARSE_TIMEOUT",
    {
      reason: "operation_budget",
      limit: "maxParseOperations",
      maximum: 0,
    },
  );
  throwsCode(
    () => decodeData(Buffer.from("{}"), { maxParseElapsedMs: 0 }),
    "CARD_PARSE_TIMEOUT",
    {
      reason: "elapsed_budget",
      limit: "maxParseElapsedMs",
      maximum: 0,
    },
  );
});

check("root arrays and scalars are rejected after bounded decoding", () => {
  for (const source of ["[]", "null", "true", "12", '"name"']) {
    throwsCode(() => parse(Buffer.from(source)), "CARD_ROOT_INVALID", { pathDepth: 0 });
  }
});

check("duplicate keys are rejected at root and every nested shape", () => {
  const cases = [
    '{"name":"one","name":"two"}',
    '{"name":"safe","nested":{"key":1,"key":2}}',
    '{"name":"safe","nested":[{"key":1,"key":2}]}',
    fixture("hostile-duplicate.json"),
  ];
  for (const source of cases) {
    const buffer = Buffer.isBuffer(source) ? source : Buffer.from(source);
    throwsCode(() => parse(buffer), "CARD_DUPLICATE_KEY");
  }
  throwsCode(
    () => parse(fixture("hostile-duplicate.json")),
    "CARD_DUPLICATE_KEY",
    { pathDepth: 4 },
  );
});

check("duplicate keys are rejected at the maximum accepted nesting depth", () => {
  let source = '{"dup":1,"dup":2}';
  for (let index = 0; index < DEFAULT_IMPORT_LIMITS.maxDepth - 1; index += 1) {
    source = `{"a":${source}}`;
  }
  throwsCode(() => decodeData(Buffer.from(source)), "CARD_DUPLICATE_KEY");
});

check("dangerous object keys are rejected at every depth", () => {
  const dangerous = ["__proto__", "prototype", "constructor"];
  for (const key of dangerous) {
    for (const source of [
      `{"name":"safe","${key}":true}`,
      `{"name":"safe","nested":{"${key}":true}}`,
      `{"name":"safe","nested":[{"${key}":true}]}`,
    ]) {
      throwsCode(() => parse(Buffer.from(source)), "CARD_DANGEROUS_KEY");
    }
  }
  throwsCode(
    () => parse(fixture("hostile-dangerous-key.json")),
    "CARD_DANGEROUS_KEY",
    { pathDepth: 2 },
  );
});

check("the 32 MiB container limit is enforced before UTF-8 decoding", () => {
  const oversized = Buffer.alloc(DEFAULT_IMPORT_LIMITS.maxContainerBytes + 1, 0x20);
  throwsCode(() => parse(oversized), "CARD_TOO_LARGE", {
    limit: "maxContainerBytes",
    maximum: DEFAULT_IMPORT_LIMITS.maxContainerBytes,
  });
});

check("the 8 MiB decoded JSON limit is independently enforced", () => {
  const source = Buffer.from(`{"name":"safe","padding":"${"x".repeat(
    DEFAULT_IMPORT_LIMITS.maxJsonBytes,
  )}"}`);
  assert(source.length < DEFAULT_IMPORT_LIMITS.maxContainerBytes);
  throwsCode(() => parse(source), "CARD_TOO_LARGE", {
    limit: "maxJsonBytes",
    maximum: DEFAULT_IMPORT_LIMITS.maxJsonBytes,
  });
});

check("depth 64 is accepted and depth 65 is rejected before construction", () => {
  let accepted = '"leaf"';
  for (let index = 0; index < DEFAULT_IMPORT_LIMITS.maxDepth; index += 1) {
    accepted = `{"a":${accepted}}`;
  }
  assert.equal(decodeData(Buffer.from(accepted)).a.a.a.a.a.a.a.a.a.a.a.a.a.a.a.a
    .a.a.a.a.a.a.a.a.a.a.a.a.a.a.a.a.a.a.a.a.a.a.a.a.a.a.a.a.a.a.a.a
    .a.a.a.a.a.a.a.a.a.a.a.a.a.a.a.a, "leaf");
  throwsCode(
    () => decodeData(fixture("hostile-depth.json")),
    "CARD_DEPTH_EXCEEDED",
    { limit: "maxDepth", maximum: DEFAULT_IMPORT_LIMITS.maxDepth },
  );
});

check("object, member, array, string, and key counts are independently bounded", () => {
  const cases = [
    ['[{},{}]', { maxObjects: 1 }, "maxObjects"],
    ['{"a":1,"b":2}', { maxMembers: 1 }, "maxMembers"],
    ["[[],[]]", { maxArrays: 1 }, "maxArrays"],
    ["[1,2]", { maxArrayLength: 1 }, "maxArrayLength"],
    ['["a","b"]', { maxStrings: 1 }, "maxStrings"],
    ['{"a":1,"b":2}', { maxKeys: 1 }, "maxKeys"],
    ['{"abcd":1}', { maxKeyChars: 3 }, "maxKeyChars"],
    ['["abcd"]', { maxStringChars: 3 }, "maxStringChars"],
    ['["abc","def"]', { maxTotalStringChars: 5 }, "maxTotalStringChars"],
    ['{"abc":1,"def":2}', { maxTotalKeyChars: 5 }, "maxTotalKeyChars"],
  ];
  for (const [source, overrides, limit] of cases) {
    throwsCode(
      () => decodeData(Buffer.from(source), {
        ...DEFAULT_IMPORT_LIMITS,
        ...overrides,
      }),
      "CARD_LIMIT_EXCEEDED",
      { limit },
    );
  }
});

check("non-finite and non-JSON numeric forms never enter plain data", () => {
  for (const source of [
    '{"name":"safe","number":NaN}',
    '{"name":"safe","number":Infinity}',
    '{"name":"safe","number":-Infinity}',
  ]) {
    throwsCode(() => parse(Buffer.from(source)), "CARD_JSON_INVALID");
  }
  throwsCode(
    () => assertPlainData({ value: Number.POSITIVE_INFINITY }),
    "CARD_JSON_INVALID",
    { pathDepth: 1 },
  );
});

check("plain-data normalization rejects cycles, accessors, and class instances", () => {
  const cycle = {};
  cycle.self = cycle;
  throwsCode(() => assertPlainData(cycle), "CARD_JSON_INVALID");
  const accessor = {};
  Object.defineProperty(accessor, "secret", { enumerable: true, get() { throw new Error("ran"); } });
  throwsCode(() => assertPlainData(accessor), "CARD_JSON_INVALID");
  let arrayAccessorRuns = 0;
  const accessorArray = [];
  Object.defineProperty(accessorArray, "0", {
    enumerable: true,
    get() {
      arrayAccessorRuns += 1;
      return "secret";
    },
  });
  accessorArray.length = 1;
  throwsCode(() => assertPlainData(accessorArray), "CARD_JSON_INVALID");
  assert.equal(arrayAccessorRuns, 0);
  throwsCode(() => assertPlainData(new Date()), "CARD_JSON_INVALID");
});

check("plain-data arrays reject every non-canonical or non-value own property", () => {
  const invalidKeys = [
    "4294967295",
    "999999999999999999999999999999",
    "01",
    "-1",
    "1.5",
  ];
  for (const key of invalidKeys) {
    const value = [];
    Object.defineProperty(value, key, {
      configurable: true,
      enumerable: true,
      value: "must not be dropped",
      writable: true,
    });
    throwsCode(() => assertPlainData(value), "CARD_JSON_INVALID");
  }

  const symbolProperty = [];
  symbolProperty[Symbol("hidden")] = "must not be dropped";
  throwsCode(() => assertPlainData(symbolProperty), "CARD_JSON_INVALID");

  const nonEnumerableProperty = [];
  Object.defineProperty(nonEnumerableProperty, "custom", { value: "hidden" });
  throwsCode(() => assertPlainData(nonEnumerableProperty), "CARD_JSON_INVALID");

  let accessorRuns = 0;
  const accessorProperty = [];
  Object.defineProperty(accessorProperty, "0", {
    enumerable: true,
    get() {
      accessorRuns += 1;
      return "secret";
    },
  });
  throwsCode(() => assertPlainData(accessorProperty), "CARD_JSON_INVALID");
  assert.equal(accessorRuns, 0);
});

check("plain-data arrays preserve and bound every canonical own element", () => {
  const source = ["first", "second"];
  assert.deepEqual(
    assertPlainData(source, { maxArrayLength: 2, maxStrings: 2 }),
    source,
  );
  throwsCode(
    () => assertPlainData(source, { maxArrayLength: 1 }),
    "CARD_LIMIT_EXCEEDED",
    { limit: "maxArrayLength", maximum: 1, actual: 2 },
  );
  throwsCode(
    () => assertPlainData(source, { maxStrings: 1 }),
    "CARD_LIMIT_EXCEEDED",
    { limit: "maxStrings", maximum: 1, actual: 2 },
  );
});

check("unknown fields are preserved as inert null-prototype data", () => {
  const result = parse(Buffer.from(JSON.stringify({
    name: "Unknown Keeper",
    personality: "Calm",
    scenario: "Recognizable card",
    unknown: { nested: [{ value: 7 }] },
  })));
  assert(Object.isFrozen(result.preserved));
  assert(Object.isFrozen(result.preserved.data));
  assert(Object.isFrozen(result.preserved.numberLexemes));
  assert.equal(Object.getPrototypeOf(result.preserved.data), null);
  assert.equal(Object.getPrototypeOf(result.preserved.data.unknown), null);
  assert.equal(Object.getPrototypeOf(result.preserved.data.unknown.nested[0]), null);
  assert.deepEqual(plain(result.preserved.data.unknown), { nested: [{ value: 7 }] });
  assert.deepEqual(result.compatibility.preservedInert, ["/unknown/nested/0/value"]);
});

check("script, plugin, executable, STscript, and Quick Replies fields stay inert", () => {
  const result = parse(Buffer.from(JSON.stringify({
    spec: "chara_card_v3",
    data: {
      name: "Safe Subset",
      extensions: {
        executable: true,
        script: "never",
        regex_scripts: [{ find: "never" }],
        plugin: { name: "never" },
        STscript: "never",
        "Quick Replies": [{ command: "never" }],
      },
    },
  })));
  assert.deepEqual(result.compatibility.rejectedExecutable, [
    "/data/extensions/Quick Replies",
    "/data/extensions/STscript",
    "/data/extensions/executable",
    "/data/extensions/plugin",
    "/data/extensions/regex_scripts",
    "/data/extensions/script",
  ]);
  for (const pathName of result.compatibility.rejectedExecutable) {
    assert(!result.compatibility.supported.includes(pathName));
    assert(!result.compatibility.migrated.includes(pathName));
  }
  assert.equal(result.preserved.data.data.extensions.script, "never");
  assert.equal(result.compatibility.level, "safe_behavior");
});

check("invalid known field types are ignored explicitly while valid entries survive", () => {
  const result = parse(Buffer.from(JSON.stringify({
    spec: "chara_card_v2",
    data: {
      name: "Typed",
      description: 42,
      tags: ["safe", 7, null, "also-safe"],
      alternate_greetings: "not-an-array",
    },
  })));
  assert.equal(result.canonical.description, "");
  assert.deepEqual(result.canonical.tags, ["safe", "also-safe"]);
  assert.deepEqual(result.canonical.alternateGreetings, []);
  assert.deepEqual(result.compatibility.ignoredInvalid, [
    "/data/alternate_greetings",
    "/data/description",
    "/data/tags/1",
    "/data/tags/2",
  ]);
  assert(!result.compatibility.supported.includes("/data/alternate_greetings"));
  assert(!result.compatibility.supported.includes("/data/description"));
  assert.equal(result.compatibility.level, "safe_behavior");
});

check("compatibility paths use canonical JSON Pointer escaping and stay disjoint", () => {
  const result = parse(Buffer.from(JSON.stringify({
    name: "Pointer",
    personality: "Calm",
    scenario: "Recognizable",
    "a.b": 1,
    "a[b]": 2,
    "space key": 3,
    "slash/key": 4,
    "tilde~key": 5,
    "both~/": 6,
  })));
  assert.deepEqual(result.compatibility.preservedInert, [
    "/a.b",
    "/a[b]",
    "/both~0~1",
    "/slash~1key",
    "/space key",
    "/tilde~0key",
  ]);
  const allPointers = [
    ...result.compatibility.supported,
    ...result.compatibility.migrated,
    ...result.compatibility.preservedInert,
    ...result.compatibility.ignoredInvalid,
    ...result.compatibility.rejectedExecutable,
  ];
  assert.equal(new Set(allPointers).size, allPointers.length);
});

check("report path budgets charge JSON-serialized pointer bytes", () => {
  const quotedKey = '"'.repeat(80);
  const result = parse(Buffer.from(JSON.stringify({
    name: "Quoted Pointer",
    personality: "Calm",
    scenario: "Recognizable",
    [quotedKey]: "inert",
  })), {
    limits: { maxReportPathBytes: 120 },
  });
  assert(!result.compatibility.preservedInert.includes(`/${quotedKey}`));
  assert.equal(result.compatibility.truncation.omittedByBucket.preservedInert, 1);
  assert(
    Buffer.byteLength(JSON.stringify(result.compatibility), "utf8") < 1024,
  );
});

check("all valid numeric lexemes survive overflow, unsafe values, underflow, and variants", () => {
  const source = Buffer.from(`{
    "spec":"chara_card_v3",
    "data":{
      "name":"Numbers",
      "numbers":{
        "big/key":9007199254740993,
        "overflow":1e400,
        "negativeOverflow":-1E+400,
        "under~flow":1e-4000,
        "formatted":1.2300e+04,
        "negativeZero":-0,
        "decimal":0.000,
        "array":[9007199254740993]
      }
    }
  }`);
  const result = parse(source);
  assert.deepEqual(result.preserved.numberLexemes, [
    { pointer: "/data/numbers/array/0", lexeme: "9007199254740993" },
    { pointer: "/data/numbers/big~1key", lexeme: "9007199254740993" },
    { pointer: "/data/numbers/decimal", lexeme: "0.000" },
    { pointer: "/data/numbers/formatted", lexeme: "1.2300e+04" },
    { pointer: "/data/numbers/negativeOverflow", lexeme: "-1E+400" },
    { pointer: "/data/numbers/negativeZero", lexeme: "-0" },
    { pointer: "/data/numbers/overflow", lexeme: "1e400" },
    { pointer: "/data/numbers/under~0flow", lexeme: "1e-4000" },
  ]);
  const numbers = result.preserved.data.data.numbers;
  assert.equal(numbers["big/key"], null);
  assert.equal(numbers.overflow, null);
  assert.equal(numbers.negativeOverflow, null);
  assert.equal(numbers["under~flow"], null);
  assert.equal(numbers.formatted, 12300);
  assert.equal(numbers.array[0], null);
  const reconstructed = serializePreservedJson(result.preserved);
  for (const lexeme of [
    "9007199254740993",
    "1e400",
    "-1E+400",
    "1e-4000",
    "1.2300e+04",
    "-0",
    "0.000",
  ]) {
    assert(reconstructed.includes(lexeme));
  }
  const persisted = JSON.parse(JSON.stringify(result.preserved));
  assert.equal(serializePreservedJson(persisted), reconstructed);
  assert.equal("sourceMetadata" in result, false);
});

check("accepted long numeric lexemes remain exactly reconstructable", () => {
  const lexeme = `0.${"0".repeat(DEFAULT_IMPORT_LIMITS.maxStringChars + 16)}1`;
  const document = decodeJsonDocument(Buffer.from(`[${lexeme}]`));
  assert.equal(document.data[0], null);
  assert.deepEqual(document.numberLexemes, [{ pointer: "/0", lexeme }]);
  assert.equal(serializePreservedJson(document), `[${lexeme}]`);
});

check("report amplification stays bounded without losing preserved data", () => {
  const deepKeys = Array.from(
    { length: 30 },
    (_, index) => `depth-${index}-${"x".repeat(980)}`,
  );
  const leaf = {};
  for (let index = 0; index < 50; index += 1) {
    leaf[`leaf-${index}-${"y".repeat(230)}`] = `value-${index}`;
  }
  let nested = leaf;
  for (let index = deepKeys.length - 1; index >= 0; index -= 1) {
    nested = { [deepKeys[index]]: nested };
  }
  const source = Buffer.from(JSON.stringify({
    char_name: "Amplification",
    char_persona: "Recognizable",
    payload: nested,
  }));
  assert(source.length >= 40 * 1024 && source.length <= 50 * 1024, source.length);
  const first = parse(source);
  const second = parse(source);
  assert.deepEqual(first.compatibility, second.compatibility);
  assert(first.compatibility.truncation.omittedEntries > 0);
  assert.deepEqual(first.compatibility.warnings, [{
    code: "COMPATIBILITY_REPORT_TRUNCATED",
    omittedEntries: first.compatibility.truncation.omittedEntries,
    omittedByBucket: first.compatibility.truncation.omittedByBucket,
  }]);
  const visible = [
    ...first.compatibility.supported,
    ...first.compatibility.migrated,
    ...first.compatibility.preservedInert,
    ...first.compatibility.ignoredInvalid,
    ...first.compatibility.rejectedExecutable,
  ];
  assert(visible.length <= DEFAULT_IMPORT_LIMITS.maxReportEntries);
  assert(
    visible.reduce((bytes, pointer) => bytes + Buffer.byteLength(pointer), 0)
      <= DEFAULT_IMPORT_LIMITS.maxReportPathBytes,
  );
  assert(
    Buffer.byteLength(JSON.stringify(first.compatibility))
      <= DEFAULT_IMPORT_LIMITS.maxReportPathBytes + 16 * 1024,
  );
  let preserved = first.preserved.data.payload;
  for (const key of deepKeys) preserved = preserved[key];
  assert.equal(preserved[Object.keys(leaf)[49]], "value-49");
});

check("near-max parsing has bounded elapsed time and RSS amplification", () => {
  const parserPath = path.join(
    ROOT,
    "src",
    "main",
    "character-worlds",
    "card-parser.js",
  );
  const validationPath = path.join(
    ROOT,
    "src",
    "main",
    "character-worlds",
    "validation.js",
  );
  const child = `
    const { performance } = require("node:perf_hooks");
    const { parseCharacterCard } = require(${JSON.stringify(parserPath)});
    const { serializePreservedJson } = require(${JSON.stringify(validationPath)});
    if (typeof global.gc !== "function") throw new Error("GC is unavailable");
    const mebibyte = 1024 * 1024;
    let full = "x".repeat(mebibyte);
    let source = {
      name: "Near Max",
      personality: "Calm",
      scenario: "Lab",
      payload: [full, full, full, full, full, full, full, "y".repeat(700 * 1024)]
    };
    let buffer = Buffer.from(JSON.stringify(source));
    const inputBytes = buffer.length;
    source = null;
    full = null;
    global.gc();
    const baselineRss = process.memoryUsage().rss;
    const started = performance.now();
    let result = parseCharacterCard(buffer);
    let serialized = serializePreservedJson(result.preserved);
    let roundTrip = JSON.parse(serialized);
    const elapsedMs = performance.now() - started;
    const activeRss = process.memoryUsage().rss;
    const serializedBytes = Buffer.byteLength(serialized);
    const exactRoundTrip = roundTrip.payload.length === 8
      && roundTrip.payload[0].length === mebibyte
      && roundTrip.payload[7].length === 700 * 1024;
    result = null;
    serialized = null;
    roundTrip = null;
    buffer = null;
    global.gc();
    global.gc();
    const retainedRss = process.memoryUsage().rss;
    process.stdout.write(JSON.stringify({
      inputBytes,
      serializedBytes,
      exactRoundTrip,
      elapsedMs,
      activeRssAmplification: Math.max(0, activeRss - baselineRss),
      retainedRssAmplification: Math.max(0, retainedRss - baselineRss)
    }));
  `;
  const started = performance.now();
  const outcome = spawnSync(process.execPath, ["--expose-gc", "-e", child], {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
    timeout: 20_000,
  });
  const wallMs = performance.now() - started;
  assert.equal(outcome.status, 0, outcome.stderr || outcome.error?.message);
  const metrics = JSON.parse(outcome.stdout);
  assert(metrics.inputBytes >= 7.5 * 1024 * 1024, metrics);
  assert(metrics.inputBytes < DEFAULT_IMPORT_LIMITS.maxJsonBytes, metrics);
  assert.equal(metrics.serializedBytes, metrics.inputBytes);
  assert.equal(metrics.exactRoundTrip, true);
  assert(metrics.elapsedMs < 10_000, metrics.elapsedMs);
  assert(wallMs < 15_000, wallMs);
  assert(metrics.activeRssAmplification <= 320 * 1024 * 1024, metrics);
  assert(metrics.retainedRssAmplification <= 128 * 1024 * 1024, metrics);
});

check("limit overrides can lower but never raise centralized hard ceilings", () => {
  for (const [limit, maximum] of Object.entries(DEFAULT_IMPORT_LIMITS)) {
    if (limit === "version") continue;
    throwsCode(
      () => decodeData(Buffer.from("{}"), { [limit]: maximum + 1 }),
      "CARD_LIMIT_EXCEEDED",
      { limit, maximum, actual: maximum + 1 },
    );
  }
  assert.deepEqual(
    plain(decodeData(Buffer.from('{"a":1}'), { maxObjects: 1, maxMembers: 1 })),
    { a: 1 },
  );
});

check("compatibility report arrays are unique and sorted deterministically", () => {
  const sourceA = '{"name":"Order","personality":"Calm","scenario":"Lab","z":{"b":1,"a":2},"script":"x","description":4}';
  const sourceB = '{"description":4,"script":"x","z":{"a":2,"b":1},"scenario":"Lab","personality":"Calm","name":"Order"}';
  const reportA = parse(Buffer.from(sourceA)).compatibility;
  const reportB = parse(Buffer.from(sourceB)).compatibility;
  assert.deepEqual(reportA, reportB);
  for (const key of [
    "supported",
    "migrated",
    "preservedInert",
    "ignoredInvalid",
    "rejectedExecutable",
  ]) {
    assert.deepEqual(reportA[key], [...new Set(reportA[key])].sort());
  }
});

check("large reordered objects produce identical category-reserved reports", () => {
  const inertEntries = Array.from(
    { length: 600 },
    (_, index) => [`field-${String(index).padStart(3, "0")}`, index],
  );
  const makeSource = (entries, scriptFirst) => {
    const source = {
      name: "Reserved Report",
      personality: "Calm",
      scenario: "Lab",
    };
    if (scriptFirst) source.script = "never";
    for (const [key, value] of entries) source[key] = value;
    if (!scriptFirst) source.script = "never";
    return Buffer.from(JSON.stringify(source));
  };
  const first = parse(makeSource(inertEntries, true)).compatibility;
  const second = parse(makeSource([...inertEntries].reverse(), false)).compatibility;
  assert.deepEqual(first, second);
  assert.deepEqual(first.rejectedExecutable, ["/script"]);
  assert.equal(first.counts.rejectedExecutable, 1);
  assert.equal(first.truncation.omittedByBucket.rejectedExecutable, 0);
  assert(first.truncation.omittedByBucket.preservedInert > 0);

  const aggregateOnlyFirst = parse(makeSource(inertEntries, true), {
    limits: { maxReportRejectedExecutableEntries: 0 },
  }).compatibility;
  const aggregateOnlyLast = parse(makeSource([...inertEntries].reverse(), false), {
    limits: { maxReportRejectedExecutableEntries: 0 },
  }).compatibility;
  assert.deepEqual(aggregateOnlyFirst, aggregateOnlyLast);
  assert.deepEqual(aggregateOnlyFirst.rejectedExecutable, []);
  assert.equal(aggregateOnlyFirst.counts.rejectedExecutable, 1);
  assert.equal(
    aggregateOnlyFirst.truncation.omittedByBucket.rejectedExecutable,
    1,
  );
});

check("parser and inert helpers do not mutate caller-owned input", () => {
  const buffer = fixture("v2-character.json");
  const before = Buffer.from(buffer);
  parse(buffer);
  assert.deepEqual(buffer, before);

  const source = Object.freeze({
    name: "Frozen",
    nested: Object.freeze([Object.freeze({ value: "kept" })]),
  });
  const cloned = cloneInert(source);
  assert.deepEqual(source, {
    name: "Frozen",
    nested: [{ value: "kept" }],
  });
  cloned.nested[0].value = "changed";
  assert.equal(source.nested[0].value, "kept");
});

check("stable JSON and exported normalizers are deterministic and bounded", () => {
  const normalized = assertPlainData({ z: 1, a: ["x"] });
  assert.equal(Object.getPrototypeOf(normalized), null);
  assert.equal(stableJson(normalized), '{"a":["x"],"z":1}');
  assert.equal(normalizeString("unchanged", 20, "field"), "unchanged");
  assert.equal(normalizeString(12, 20, "field"), null);
  assert.deepEqual(
    normalizeStringArray(["one", 2, "three"], {
      maxArrayLength: 3,
      maxStringChars: 10,
      maxTotalStringChars: 20,
    }, "field"),
    ["one", "three"],
  );
  throwsCode(
    () => normalizeString("toolong", 3, "field"),
    "CARD_LIMIT_EXCEEDED",
    { limit: "maxChars", pathDepth: 1 },
  );
});

check("canonical and preserved outputs fit Task 1 repository byte limits", () => {
  for (const name of ["v1-character.json", "v2-character.json", "v3-character.json"]) {
    const result = parse(fixture(name));
    assert(Buffer.byteLength(stableJson(result.canonical), "utf8") <= 8 * 1024 * 1024);
    assert(
      Buffer.byteLength(serializePreservedJson(result.preserved), "utf8")
        <= 32 * 1024 * 1024,
    );
    for (const field of [
      "name",
      "description",
      "personality",
      "scenario",
      "firstMessage",
      "exampleDialogue",
      "creatorNotes",
      "systemPrompt",
      "postHistoryInstructions",
      "creator",
      "characterVersion",
    ]) {
      assert(Buffer.byteLength(result.canonical[field], "utf8") <= 1024 * 1024);
    }
  }
});

console.log(`\ncharacter-card-parser: ${checks} checks passed`);
