"use strict";

const crypto = require("node:crypto");
const { DEFAULT_MACRO_LIMITS } = require("./constants");
const { isWellFormedUtf16 } = require("./macro-unicode");

const DOMAIN = Buffer.from("lily-character-macro-prng:v1\0", "ascii");
const UINT32_RANGE = 0x1_0000_0000;
const UINT32_MAX = 0xffff_ffff;

function createCounterPrng(seed, occurrence) {
  if (typeof seed !== "string") throw new TypeError("Invalid deterministic random seed");
  if (!isWellFormedUtf16(seed)) throw new RangeError("Ill-formed deterministic random seed");
  const seedBytes = Buffer.from(seed, "utf8");
  if (seedBytes.length > DEFAULT_MACRO_LIMITS.maxSeedBytes) {
    throw new RangeError("Deterministic random seed exceeds hard limit");
  }
  if (!Number.isInteger(occurrence) || occurrence < 0 || occurrence > UINT32_MAX) {
    throw new RangeError("Invalid deterministic random occurrence");
  }
  let blockCounter = 0;
  let wordOffset = 8;
  let block = null;
  let wordsRead = 0;

  return {
    nextUInt32() {
      if (wordOffset >= 8) {
        const header = Buffer.allocUnsafe(12);
        header.writeUInt32BE(seedBytes.length, 0);
        header.writeUInt32BE(occurrence, 4);
        header.writeUInt32BE(blockCounter >>> 0, 8);
        block = crypto.createHash("sha256")
          .update(DOMAIN)
          .update(header)
          .update(seedBytes)
          .digest();
        blockCounter += 1;
        wordOffset = 0;
      }
      const value = block.readUInt32BE(wordOffset * 4);
      wordOffset += 1;
      wordsRead += 1;
      return value;
    },
    get wordsRead() {
      return wordsRead;
    },
  };
}

function uniformInt(prng, upperExclusive, options = {}) {
  if (!Number.isSafeInteger(upperExclusive)
      || upperExclusive < 1
      || upperExclusive > UINT32_RANGE) {
    throw new RangeError("Invalid deterministic random bound");
  }
  const maxDraws = Number.isSafeInteger(options.maxDraws) && options.maxDraws >= 0
    ? Math.min(options.maxDraws, DEFAULT_MACRO_LIMITS.maxRandomDrawsPerChoice)
    : DEFAULT_MACRO_LIMITS.maxRandomDrawsPerChoice;
  const reserveDraw = typeof options.reserveDraw === "function"
    ? options.reserveDraw
    : null;
  const acceptedRange = Math.floor(UINT32_RANGE / upperExclusive) * upperExclusive;
  for (let draw = 0; draw < maxDraws; draw += 1) {
    if (reserveDraw && reserveDraw() === false) return null;
    const value = prng.nextUInt32();
    if (value < acceptedRange) return value % upperExclusive;
  }
  return null;
}

module.exports = {
  createCounterPrng,
  createMacroPrng: createCounterPrng,
  uniformInt,
};
