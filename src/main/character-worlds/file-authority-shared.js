"use strict";

const fs = require("node:fs");

function importError(code, message) {
  return Object.assign(new Error(message), { code });
}

function signalError(signal, fallbackCode, fallbackMessage) {
  const reason = signal?.reason;
  if (reason && typeof reason.code === "string") return reason;
  return importError(fallbackCode, fallbackMessage);
}

function assertNotAborted(signal, fallbackCode, fallbackMessage) {
  if (signal?.aborted) throw signalError(signal, fallbackCode, fallbackMessage);
}

function canonicalRoots(roots) {
  if (!Array.isArray(roots) || roots.length === 0) {
    throw new TypeError("At least one authorized filesystem root is required");
  }
  if (roots.length > 32) throw new TypeError("Too many authorized filesystem roots");
  const pinned = new Map();
  for (const root of roots) {
    const canonicalPath = fs.realpathSync(String(root));
    if (pinned.has(canonicalPath)) continue;
    const stat = fs.lstatSync(canonicalPath, { bigint: true });
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new TypeError("Authorized filesystem roots must be directories");
    }
    pinned.set(canonicalPath, Object.freeze({
      canonicalPath,
      identity: identity(stat),
    }));
  }
  return Object.freeze([...pinned.values()]);
}

function identity(stat) {
  const mtimeNs = stat.mtimeNs ?? BigInt(Math.trunc(Number(stat.mtimeMs) * 1e6));
  const ctimeNs = stat.ctimeNs ?? BigInt(Math.trunc(Number(stat.ctimeMs) * 1e6));
  return Object.freeze({
    device: String(stat.dev),
    inode: String(stat.ino),
    mode: String(stat.mode),
    size: Number(stat.size),
    mtimeNs: String(mtimeNs),
    ctimeNs: String(ctimeNs),
  });
}

function sameIdentity(left, right) {
  return left.device === right.device
    && left.inode === right.inode
    && left.mode === right.mode
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

function sameFilesystemObject(left, right) {
  return left.device === right.device
    && left.inode === right.inode
    && left.mode === right.mode;
}

module.exports = {
  assertNotAborted,
  canonicalRoots,
  identity,
  importError,
  sameFilesystemObject,
  sameIdentity,
};
