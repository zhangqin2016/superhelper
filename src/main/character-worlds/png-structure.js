"use strict";

const { cardError, resolveImportLimits } = require("./import-limits");

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const CARD_KEYWORDS = ["ccv3", "chara"];
const CARD_KEYWORD_BYTES = CARD_KEYWORDS.map((keyword) => (
  [keyword, Buffer.from(keyword, "latin1")]
));
const VALID_COLOR_DEPTHS = new Map([
  [0, new Set([1, 2, 4, 8, 16])],
  [2, new Set([8, 16])],
  [3, new Set([1, 2, 4, 8])],
  [4, new Set([8, 16])],
  [6, new Set([8, 16])],
]);
const CRC_TABLE = Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit += 1) {
    crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb8_8320 : 0);
  }
  return crc >>> 0;
});

function pngError(code, message, details = {}) {
  return cardError(code, message, { ...details, path: "" });
}

function crc32(typeBytes, data) {
  let crc = 0xffff_ffff;
  for (const bytes of [typeBytes, data]) {
    for (const byte of bytes) {
      crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
    }
  }
  return (crc ^ 0xffff_ffff) >>> 0;
}

function isPngSignature(buffer) {
  return Buffer.isBuffer(buffer)
    && buffer.length >= PNG_SIGNATURE.length
    && buffer.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE);
}

function validChunkType(typeBytes) {
  if (typeBytes.length !== 4) return false;
  for (const byte of typeBytes) {
    if (!((byte >= 65 && byte <= 90) || (byte >= 97 && byte <= 122))) return false;
  }
  return typeBytes[2] >= 65 && typeBytes[2] <= 90;
}

function validateIhdr(data, limits) {
  if (data.length !== 13) {
    throw pngError("PNG_IHDR_INVALID", "PNG IHDR is invalid");
  }
  const width = data.readUInt32BE(0);
  const height = data.readUInt32BE(4);
  const bitDepth = data[8];
  const colorType = data[9];
  if (
    width === 0
    || height === 0
    || !VALID_COLOR_DEPTHS.get(colorType)?.has(bitDepth)
    || data[10] !== 0
    || data[11] !== 0
    || data[12] > 1
  ) {
    throw pngError("PNG_IHDR_INVALID", "PNG IHDR is invalid");
  }
  if (width > Math.floor(limits.maxPngPixels / height)) {
    throw pngError("PNG_PIXEL_LIMIT_EXCEEDED", "PNG pixel count exceeds its limit", {
      maximum: limits.maxPngPixels,
    });
  }
  return { width, height, bitDepth, colorType };
}

function validateFrameControl(data, state, width, height) {
  if (data.length !== 26 || !state.animation) {
    throw pngError("PNG_APNG_INVALID", "APNG frame control is invalid");
  }
  if (state.currentFrameKind && !state.currentFrameHasData) {
    throw pngError("PNG_APNG_INVALID", "APNG frame data is missing");
  }
  const sequence = data.readUInt32BE(0);
  const frameWidth = data.readUInt32BE(4);
  const frameHeight = data.readUInt32BE(8);
  const x = data.readUInt32BE(12);
  const y = data.readUInt32BE(16);
  if (
    sequence !== state.animation.nextSequence
    || frameWidth === 0
    || frameHeight === 0
    || x > width
    || y > height
    || frameWidth > width - x
    || frameHeight > height - y
    || (!state.seenIdat && (
      frameWidth !== width || frameHeight !== height || x !== 0 || y !== 0
    ))
    || data[24] > 2
    || data[25] > 1
  ) {
    throw pngError("PNG_APNG_INVALID", "APNG frame control is invalid");
  }
  state.animation.nextSequence += 1;
  state.animation.frameControls += 1;
  state.currentFrameKind = state.seenIdat ? "fdat" : "idat";
  state.currentFrameHasData = false;
}

function processApngChunk(type, data, state, width, height) {
  if (type === "acTL") {
    if (data.length !== 8 || state.animation || state.seenIdat) {
      throw pngError("PNG_APNG_INVALID", "APNG animation control is invalid");
    }
    const frames = data.readUInt32BE(0);
    if (frames === 0) {
      throw pngError("PNG_APNG_INVALID", "APNG frame count is invalid");
    }
    state.animation = {
      frames,
      plays: data.readUInt32BE(4),
      frameControls: 0,
      nextSequence: 0,
    };
    return true;
  }
  if (type === "fcTL") {
    validateFrameControl(data, state, width, height);
    return true;
  }
  if (type === "fdAT") {
    if (
      data.length < 4
      || !state.animation
      || state.currentFrameKind !== "fdat"
      || data.readUInt32BE(0) !== state.animation.nextSequence
    ) {
      throw pngError("PNG_APNG_INVALID", "APNG frame data is invalid");
    }
    state.animation.nextSequence += 1;
    state.currentFrameHasData = true;
    return true;
  }
  return false;
}

function startsWithKeyword(data, keywordBytes) {
  return data.length >= keywordBytes.length
    && data.subarray(0, keywordBytes.length).equals(keywordBytes)
    && (data.length === keywordBytes.length || data[keywordBytes.length] === 0);
}

function recognizedTextChunk(type, data) {
  if (!["tEXt", "zTXt", "iTXt"].includes(type)) return null;
  const separator = data.indexOf(0);
  if (separator > 0) {
    const keyword = data.subarray(0, separator).toString("latin1");
    return CARD_KEYWORDS.includes(keyword) ? { type, keyword, data } : null;
  }
  for (const [keyword, keywordBytes] of CARD_KEYWORD_BYTES) {
    if (startsWithKeyword(data, keywordBytes)) return { type, keyword, data };
  }
  return null;
}

function inspectPng(buffer, overrides = {}) {
  const limits = resolveImportLimits(overrides);
  if (!Buffer.isBuffer(buffer) || !isPngSignature(buffer)) {
    throw pngError("PNG_SIGNATURE_INVALID", "PNG signature is invalid");
  }
  if (buffer.length > limits.maxContainerBytes) {
    throw pngError("PNG_CONTAINER_LIMIT_EXCEEDED", "PNG container exceeds its limit", {
      maximum: limits.maxContainerBytes,
    });
  }
  let offset = PNG_SIGNATURE.length;
  let chunkCount = 0;
  let metadataBytes = 0;
  let cardMetadataBytes = 0;
  let dimensions = null;
  const cardChunks = [];
  const state = {
    animation: null,
    currentFrameHasData: false,
    currentFrameKind: null,
    endedIdat: false,
    seenIdat: false,
    seenIend: false,
    seenPlte: false,
  };

  while (offset < buffer.length) {
    if (buffer.length - offset < 12) {
      throw pngError("PNG_TRUNCATED", "PNG chunk is truncated");
    }
    const length = buffer.readUInt32BE(offset);
    const typeBytes = buffer.subarray(offset + 4, offset + 8);
    if (!validChunkType(typeBytes)) {
      throw pngError("PNG_CHUNK_TYPE_INVALID", "PNG chunk type is invalid");
    }
    const type = typeBytes.toString("ascii");
    if (length > buffer.length - offset - 12) {
      throw pngError("PNG_TRUNCATED", "PNG chunk is truncated");
    }
    if (length > limits.maxPngChunkBytes) {
      throw pngError("PNG_CHUNK_LIMIT_EXCEEDED", "PNG chunk exceeds its limit", {
        maximum: limits.maxPngChunkBytes,
      });
    }
    chunkCount += 1;
    if (chunkCount > limits.maxPngChunks) {
      throw pngError("PNG_CHUNK_COUNT_EXCEEDED", "PNG has too many chunks", {
        maximum: limits.maxPngChunks,
      });
    }
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    const data = buffer.subarray(dataStart, dataEnd);
    if (crc32(typeBytes, data) !== buffer.readUInt32BE(dataEnd)) {
      throw pngError("PNG_CRC_INVALID", "PNG chunk CRC is invalid", { chunkType: type });
    }
    if (chunkCount === 1) {
      if (type !== "IHDR") throw pngError("PNG_IHDR_INVALID", "PNG IHDR must be first");
      dimensions = validateIhdr(data, limits);
    } else if (type === "IHDR") {
      throw pngError("PNG_IHDR_INVALID", "PNG IHDR is duplicated");
    }

    if (type === "PLTE") {
      const entries = length / 3;
      if (
        state.seenPlte
        || state.seenIdat
        || length === 0
        || length % 3 !== 0
        || length > 768
        || [0, 4].includes(dimensions.colorType)
        || (dimensions.colorType === 3 && entries > 2 ** dimensions.bitDepth)
      ) {
        throw pngError("PNG_IMAGE_DATA_INVALID", "PNG palette is invalid");
      }
      state.seenPlte = true;
    } else if (type === "IDAT") {
      if (state.endedIdat || (dimensions.colorType === 3 && !state.seenPlte)) {
        throw pngError("PNG_IMAGE_DATA_INVALID", "PNG image data is not consecutive");
      }
      state.seenIdat = true;
      if (state.currentFrameKind === "idat") state.currentFrameHasData = true;
    } else if (state.seenIdat && type !== "IEND") {
      state.endedIdat = true;
    }

    const isAnimationChunk = processApngChunk(
      type,
      data,
      state,
      dimensions?.width,
      dimensions?.height,
    );
    if (["tEXt", "zTXt", "iTXt"].includes(type)) {
      metadataBytes += length;
      if (metadataBytes > limits.maxPngMetadataBytes) {
        throw pngError("PNG_METADATA_LIMIT_EXCEEDED", "PNG metadata exceeds its limit", {
          maximum: limits.maxPngMetadataBytes,
        });
      }
      const candidate = recognizedTextChunk(type, data);
      if (candidate) {
        cardMetadataBytes += length;
        if (cardChunks.length >= limits.maxPngCardChunks) {
          throw pngError("PNG_CARD_CHUNK_COUNT_EXCEEDED", "PNG has too many card chunks", {
            maximum: limits.maxPngCardChunks,
          });
        }
        if (cardMetadataBytes > limits.maxPngCardMetadataBytes) {
          throw pngError("PNG_CARD_METADATA_LIMIT_EXCEEDED", "PNG card metadata is too large", {
            maximum: limits.maxPngCardMetadataBytes,
          });
        }
        cardChunks.push(candidate);
      }
    } else if (
      !isAnimationChunk
      && typeBytes[0] >= 65
      && typeBytes[0] <= 90
      && !["IHDR", "PLTE", "IDAT", "IEND"].includes(type)
    ) {
      throw pngError("PNG_CRITICAL_CHUNK_UNSUPPORTED", "PNG critical chunk is unsupported", {
        chunkType: type,
      });
    }

    offset = dataEnd + 4;
    if (type === "IEND") {
      if (length !== 0) throw pngError("PNG_IEND_INVALID", "PNG IEND is invalid");
      if (!state.seenIdat) {
        throw pngError("PNG_IMAGE_DATA_INVALID", "PNG image data is missing");
      }
      if (offset !== buffer.length) {
        throw pngError("PNG_TRAILING_DATA", "PNG contains data after IEND");
      }
      state.seenIend = true;
      break;
    }
  }
  if (!state.seenIend) throw pngError("PNG_IEND_INVALID", "PNG IEND is missing");
  if (state.animation) {
    if (
      state.animation.frameControls !== state.animation.frames
      || state.animation.frameControls === 0
      || !state.currentFrameHasData
    ) {
      throw pngError("PNG_APNG_INVALID", "APNG frame count or data is invalid");
    }
  }
  return {
    container: state.animation ? "apng" : "png",
    width: dimensions.width,
    height: dimensions.height,
    chunkCount,
    metadataBytes,
    cardChunks,
    animation: state.animation
      ? { frames: state.animation.frames, plays: state.animation.plays }
      : null,
  };
}

module.exports = {
  PNG_SIGNATURE,
  inspectPng,
  isPngSignature,
};
