"use strict";

const { parentPort } = require("node:worker_threads");
const v8 = require("node:v8");
const { parseCharacterCard } = require("./card-parser");
const { jsonCardCandidate } = require("./card-discriminator");
const { MAX_CHARACTER_WORKER_RESULT_BYTES } = require("./constants");
const { isPngSignature } = require("./png-card");

function ordinaryAttachment() {
  return {
    ok: false,
    kind: "ordinaryAttachment",
    code: "NOT_A_CHARACTER_CARD",
  };
}

function safeError(error) {
  const code = typeof error?.code === "string" && /^[A-Z0-9_]{3,80}$/.test(error.code)
    ? error.code
    : "IMPORT_PARSE_FAILED";
  return {
    code,
    ...(["limit", "maximum", "actual", "limitKind", "limitsVersion", "entryId"].reduce(
      (result, key) => {
        const value = error?.[key];
        // Bounded enums/numbers only — never paths or messages.
        if (Number.isFinite(value)) result[key] = value;
        else if (typeof value === "string" && value.length <= 1024) result[key] = value;
        return result;
      },
      {},
    )),
  };
}

function postParsed(jobId, parsed) {
  const serialized = v8.serialize(parsed);
  if (serialized.byteLength > MAX_CHARACTER_WORKER_RESULT_BYTES) {
    parentPort.postMessage({
      jobId,
      ok: false,
      error: { code: "IMPORT_WORKER_RESULT_TOO_LARGE" },
    });
    return;
  }
  const payload = Uint8Array.from(serialized).buffer;
  parentPort.postMessage({ jobId, ok: true, payload }, [payload]);
}

parentPort.on("message", (message) => {
  const jobId = message?.jobId;
  try {
    if (typeof jobId !== "string" || !(message?.bytes instanceof ArrayBuffer)) {
      parentPort.postMessage({
        jobId,
        ok: false,
        error: { code: "IMPORT_WORKER_PROTOCOL" },
      });
      return;
    }
    const bytes = Buffer.from(message.bytes);
    const pngCandidate = isPngSignature(bytes);
    const json = jsonCardCandidate(bytes);
    if (!pngCandidate && !json.container) {
      postParsed(jobId, ordinaryAttachment());
      return;
    }
    try {
      const parsed = parseCharacterCard(bytes);
      postParsed(jobId, parsed);
    } catch (error) {
      if (error?.code === "NOT_A_CHARACTER_CARD") {
        postParsed(jobId, ordinaryAttachment());
        return;
      }
      if (!pngCandidate && !json.marked) {
        postParsed(jobId, ordinaryAttachment());
        return;
      }
      parentPort.postMessage({ jobId, ok: false, error: safeError(error) });
    }
  } catch {
    parentPort.postMessage({
      jobId,
      ok: false,
      error: { code: "IMPORT_PARSE_FAILED" },
    });
  }
});
