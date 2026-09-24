"use strict";

/**
 * A file the task produced, sent to the phone that asks for it.
 *
 * Only what the desktop itself shows as this conversation's output can leave:
 * the phone names an artifactId, and it is served only when (1) that id is on
 * a produced-file card of the conversation the phone drives, and (2) the
 * desktop's artifact registry resolves that exact id inside the session's
 * workspace. A path is never accepted — the registry would resolve any
 * existing file by path. The bytes travel over the phone's relay in chunks
 * sized under the relay's 256 KB frame limit; nothing is stored on the server.
 */

const crypto = require("node:crypto");
const fs = require("node:fs");

const FILE_LIMITS = Object.freeze({
  MAX_BYTES: 20 * 1024 * 1024,
  CHUNK_BYTES: 150 * 1024, // base64 ≈ 200 KB + envelope, under the relay's 256 KB
});

/** The artifact ids a conversation shows as produced files (desktop's own cards). */
function conversationArtifactIds(conversation) {
  const ids = new Set();
  for (const message of Array.isArray(conversation) ? conversation : []) {
    if (message?.role !== "assistant") continue;
    const artifacts = message.artifacts || message.record?.artifacts || [];
    for (const artifact of Array.isArray(artifacts) ? artifacts : []) {
      const id = String(artifact?.artifactId || artifact?.id || "");
      if (id) ids.add(id);
    }
  }
  return ids;
}

/**
 * Decide and describe a file request. Pure over its inputs.
 * @returns {{ ok: true, path, name, mimeType, bytes } | { ok: false, code }}
 */
function planFileSend({ artifactId, conversation, resolve, stat }) {
  const id = String(artifactId || "");
  if (!id) return { ok: false, code: "FILE_REQUEST_INVALID" };
  if (!conversationArtifactIds(conversation).has(id)) return { ok: false, code: "FILE_NOT_IN_CONVERSATION" };
  const resolved = resolve(id);
  if (!resolved?.ok || resolved.artifactId !== id || !resolved.path) return { ok: false, code: "FILE_NOT_FOUND" };
  const info = stat(resolved.path);
  if (!info || !info.isFile) return { ok: false, code: "FILE_NOT_FOUND" };
  if (info.size > FILE_LIMITS.MAX_BYTES) return { ok: false, code: "FILE_TOO_LARGE", bytes: info.size };
  const name = String(resolved.path).split(/[\\/]/).pop() || "file";
  return { ok: true, path: resolved.path, name, mimeType: resolved.artifact?.mimeType || "application/octet-stream", bytes: info.size };
}

/** Split a buffer into the frames the phone reassembles. */
function fileFrames({ requestId, artifactId, name, mimeType, buffer }) {
  const count = Math.max(1, Math.ceil(buffer.length / FILE_LIMITS.CHUNK_BYTES));
  const frames = [{
    type: "file.start", requestId, artifactId, name, mimeType, bytes: buffer.length, count,
    sha256: crypto.createHash("sha256").update(buffer).digest("hex"),
  }];
  for (let index = 0; index < count; index += 1) {
    const part = buffer.subarray(index * FILE_LIMITS.CHUNK_BYTES, (index + 1) * FILE_LIMITS.CHUNK_BYTES);
    frames.push({ type: "file.chunk", requestId, index, data: part.toString("base64") });
  }
  return frames;
}

function statFile(filePath) {
  try {
    const s = fs.statSync(filePath);
    return { isFile: s.isFile(), size: s.size };
  } catch {
    return null;
  }
}

module.exports = { FILE_LIMITS, conversationArtifactIds, planFileSend, fileFrames, statFile };
