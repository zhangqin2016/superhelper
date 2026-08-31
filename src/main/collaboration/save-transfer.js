"use strict";
const fs = require("node:fs");
const crypto = require("node:crypto");
const { brokerPath, exclusiveOutput } = require("./encrypted-container");
const fail = (code) => Object.assign(new Error(code), { code, retryable: false });

/** Only native picker + main-owned verified metadata may call this broker.
 * Copy to an exclusive sibling temporary file; link publishes without replacing
 * another writer's destination. Uses the same ownership primitive as LILYENC1.
 */
async function saveVerifiedDownload({ sourcePath, destinationPath, expectedSize, expectedSha256, assertAuthorized, beforePublish } = {}) {
  if (!Number.isSafeInteger(expectedSize) || expectedSize < 0 || expectedSize > 1024 ** 3
    || typeof expectedSha256 !== "string" || !/^[a-f0-9]{64}$/.test(expectedSha256)
    || typeof assertAuthorized !== "function" || typeof beforePublish !== "function") throw fail("COLLAB_TRANSFER_NOT_READY");
  const guard = () => { const result = assertAuthorized(); if (result === false || result?.then) throw fail("COLLAB_ACCESS_REVOKED"); };
  guard();
  const source = await brokerPath(sourcePath), destination = await brokerPath(destinationPath, true);
  const before = await fs.promises.lstat(source);
  if (!before.isFile() || before.nlink !== 1 || before.size !== expectedSize) throw fail("COLLAB_TRANSFER_UNSAFE_PATH");
  const file = await fs.promises.open(source, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0));
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.size !== expectedSize || stat.dev !== before.dev || stat.ino !== before.ino) throw fail("COLLAB_TRANSFER_UNSAFE_PATH");
    guard();
    return await exclusiveOutput(destination, async (output) => {
      const hash = crypto.createHash("sha256"), bytes = Buffer.alloc(65536);
      for (let position = 0; position < expectedSize;) {
        const { bytesRead } = await file.read(bytes, 0, Math.min(bytes.length, expectedSize - position), position);
        if (!bytesRead) throw fail("COLLAB_TRANSFER_INTEGRITY_FAILED");
        guard(); hash.update(bytes.subarray(0, bytesRead));
        await new Promise((resolve, reject) => output.write(bytes.subarray(0, bytesRead), (error) => error ? reject(error) : resolve()));
        position += bytesRead;
      }
      if ((await file.stat()).size !== expectedSize || hash.digest("hex") !== expectedSha256) throw fail("COLLAB_TRANSFER_INTEGRITY_FAILED");
      return { ok: true, saved: true, bytes: expectedSize };
    }, async () => { await beforePublish(); guard(); await brokerPath(destination, true); guard(); });
  } finally { await file.close(); }
}

module.exports = { saveVerifiedDownload };
