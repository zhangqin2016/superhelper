"use strict";

const { MAX_CHARACTER_SOURCE_BYTES } = require("./constants");

const MAX_STRING_DECODE_BYTES = 4096;

function whitespace(byte) {
  return byte === 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d;
}

function nextSignificant(bytes, index, limit) {
  let cursor = index;
  while (cursor < limit && whitespace(bytes[cursor])) cursor += 1;
  return cursor;
}

function scanString(bytes, start, limit) {
  let cursor = start + 1;
  let escaped = false;
  while (cursor < limit) {
    const byte = bytes[cursor];
    if (byte < 0x20) return { end: cursor + 1, value: null };
    if (escaped) {
      if (byte === 0x75) {
        if (cursor + 4 >= limit) return { end: limit, value: null };
        for (let index = cursor + 1; index <= cursor + 4; index += 1) {
          const hex = bytes[index];
          if (!(
            (hex >= 0x30 && hex <= 0x39)
            || (hex >= 0x41 && hex <= 0x46)
            || (hex >= 0x61 && hex <= 0x66)
          )) {
            return { end: index + 1, value: null };
          }
        }
        cursor += 4;
      }
      escaped = false;
    } else if (byte === 0x5c) {
      escaped = true;
    } else if (byte === 0x22) {
      const end = cursor + 1;
      if (end - start > MAX_STRING_DECODE_BYTES) return { end, value: null };
      try {
        return {
          end,
          value: JSON.parse(bytes.subarray(start, end).toString("utf8")),
        };
      } catch {
        return { end, value: null };
      }
    }
    cursor += 1;
  }
  return { end: limit, value: null };
}

function consumePending(frame) {
  if (!frame || frame.type !== "object") return null;
  const key = frame.pendingKey;
  frame.pendingKey = null;
  return key;
}

function jsonCardCandidate(input) {
  const bytes = Buffer.isBuffer(input) ? input : Buffer.from(input);
  const limit = Math.min(bytes.length, MAX_CHARACTER_SOURCE_BYTES);
  let start = limit >= 3
    && bytes[0] === 0xef
    && bytes[1] === 0xbb
    && bytes[2] === 0xbf
    ? 3
    : 0;
  start = nextSignificant(bytes, start, limit);
  if (bytes[start] !== 0x7b) return { container: false, marked: false };

  const frames = new Map();
  const topKeys = new Set();
  let marked = false;
  let depth = 0;
  let cursor = start;

  while (cursor < limit) {
    const byte = bytes[cursor];
    if (byte === 0x22) {
      const token = scanString(bytes, cursor, limit);
      const frame = frames.get(depth);
      if (frame) {
        const after = nextSignificant(bytes, token.end, limit);
        if (frame.type === "object" && bytes[after] === 0x3a) {
          frame.pendingKey = token.value;
          if (frame.scope === "root" && typeof token.value === "string") {
            topKeys.add(token.value);
            if (token.value === "name" || token.value === "char_name") marked = true;
          } else if (
            frame.scope === "data"
            && (token.value === "name" || token.value === "char_name")
          ) {
            marked = true;
          }
        } else {
          const key = consumePending(frame);
          if (
            frame.scope === "root"
            && key === "spec"
            && typeof token.value === "string"
            && /^chara_card_v[23]$/i.test(token.value)
          ) {
            marked = true;
          }
        }
      }
      cursor = Math.max(token.end, cursor + 1);
      continue;
    }

    if (byte === 0x7b || byte === 0x5b) {
      const parent = frames.get(depth);
      const parentKey = consumePending(parent);
      depth += 1;
      if (depth <= 2) {
        const scope = depth === 1
          ? "root"
          : parent?.scope === "root" && parentKey === "data"
            ? "data"
            : "other";
        frames.set(depth, {
          type: byte === 0x7b ? "object" : "array",
          scope,
          pendingKey: null,
        });
      }
      cursor += 1;
      continue;
    }

    if (byte === 0x7d || byte === 0x5d) {
      frames.delete(depth);
      if (depth > 0) depth -= 1;
      cursor += 1;
      continue;
    }

    if (
      !whitespace(byte)
      && byte !== 0x2c
      && byte !== 0x3a
    ) {
      consumePending(frames.get(depth));
    }
    cursor += 1;
  }

  if (topKeys.has("data") && topKeys.has("spec_version")) marked = true;
  return { container: true, marked };
}

module.exports = {
  jsonCardCandidate,
};
