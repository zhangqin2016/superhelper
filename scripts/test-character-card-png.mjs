#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";
import cardParserModule from "../src/main/character-worlds/card-parser.js";
import constantsModule from "../src/main/character-worlds/constants.js";
import pngCardModule from "../src/main/character-worlds/png-card.js";

const { parseCharacterCard } = cardParserModule;
const { DEFAULT_IMPORT_LIMITS } = constantsModule;
const { extractEmbeddedCard, inspectPng } = pngCardModule;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURES = path.join(ROOT, "fixtures", "character-worlds");
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const PIXEL_ZLIB = Buffer.from([120, 156, 99, 96, 96, 96, 0, 0, 0, 4, 0, 1]);
let checks = 0;

const V2 = Buffer.from(JSON.stringify({
  spec: "chara_card_v2",
  spec_version: "2.0",
  data: { name: "Luna V2", description: "A compact V2 fixture." },
}));
const V3 = Buffer.from(JSON.stringify({
  spec: "chara_card_v3",
  spec_version: "3.0",
  data: { name: "Luna", description: "A compact V3 fixture." },
}));
const OTHER_V3 = Buffer.from(JSON.stringify({
  spec: "chara_card_v3",
  spec_version: "3.0",
  data: { name: "Nova", description: "A conflicting V3 fixture." },
}));
const OTHER_V2 = Buffer.from(JSON.stringify({
  spec: "chara_card_v2",
  spec_version: "2.0",
  data: { name: "Nova V2", description: "A conflicting V2 fixture." },
}));

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

function crc32(buffer) {
  let crc = 0xffff_ffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb8_8320 : 0);
    }
  }
  return (crc ^ 0xffff_ffff) >>> 0;
}

function chunk(type, data = Buffer.alloc(0)) {
  const typeBytes = Buffer.from(type, "ascii");
  const output = Buffer.alloc(12 + data.length);
  output.writeUInt32BE(data.length, 0);
  typeBytes.copy(output, 4);
  data.copy(output, 8);
  output.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])), 8 + data.length);
  return output;
}

function ihdr(width = 1, height = 1, overrides = {}) {
  const data = Buffer.alloc(13);
  data.writeUInt32BE(width, 0);
  data.writeUInt32BE(height, 4);
  data[8] = overrides.bitDepth ?? 8;
  data[9] = overrides.colorType ?? 2;
  data[10] = overrides.compression ?? 0;
  data[11] = overrides.filter ?? 0;
  data[12] = overrides.interlace ?? 0;
  return chunk("IHDR", data);
}

function plte(entries) {
  return chunk("PLTE", Buffer.from(Array.from(
    { length: entries * 3 },
    (_, index) => index & 0xff,
  )));
}

function actl(frames = 2, plays = 0) {
  const data = Buffer.alloc(8);
  data.writeUInt32BE(frames, 0);
  data.writeUInt32BE(plays, 4);
  return chunk("acTL", data);
}

function fctl(sequence, overrides = {}) {
  const data = Buffer.alloc(26);
  data.writeUInt32BE(sequence, 0);
  data.writeUInt32BE(overrides.width ?? 1, 4);
  data.writeUInt32BE(overrides.height ?? 1, 8);
  data.writeUInt32BE(overrides.x ?? 0, 12);
  data.writeUInt32BE(overrides.y ?? 0, 16);
  data.writeUInt16BE(overrides.delayNumerator ?? 1, 20);
  data.writeUInt16BE(overrides.delayDenominator ?? 10, 22);
  data[24] = overrides.dispose ?? 0;
  data[25] = overrides.blend ?? 0;
  return chunk("fcTL", data);
}

function fdat(sequence) {
  const data = Buffer.alloc(4 + PIXEL_ZLIB.length);
  data.writeUInt32BE(sequence, 0);
  PIXEL_ZLIB.copy(data, 4);
  return chunk("fdAT", data);
}

function textChunk(keyword, json, options = {}) {
  const encoded = options.encoded ?? json.toString("base64");
  return chunk("tEXt", Buffer.concat([
    Buffer.from(keyword, "latin1"),
    Buffer.from([0]),
    Buffer.from(encoded, "latin1"),
  ]));
}

function ztxtChunk(keyword, json, options = {}) {
  const encoded = options.encoded ?? json.toString("base64");
  const compressed = options.compressed ?? deflateSync(Buffer.from(encoded, "latin1"));
  return chunk("zTXt", Buffer.concat([
    Buffer.from(keyword, "latin1"),
    Buffer.from([0, options.method ?? 0]),
    compressed,
  ]));
}

function itxtChunk(keyword, json, options = {}) {
  const encoded = options.encodedBytes ?? Buffer.from(json.toString("base64"), "utf8");
  const flag = options.flag ?? 0;
  const text = flag === 1
    ? (options.compressed ?? deflateSync(encoded))
    : encoded;
  return chunk("iTXt", Buffer.concat([
    Buffer.from(keyword, "latin1"),
    Buffer.from([0, flag, options.method ?? 0]),
    options.language ?? Buffer.from("en", "ascii"),
    ...(options.omitLanguageSeparator ? [] : [Buffer.from([0])]),
    options.translated ?? Buffer.from("Character Card", "utf8"),
    ...(options.omitTranslatedSeparator ? [] : [Buffer.from([0])]),
    text,
  ]));
}

function png(metadata = [], options = {}) {
  const imageData = chunk("IDAT", PIXEL_ZLIB);
  const body = [
    options.header ?? ihdr(options.width, options.height, options.ihdr),
    ...(options.beforeMetadata ?? []),
    ...metadata,
    ...(options.animation ?? []),
    ...(options.omitIdat ? [] : [imageData]),
    ...(options.afterIdat ?? []),
    ...(options.omitIend ? [] : [chunk("IEND")]),
  ];
  return Buffer.concat([PNG_SIGNATURE, ...body, options.trailing ?? Buffer.alloc(0)]);
}

function apng(metadata = []) {
  return png(metadata, {
    animation: [actl(2), fctl(0)],
    afterIdat: [fctl(1), fdat(2)],
  });
}

function throwsCode(fn, code, details = {}) {
  assert.throws(fn, (error) => {
    assert.equal(error?.code, code);
    for (const [key, expected] of Object.entries(details)) {
      assert.deepEqual(error?.[key], expected, `${code}.${key}`);
    }
    for (const privateKey of ["path", "payload", "content", "snippet", "offset", "index"]) {
      assert.equal(Object.hasOwn(error, privateKey), false, privateKey);
    }
    assert(Number.isInteger(error.pathDepth));
    return true;
  });
}

function warningCodes(result) {
  return result.compatibility.warnings.map((warning) => warning.code);
}

console.log("character-card-png:");

check("tEXt ccv3 payload is extracted and parsed from exact PNG magic", () => {
  const source = png([textChunk("ccv3", V3)]);
  const embedded = extractEmbeddedCard(source);
  assert.equal(embedded.keyword, "ccv3");
  assert.deepEqual(embedded.json, V3);
  assert.equal(embedded.container, "png");
  const result = parseCharacterCard(source, {
    fileName: "spoof.json",
    mime: "application/json",
  });
  assert.equal(result.canonical.name, "Luna");
  assert.equal(result.format, "v3_json");
  assert.equal(result.container, "png");
});

check("zTXt chara payload supports bounded method-0 inflate and V2", () => {
  const source = png([ztxtChunk("chara", V2)]);
  assert.equal(extractEmbeddedCard(source).keyword, "chara");
  const result = parseCharacterCard(source, { fileName: "card.txt" });
  assert.equal(result.canonical.name, "Luna V2");
  assert.equal(result.format, "v2_json");
});

check("uncompressed and compressed iTXt use strict UTF-8", () => {
  for (const flag of [0, 1]) {
    const source = png([itxtChunk("ccv3", V3, { flag })]);
    const embedded = extractEmbeddedCard(source);
    assert.deepEqual(embedded.json, V3);
    assert.equal(parseCharacterCard(source).canonical.name, "Luna");
  }
});

check("valid APNG sequence and frame counts are recognized without frame decoding", () => {
  const source = apng([textChunk("ccv3", V3)]);
  const inspected = inspectPng(source);
  assert.equal(inspected.container, "apng");
  assert.equal(inspected.animation.frames, 2);
  assert.equal(inspected.animation.plays, 0);
  assert.equal(inspected.width, 1);
  assert.equal(inspected.height, 1);
  assert.equal(parseCharacterCard(source).container, "apng");
});

check("identical same-key chunks and cross-key mirrors dedupe deterministically", () => {
  const source = png([
    textChunk("ccv3", V3),
    ztxtChunk("ccv3", V3),
    itxtChunk("chara", V3),
  ]);
  const embedded = extractEmbeddedCard(source);
  assert.equal(embedded.keyword, "ccv3");
  assert.deepEqual(embedded.json, V3);
  assert.deepEqual(
    embedded.warnings.map((warning) => warning.code),
    ["PNG_DUPLICATE_PAYLOAD_DEDUPED", "PNG_DUPLICATE_MIRROR_DEDUPED"],
  );
});

check("valid ccv3 wins over a conflicting valid chara mirror with a report", () => {
  const source = png([textChunk("chara", V2), textChunk("ccv3", V3)]);
  const result = parseCharacterCard(source);
  assert.equal(result.canonical.name, "Luna");
  assert.deepEqual(warningCodes(result), ["PNG_PAYLOAD_PRECEDENCE"]);
});

check("invalid higher-priority payload downgrades explicitly to valid chara", () => {
  const source = png([
    textChunk("ccv3", V3, { encoded: "not-base64!" }),
    textChunk("chara", V2),
  ]);
  const embedded = extractEmbeddedCard(source);
  assert.equal(embedded.keyword, "chara");
  assert.equal(embedded.warnings[0].code, "PNG_PAYLOAD_DOWNGRADE");
  assert.equal(embedded.warnings[0].reason, "PNG_BASE64_INVALID");
  const result = parseCharacterCard(source);
  assert.equal(result.canonical.name, "Luna V2");
  assert.deepEqual(warningCodes(result), ["PNG_PAYLOAD_DOWNGRADE"]);
});

check("an invalid lower mirror cannot block valid ccv3", () => {
  const source = png([
    textChunk("chara", V2, { encoded: "%%%%" }),
    textChunk("ccv3", V3),
  ]);
  const result = parseCharacterCard(source);
  assert.equal(result.canonical.name, "Luna");
  assert.deepEqual(warningCodes(result), ["PNG_INVALID_MIRROR_IGNORED"]);
});

check("valid ccv3 survives conflicting valid chara mirrors with a deterministic note", () => {
  const source = png([
    textChunk("chara", V2),
    textChunk("ccv3", V3),
    textChunk("chara", OTHER_V2),
  ]);
  const first = extractEmbeddedCard(source);
  const second = extractEmbeddedCard(source);
  assert.equal(first.keyword, "ccv3");
  assert.deepEqual(first.json, V3);
  assert.deepEqual(first.warnings, [{
    code: "PNG_MIRROR_CONFLICT_IGNORED",
    selectedKeyword: "ccv3",
    ignoredKeyword: "chara",
    conflictingPayloads: 2,
  }]);
  assert.deepEqual(second.warnings, first.warnings);
  assert.equal(parseCharacterCard(source).canonical.name, "Luna");
});

check("ccv3 reports both conflicting and invalid lower mirrors deterministically", () => {
  const source = png([
    textChunk("ccv3", V3),
    textChunk("chara", V2),
    textChunk("chara", OTHER_V2),
    textChunk("chara", V2, { encoded: "%%%%" }),
  ]);
  assert.deepEqual(extractEmbeddedCard(source).warnings, [
    {
      code: "PNG_MIRROR_CONFLICT_IGNORED",
      selectedKeyword: "ccv3",
      ignoredKeyword: "chara",
      conflictingPayloads: 2,
    },
    {
      code: "PNG_INVALID_PAYLOAD_IGNORED",
      keyword: "chara",
      count: 1,
      reason: "PNG_BASE64_INVALID",
    },
  ]);
});

check("conflicting valid chara payloads reject when no valid ccv3 exists", () => {
  const source = png([textChunk("chara", V2), textChunk("chara", OTHER_V2)]);
  throwsCode(() => extractEmbeddedCard(source), "PNG_PAYLOAD_CONFLICT", {
    keyword: "chara",
  });
});

check("malformed ccv3 JSON downgrades to one valid chara with its safe reason", () => {
  const malformed = Buffer.from('{"spec":"chara_card_v3","data":');
  const source = png([textChunk("ccv3", malformed), textChunk("chara", V2)]);
  const embedded = extractEmbeddedCard(source);
  assert.equal(embedded.keyword, "chara");
  assert.deepEqual(embedded.warnings, [{
    code: "PNG_PAYLOAD_DOWNGRADE",
    selectedKeyword: "chara",
    invalidKeyword: "ccv3",
    reason: "CARD_JSON_INVALID",
  }]);
});

check("multiple valid conflicting same-key chunks fail instead of last-write selection", () => {
  const source = png([textChunk("ccv3", V3), textChunk("ccv3", OTHER_V3)]);
  throwsCode(() => extractEmbeddedCard(source), "PNG_PAYLOAD_CONFLICT", {
    keyword: "ccv3",
  });
});

check("unrelated metadata is skipped and an ordinary PNG falls back stably", () => {
  const source = png([
    textChunk("Comment", Buffer.from("not a card")),
    ztxtChunk("Description", Buffer.from("also not a card")),
  ]);
  const inspected = inspectPng(source);
  assert.equal(inspected.cardChunks.length, 0);
  throwsCode(() => extractEmbeddedCard(source), "NOT_A_CHARACTER_CARD");
  throwsCode(() => parseCharacterCard(source), "NOT_A_CHARACTER_CARD");
});

check("extension and MIME spoofing never override exact magic-byte dispatch", () => {
  const json = Buffer.from(V3);
  assert.equal(parseCharacterCard(json, {
    fileName: "fake.png",
    mime: "image/png",
  }).canonical.name, "Luna");
  const image = png([textChunk("ccv3", V3)]);
  assert.equal(parseCharacterCard(image, {
    fileName: "fake.json",
    mime: "application/json",
  }).canonical.name, "Luna");
});

check("PNG parsing does not mutate caller-owned bytes", () => {
  const source = apng([textChunk("ccv3", V3)]);
  const before = Buffer.from(source);
  inspectPng(source);
  extractEmbeddedCard(source);
  parseCharacterCard(source);
  assert.deepEqual(source, before);
});

check("signature, first IHDR, exact IHDR size, and IHDR fields are strict", () => {
  throwsCode(() => inspectPng(Buffer.from("not png")), "PNG_SIGNATURE_INVALID");
  throwsCode(
    () => inspectPng(Buffer.concat([PNG_SIGNATURE, chunk("tEXt", Buffer.from("x"))])),
    "PNG_IHDR_INVALID",
  );
  throwsCode(
    () => inspectPng(Buffer.concat([PNG_SIGNATURE, chunk("IHDR", Buffer.alloc(12))])),
    "PNG_IHDR_INVALID",
  );
  for (const header of [
    ihdr(0, 1),
    ihdr(1, 0),
    ihdr(1, 1, { bitDepth: 3 }),
    ihdr(1, 1, { colorType: 1 }),
    ihdr(1, 1, { compression: 1 }),
    ihdr(1, 1, { filter: 1 }),
    ihdr(1, 1, { interlace: 2 }),
  ]) {
    throwsCode(() => inspectPng(png([], { header })), "PNG_IHDR_INVALID");
  }
});

check("all legal IHDR color and bit-depth combinations are accepted", () => {
  const combinations = [
    [0, 1], [0, 2], [0, 4], [0, 8], [0, 16],
    [2, 8], [2, 16],
    [3, 1], [3, 2], [3, 4], [3, 8],
    [4, 8], [4, 16],
    [6, 8], [6, 16],
  ];
  for (const [colorType, bitDepth] of combinations) {
    const beforeMetadata = colorType === 3 ? [plte(1)] : [];
    inspectPng(png([], {
      header: ihdr(1, 1, { colorType, bitDepth }),
      beforeMetadata,
    }));
  }
});

check("indexed PNG requires a bounded PLTE before IDAT", () => {
  const indexedHeader = ihdr(1, 1, { colorType: 3, bitDepth: 1 });
  throwsCode(
    () => inspectPng(png([], { header: indexedHeader })),
    "PNG_IMAGE_DATA_INVALID",
  );
  throwsCode(
    () => inspectPng(png([], {
      header: indexedHeader,
      beforeMetadata: [plte(3)],
    })),
    "PNG_IMAGE_DATA_INVALID",
  );
  inspectPng(png([], {
    header: indexedHeader,
    beforeMetadata: [plte(2)],
  }));
});

check("grayscale PNG forbids PLTE while truecolor permits one valid palette", () => {
  for (const colorType of [0, 4]) {
    throwsCode(
      () => inspectPng(png([], {
        header: ihdr(1, 1, { colorType, bitDepth: 8 }),
        beforeMetadata: [plte(1)],
      })),
      "PNG_IMAGE_DATA_INVALID",
    );
  }
  inspectPng(png([], {
    header: ihdr(1, 1, { colorType: 2, bitDepth: 8 }),
    beforeMetadata: [plte(1)],
  }));
});

check("PLTE is unique, ordered, nonempty, and exactly RGB entries", () => {
  const invalid = [
    png([], { beforeMetadata: [plte(1), plte(1)] }),
    png([], { afterIdat: [plte(1)] }),
    png([], { beforeMetadata: [chunk("PLTE", Buffer.alloc(0))] }),
    png([], { beforeMetadata: [chunk("PLTE", Buffer.alloc(4))] }),
    png([], { beforeMetadata: [chunk("PLTE", Buffer.alloc(771))] }),
  ];
  for (const source of invalid) {
    throwsCode(() => inspectPng(source), "PNG_IMAGE_DATA_INVALID");
  }
});

check("IDAT chunks are contiguous and unknown critical chunks reject", () => {
  const secondIdat = chunk("IDAT", PIXEL_ZLIB);
  throwsCode(
    () => inspectPng(png([], {
      afterIdat: [textChunk("Comment", Buffer.from("gap")), secondIdat],
    })),
    "PNG_IMAGE_DATA_INVALID",
  );
  throwsCode(
    () => inspectPng(png([], { beforeMetadata: [chunk("ABCD")] })),
    "PNG_CRITICAL_CHUNK_UNSUPPORTED",
    { chunkType: "ABCD" },
  );
});

check("dimension multiplication is overflow-safe and capped at 40 million pixels", () => {
  inspectPng(png([], { width: 40_000_000, height: 1 }));
  throwsCode(
    () => inspectPng(png([], { width: 40_000_001, height: 1 })),
    "PNG_PIXEL_LIMIT_EXCEEDED",
  );
  throwsCode(
    () => inspectPng(png([], { width: 0xffff_ffff, height: 0xffff_ffff })),
    "PNG_PIXEL_LIMIT_EXCEEDED",
  );
});

check("chunk type, CRC, truncation, and huge declared lengths fail safely", () => {
  const badType = Buffer.from(png([]));
  badType.write("1DAT", 8 + ihdr().length + 4, "ascii");
  throwsCode(() => inspectPng(badType), "PNG_CHUNK_TYPE_INVALID");

  const badCrc = Buffer.from(png([textChunk("ccv3", V3)]));
  badCrc[badCrc.length - 1] ^= 1;
  throwsCode(() => inspectPng(badCrc), "PNG_CRC_INVALID");

  const valid = png([textChunk("ccv3", V3)]);
  throwsCode(() => inspectPng(valid.subarray(0, valid.length - 1)), "PNG_TRUNCATED");

  const huge = Buffer.concat([PNG_SIGNATURE, Buffer.alloc(8)]);
  huge.writeUInt32BE(0xffff_ffff, 8);
  huge.write("IHDR", 12, "ascii");
  throwsCode(() => inspectPng(huge), "PNG_TRUNCATED");
});

check("container, per-chunk, chunk-count, and metadata aggregate limits are bounded", () => {
  const source = png([textChunk("ccv3", V3)]);
  throwsCode(
    () => inspectPng(source, { maxContainerBytes: source.length - 1 }),
    "PNG_CONTAINER_LIMIT_EXCEEDED",
  );
  throwsCode(
    () => inspectPng(source, { maxPngChunkBytes: 12 }),
    "PNG_CHUNK_LIMIT_EXCEEDED",
  );
  throwsCode(
    () => inspectPng(source, { maxPngChunks: 2 }),
    "PNG_CHUNK_COUNT_EXCEEDED",
  );
  throwsCode(
    () => inspectPng(source, { maxPngMetadataBytes: 4 }),
    "PNG_METADATA_LIMIT_EXCEEDED",
  );
});

check("recognized card metadata has a small centralized hard chunk cap", () => {
  assert.equal(DEFAULT_IMPORT_LIMITS.maxPngCardChunks, 16);
  const metadata = Array.from({ length: 17 }, () => textChunk("ccv3", V3));
  throwsCode(
    () => inspectPng(png(metadata)),
    "PNG_CARD_CHUNK_COUNT_EXCEEDED",
    { maximum: 16 },
  );
});

check("large compressed chunk sets reject before any inflate or JSON parse", () => {
  const metadata = Array.from({ length: 128 }, () => ztxtChunk("ccv3", V3));
  let parses = 0;
  const original = cardParserModule.parseJsonCharacterCard;
  cardParserModule.parseJsonCharacterCard = (...args) => {
    parses += 1;
    return original(...args);
  };
  try {
    throwsCode(
      () => extractEmbeddedCard(png(metadata)),
      "PNG_CARD_CHUNK_COUNT_EXCEEDED",
      { maximum: 16 },
    );
    assert.equal(parses, 0);
  } finally {
    cardParserModule.parseJsonCharacterCard = original;
  }
});

check("recognized compressed metadata bytes have an aggregate hard budget", () => {
  const first = ztxtChunk("ccv3", V3);
  const metadataBytes = first.readUInt32BE(0);
  throwsCode(
    () => inspectPng(png([first, ztxtChunk("ccv3", V3)]), {
      maxPngCardMetadataBytes: metadataBytes,
    }),
    "PNG_CARD_METADATA_LIMIT_EXCEEDED",
    { maximum: metadataBytes },
  );
});

check("decoded payload bytes share one aggregate 8 MiB budget", () => {
  assert.equal(DEFAULT_IMPORT_LIMITS.maxPngDecodedPayloadBytes, 8 * 1024 * 1024);
  throwsCode(
    () => extractEmbeddedCard(
      png([textChunk("ccv3", V3), ztxtChunk("ccv3", V3)]),
      { maxPngDecodedPayloadBytes: V3.length },
    ),
    "PNG_PAYLOAD_LIMIT_EXCEEDED",
    { maximum: V3.length },
  );
});

check("identical encoded and decoded payload hashes parse JSON only once", () => {
  const source = png([
    textChunk("ccv3", V3),
    ztxtChunk("ccv3", V3),
    itxtChunk("ccv3", V3),
  ]);
  let parses = 0;
  const original = cardParserModule.parseJsonCharacterCard;
  cardParserModule.parseJsonCharacterCard = (...args) => {
    parses += 1;
    return original(...args);
  };
  try {
    const first = extractEmbeddedCard(source);
    const second = extractEmbeddedCard(source);
    assert.equal(first.keyword, "ccv3");
    assert.deepEqual(first.warnings, [{
      code: "PNG_DUPLICATE_PAYLOAD_DEDUPED",
      keyword: "ccv3",
      count: 3,
    }]);
    assert.deepEqual(second.warnings, first.warnings);
    assert.equal(parses, 2);
  } finally {
    cardParserModule.parseJsonCharacterCard = original;
  }
});

check("recognized tEXt, zTXt, and iTXt separators are mandatory", () => {
  throwsCode(
    () => extractEmbeddedCard(png([chunk("tEXt", Buffer.from("ccv3"))])),
    "PNG_TEXT_INVALID",
  );
  throwsCode(
    () => extractEmbeddedCard(png([chunk("zTXt", Buffer.from("ccv3"))])),
    "PNG_TEXT_INVALID",
  );
  throwsCode(
    () => extractEmbeddedCard(png([itxtChunk("ccv3", V3, {
      omitLanguageSeparator: true,
    })])),
    "PNG_TEXT_INVALID",
  );
  throwsCode(
    () => extractEmbeddedCard(png([itxtChunk("ccv3", V3, {
      omitTranslatedSeparator: true,
    })])),
    "PNG_TEXT_INVALID",
  );
});

check("uncompressed iTXt ignores the compression method byte", () => {
  const source = png([itxtChunk("ccv3", V3, { flag: 0, method: 1 })]);
  assert.deepEqual(extractEmbeddedCard(source).json, V3);
  assert.equal(parseCharacterCard(source).canonical.name, "Luna");
});

check("unsupported compressed text methods and flags are rejected", () => {
  throwsCode(
    () => extractEmbeddedCard(png([ztxtChunk("ccv3", V3, { method: 1 })])),
    "PNG_COMPRESSION_UNSUPPORTED",
  );
  throwsCode(
    () => extractEmbeddedCard(png([itxtChunk("ccv3", V3, { flag: 2 })])),
    "PNG_COMPRESSION_UNSUPPORTED",
  );
  throwsCode(
    () => extractEmbeddedCard(png([itxtChunk("ccv3", V3, { flag: 1, method: 1 })])),
    "PNG_COMPRESSION_UNSUPPORTED",
  );
});

check("decompression failures and inflate bombs have distinct stable codes", () => {
  throwsCode(
    () => extractEmbeddedCard(png([ztxtChunk("ccv3", V3, {
      compressed: Buffer.from("not-zlib"),
    })])),
    "PNG_DECOMPRESSION_INVALID",
  );
  const bomb = Buffer.from("A".repeat(4096));
  throwsCode(
    () => extractEmbeddedCard(
      png([ztxtChunk("ccv3", V3, { compressed: deflateSync(bomb) })]),
      { maxPngDecodedPayloadBytes: 64 },
    ),
    "PNG_PAYLOAD_LIMIT_EXCEEDED",
  );
});

check("invalid inflated text still consumes the aggregate envelope budget", () => {
  const invalidText = Buffer.from("!".repeat(64));
  const metadata = () => ztxtChunk("ccv3", V3, {
    compressed: deflateSync(invalidText),
  });
  throwsCode(
    () => extractEmbeddedCard(
      png([metadata(), metadata()]),
      { maxPngDecodedPayloadBytes: 48 },
    ),
    "PNG_PAYLOAD_LIMIT_EXCEEDED",
    { maximum: 48 },
  );
});

check("compressed base64 may use the full decoded JSON allowance", () => {
  for (const metadata of [
    ztxtChunk("ccv3", V3),
    itxtChunk("ccv3", V3, { flag: 1 }),
  ]) {
    const embedded = extractEmbeddedCard(
      png([metadata]),
      { maxPngDecodedPayloadBytes: V3.length },
    );
    assert.deepEqual(embedded.json, V3);
  }
});

check("base64 must be strict, padded, and canonical", () => {
  for (const encoded of [
    "%%%%",
    "YQ",
    "YQ===",
    "Y Q==",
    "YR==",
    "",
  ]) {
    throwsCode(
      () => extractEmbeddedCard(png([textChunk("ccv3", V3, { encoded })])),
      "PNG_BASE64_INVALID",
    );
  }
});

check("iTXt translated keyword and payload require strict UTF-8", () => {
  throwsCode(
    () => extractEmbeddedCard(png([itxtChunk("ccv3", V3, {
      translated: Buffer.from([0xc3, 0x28]),
    })])),
    "PNG_UTF8_INVALID",
  );
  throwsCode(
    () => extractEmbeddedCard(png([itxtChunk("ccv3", V3, {
      encodedBytes: Buffer.from([0xc3, 0x28]),
    })])),
    "PNG_UTF8_INVALID",
  );
});

check("decoded embedded JSON has an independent 8 MiB ceiling", () => {
  const oversized = Buffer.alloc(65, 0x41);
  const encoded = oversized.toString("base64");
  throwsCode(
    () => extractEmbeddedCard(
      png([textChunk("ccv3", oversized, { encoded })]),
      { maxPngDecodedPayloadBytes: 64 },
    ),
    "PNG_PAYLOAD_LIMIT_EXCEEDED",
  );
});

check("IEND is mandatory, exact, final, and follows image data", () => {
  throwsCode(() => inspectPng(png([], { omitIend: true })), "PNG_IEND_INVALID");
  throwsCode(
    () => inspectPng(png([], { trailing: Buffer.from([0]) })),
    "PNG_TRAILING_DATA",
  );
  throwsCode(
    () => inspectPng(png([], { omitIdat: true })),
    "PNG_IMAGE_DATA_INVALID",
  );
  throwsCode(
    () => inspectPng(Buffer.concat([
      PNG_SIGNATURE,
      ihdr(),
      chunk("IDAT", PIXEL_ZLIB),
      chunk("IEND", Buffer.from([0])),
    ])),
    "PNG_IEND_INVALID",
  );
});

check("APNG control lengths, placement, sequence, bounds, and frame counts are strict", () => {
  const invalid = [
    png([], { animation: [chunk("acTL", Buffer.alloc(7)), fctl(0)] }),
    png([], { animation: [fctl(0)] }),
    png([], { animation: [actl(2), fctl(1)], afterIdat: [fctl(2), fdat(3)] }),
    png([], { animation: [actl(2), fctl(0)], afterIdat: [fctl(1), fdat(3)] }),
    png([], { animation: [actl(3), fctl(0)], afterIdat: [fctl(1), fdat(2)] }),
    png([], { animation: [actl(2), fctl(0), fctl(1)] }),
    png([], { animation: [actl(1), fctl(0, { width: 2 })] }),
    png([], { animation: [actl(1), fctl(0, { dispose: 3 })] }),
    png([], { animation: [actl(1), fctl(0, { blend: 2 })] }),
    png([], { animation: [actl(1), fctl(0)], afterIdat: [fdat(1)] }),
  ];
  for (const source of invalid) {
    throwsCode(() => inspectPng(source), "PNG_APNG_INVALID");
  }
});

check("default-frame fcTL before IDAT exactly matches the IHDR canvas", () => {
  const invalid = [
    png([], {
      header: ihdr(2, 2),
      animation: [actl(1), fctl(0, { width: 1, height: 2 })],
    }),
    png([], {
      header: ihdr(2, 2),
      animation: [actl(1), fctl(0, { width: 1, height: 2, x: 1 })],
    }),
  ];
  for (const source of invalid) {
    throwsCode(() => inspectPng(source), "PNG_APNG_INVALID");
  }
  inspectPng(png([], {
    header: ihdr(2, 2),
    animation: [actl(1), fctl(0, { width: 2, height: 2 })],
  }));
});

check("an APNG frame controlled after IDAT may be a bounded canvas subrectangle", () => {
  inspectPng(png([], {
    header: ihdr(2, 2),
    animation: [actl(1)],
    afterIdat: [fctl(0, { width: 1, height: 2, x: 1 }), fdat(1)],
  }));
});

check("malformed recognized payload errors never expose path or payload text", () => {
  const secret = "PRIVATE-PNG-PAYLOAD";
  assert.throws(
    () => extractEmbeddedCard(png([textChunk("ccv3", V3, {
      encoded: secret,
    })])),
    (error) => {
      assert.equal(error.code, "PNG_BASE64_INVALID");
      const surfaces = [
        error.message,
        error.stack,
        JSON.stringify(error),
        ...Object.getOwnPropertyNames(error).map((key) => String(error[key])),
      ];
      assert(surfaces.every((surface) => !surface.includes(secret)));
      return true;
    },
  );
});

const deterministicFixtures = new Map([
  ["v2-character.png", png([textChunk("chara", V2)])],
  ["v3-character.png", png([textChunk("ccv3", V3)])],
  ["v3-character.apng", apng([itxtChunk("ccv3", V3)])],
]);

if (process.argv.includes("--write-fixtures")) {
  fs.mkdirSync(FIXTURES, { recursive: true });
  for (const [name, buffer] of deterministicFixtures) {
    fs.writeFileSync(path.join(FIXTURES, name), buffer);
  }
}

check("committed tiny fixtures are byte-identical to the structural builder", () => {
  for (const [name, expected] of deterministicFixtures) {
    assert.deepEqual(fs.readFileSync(path.join(FIXTURES, name)), expected);
  }
});

console.log(`\ncharacter-card-png: ${checks} checks passed`);
