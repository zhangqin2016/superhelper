"use strict";

const { createHash } = require("node:crypto");
const { inflateSync } = require("node:zlib");
const { cardError, resolveImportLimits } = require("./import-limits");
const {
  PNG_SIGNATURE,
  inspectPng,
  isPngSignature,
} = require("./png-structure");

const CARD_KEYWORDS = ["ccv3", "chara"];

function pngError(code, message, details = {}) {
  return cardError(code, message, { ...details, path: "" });
}

function strictUtf8(bytes) {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw pngError("PNG_UTF8_INVALID", "PNG international text is not valid UTF-8");
  }
}

function inflateBounded(bytes, limits, remaining) {
  const maximum = remaining;
  if (maximum === 0) {
    throw pngError("PNG_PAYLOAD_LIMIT_EXCEEDED", "PNG card payload exceeds its limit", {
      maximum: limits.maxPngDecodedPayloadBytes,
    });
  }
  try {
    return inflateSync(bytes, { maxOutputLength: maximum });
  } catch (error) {
    if (error?.code === "ERR_BUFFER_TOO_LARGE") {
      throw pngError("PNG_PAYLOAD_LIMIT_EXCEEDED", "PNG card payload exceeds its limit", {
        maximum: limits.maxPngDecodedPayloadBytes,
      });
    }
    throw pngError("PNG_DECOMPRESSION_INVALID", "PNG text compression is invalid");
  }
}

function splitAtNull(data, start) {
  const separator = data.indexOf(0, start);
  if (separator < 0) throw pngError("PNG_TEXT_INVALID", "PNG text separators are invalid");
  return separator;
}

function consumeEnvelope(bytes, limits, budget) {
  if (bytes > budget.encoded) {
    throw pngError("PNG_PAYLOAD_LIMIT_EXCEEDED", "PNG card payload exceeds its limit", {
      maximum: limits.maxPngDecodedPayloadBytes,
    });
  }
  budget.encoded -= bytes;
}

function decodeText(chunk, limits, budget) {
  const keywordEnd = splitAtNull(chunk.data, 0);
  if (keywordEnd !== Buffer.byteLength(chunk.keyword, "latin1")) {
    throw pngError("PNG_TEXT_INVALID", "PNG text keyword is invalid");
  }
  if (chunk.type === "tEXt") {
    const textBytes = chunk.data.subarray(keywordEnd + 1);
    consumeEnvelope(textBytes.length, limits, budget);
    return textBytes.toString("latin1");
  }
  if (chunk.type === "zTXt") {
    if (keywordEnd + 1 >= chunk.data.length) {
      throw pngError("PNG_TEXT_INVALID", "PNG compressed text is invalid");
    }
    if (chunk.data[keywordEnd + 1] !== 0) {
      throw pngError("PNG_COMPRESSION_UNSUPPORTED", "PNG text compression is unsupported");
    }
    const textBytes = inflateBounded(
      chunk.data.subarray(keywordEnd + 2),
      limits,
      budget.encoded,
    );
    consumeEnvelope(textBytes.length, limits, budget);
    return textBytes.toString("latin1");
  }
  if (keywordEnd + 2 >= chunk.data.length) {
    throw pngError("PNG_TEXT_INVALID", "PNG international text is invalid");
  }
  const flag = chunk.data[keywordEnd + 1];
  const method = chunk.data[keywordEnd + 2];
  if ((flag !== 0 && flag !== 1) || (flag === 1 && method !== 0)) {
    throw pngError("PNG_COMPRESSION_UNSUPPORTED", "PNG text compression is unsupported");
  }
  const languageEnd = splitAtNull(chunk.data, keywordEnd + 3);
  for (const byte of chunk.data.subarray(keywordEnd + 3, languageEnd)) {
    if (byte > 0x7f) throw pngError("PNG_TEXT_INVALID", "PNG language tag is invalid");
  }
  const translatedEnd = splitAtNull(chunk.data, languageEnd + 1);
  strictUtf8(chunk.data.subarray(languageEnd + 1, translatedEnd));
  const sourceBytes = chunk.data.subarray(translatedEnd + 1);
  const textBytes = flag === 1
    ? inflateBounded(sourceBytes, limits, budget.encoded)
    : sourceBytes;
  consumeEnvelope(textBytes.length, limits, budget);
  return strictUtf8(textBytes);
}

function decodeBase64(text, limits, remaining) {
  const pattern = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
  if (!text || text.length % 4 !== 0 || !pattern.test(text)) {
    throw pngError("PNG_BASE64_INVALID", "PNG card payload is not canonical base64");
  }
  if (text.length > Math.ceil(remaining / 3) * 4) {
    throw pngError("PNG_PAYLOAD_LIMIT_EXCEEDED", "PNG card payload exceeds its limit", {
      maximum: limits.maxPngDecodedPayloadBytes,
    });
  }
  const decoded = Buffer.from(text, "base64");
  if (decoded.length > remaining || decoded.toString("base64") !== text) {
    throw pngError(
      decoded.length > remaining ? "PNG_PAYLOAD_LIMIT_EXCEEDED" : "PNG_BASE64_INVALID",
      "PNG card payload is invalid",
      { maximum: limits.maxPngDecodedPayloadBytes },
    );
  }
  return decoded;
}

function hashPayload(type, bytes) {
  return createHash("sha256").update(type).update(bytes).digest("hex");
}

function findExact(cache, hash, predicate) {
  return cache.get(hash)?.find(predicate) || null;
}

function decodeCandidate(chunk, limits, budget, cache) {
  const hash = hashPayload(chunk.type, chunk.data);
  const exact = findExact(cache, hash, (entry) => (
    entry.type === chunk.type && entry.data.equals(chunk.data)
  ));
  if (exact) {
    consumeEnvelope(exact.envelopeBytes, limits, budget);
    if (exact.error) throw exact.error;
    if (exact.json.length > budget.decoded) {
      throw pngError("PNG_PAYLOAD_LIMIT_EXCEEDED", "PNG card payload exceeds its limit", {
        maximum: limits.maxPngDecodedPayloadBytes,
      });
    }
    return exact.json;
  }
  const beforeEnvelope = budget.encoded;
  let result;
  try {
    result = {
      json: decodeBase64(
        decodeText(chunk, limits, budget),
        limits,
        budget.decoded,
      ),
    };
  } catch (error) {
    result = { error };
  }
  const entries = cache.get(hash) || [];
  entries.push({
    type: chunk.type,
    data: chunk.data,
    envelopeBytes: beforeEnvelope - budget.encoded,
    ...result,
  });
  cache.set(hash, entries);
  if (result.error) throw result.error;
  return result.json;
}

function parseCandidate(chunk, json, limits, cache) {
  const hash = hashPayload("json", json);
  let exact = findExact(cache, hash, (entry) => entry.json.equals(json));
  if (!exact) {
    try {
      const { parseJsonCharacterCard } = require("./card-parser");
      exact = { json, parsed: parseJsonCharacterCard(json, { limits }) };
    } catch (error) {
      exact = { json, error };
    }
    const entries = cache.get(hash) || [];
    entries.push(exact);
    cache.set(hash, entries);
  }
  if (exact.error) throw exact.error;
  const parsed = exact.parsed;
  if (chunk.keyword === "ccv3" && parsed.format !== "v3_json") {
    throw pngError("PNG_PAYLOAD_VERSION_MISMATCH", "ccv3 payload is not a V3 card");
  }
  return { keyword: chunk.keyword, json, parsed };
}

function resolveKeyword(keyword, candidates, ignoreConflict = false) {
  const valid = candidates.filter((candidate) => candidate.value);
  const invalid = candidates.filter((candidate) => candidate.error);
  const unique = [];
  for (const candidate of valid) {
    if (!unique.some((entry) => entry.json.equals(candidate.value.json))) {
      unique.push({ ...candidate.value, json: candidate.value.json });
    }
  }
  if (unique.length > 1) {
    if (ignoreConflict) {
      const warnings = [{
        code: "PNG_MIRROR_CONFLICT_IGNORED",
        selectedKeyword: "ccv3",
        ignoredKeyword: keyword,
        conflictingPayloads: unique.length,
      }];
      if (invalid.length > 0) {
        warnings.push({
          code: "PNG_INVALID_PAYLOAD_IGNORED",
          keyword,
          count: invalid.length,
          reason: invalid[0].error.code,
        });
      }
      return {
        value: null,
        invalid,
        conflict: true,
        warnings,
      };
    }
    throw pngError("PNG_PAYLOAD_CONFLICT", "PNG card payload chunks conflict", { keyword });
  }
  const warnings = [];
  if (valid.length > 1 && unique.length === 1) {
    warnings.push({ code: "PNG_DUPLICATE_PAYLOAD_DEDUPED", keyword, count: valid.length });
  }
  if (unique.length === 1 && invalid.length > 0) {
    warnings.push({
      code: "PNG_INVALID_PAYLOAD_IGNORED",
      keyword,
      count: invalid.length,
      reason: invalid[0].error.code,
    });
  }
  return { value: unique[0] || null, invalid, conflict: false, warnings };
}

function collectCandidates(chunks, limits) {
  const grouped = { ccv3: [], chara: [] };
  const encodedCache = new Map();
  const parsedCache = new Map();
  const budget = {
    decoded: limits.maxPngDecodedPayloadBytes,
    encoded: Math.ceil(limits.maxPngDecodedPayloadBytes / 3) * 4,
  };
  for (const keyword of CARD_KEYWORDS) {
    for (const chunk of chunks.filter((entry) => entry.keyword === keyword)) {
      try {
        const json = decodeCandidate(chunk, limits, budget, encodedCache);
        budget.decoded -= json.length;
        grouped[keyword].push({
          value: parseCandidate(chunk, json, limits, parsedCache),
        });
      } catch (error) {
        if (typeof error?.code !== "string") throw error;
        if (error.code === "PNG_PAYLOAD_LIMIT_EXCEEDED") throw error;
        grouped[keyword].push({ error });
      }
    }
  }
  return grouped;
}

function selectCandidate(grouped) {
  const high = resolveKeyword("ccv3", grouped.ccv3);
  const low = resolveKeyword("chara", grouped.chara, Boolean(high.value));
  let selected;
  const warnings = [...high.warnings, ...low.warnings];
  if (high.value) {
    selected = high.value;
    if (low.value) {
      warnings.push({
        code: high.value.json.equals(low.value.json)
          ? "PNG_DUPLICATE_MIRROR_DEDUPED"
          : "PNG_PAYLOAD_PRECEDENCE",
        selectedKeyword: "ccv3",
        ignoredKeyword: "chara",
      });
    } else if (!low.conflict && low.invalid.length > 0) {
      warnings.push({
        code: "PNG_INVALID_MIRROR_IGNORED",
        selectedKeyword: "ccv3",
        invalidKeyword: "chara",
        reason: low.invalid[0].error.code,
      });
    }
  } else if (low.value) {
    selected = low.value;
    if (high.invalid.length > 0) {
      warnings.push({
        code: "PNG_PAYLOAD_DOWNGRADE",
        selectedKeyword: "chara",
        invalidKeyword: "ccv3",
        reason: high.invalid[0].error.code,
      });
    }
  } else {
    throw high.invalid[0]?.error
      || low.invalid[0]?.error
      || pngError("NOT_A_CHARACTER_CARD", "PNG has no valid character card payload");
  }
  return { selected, warnings };
}

function extractEmbeddedCard(buffer, overrides = {}) {
  const limits = resolveImportLimits(overrides);
  const inspected = inspectPng(buffer, limits);
  if (inspected.cardChunks.length === 0) {
    throw pngError("NOT_A_CHARACTER_CARD", "PNG has no character card payload");
  }
  const { selected, warnings } = selectCandidate(
    collectCandidates(inspected.cardChunks, limits),
  );
  return {
    ...selected,
    container: inspected.container,
    warnings,
  };
}

module.exports = {
  PNG_SIGNATURE,
  extractEmbeddedCard,
  inspectPng,
  isPngSignature,
};
