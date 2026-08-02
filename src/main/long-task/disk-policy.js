"use strict";

const fs = require("node:fs");

const DEFAULT_MIN_FREE_BYTES = 256 * 1024 * 1024;

function ensureLaunchDiskSpace(targetPath, options = {}) {
  const statfs = options.statfsSync || fs.statfsSync;
  if (typeof statfs !== "function") return { ok: true, availableBytes: null };
  try {
    const stats = statfs(targetPath);
    const availableBytes = Number(stats.bavail || 0) * Number(stats.bsize || 0);
    const minFreeBytes = Math.max(1, Number(options.minFreeBytes) || DEFAULT_MIN_FREE_BYTES);
    return availableBytes >= minFreeBytes
      ? { ok: true, availableBytes }
      : { ok: false, error: "INSUFFICIENT_DISK_SPACE", availableBytes, minFreeBytes };
  } catch {
    return { ok: true, availableBytes: null };
  }
}

module.exports = { DEFAULT_MIN_FREE_BYTES, ensureLaunchDiskSpace };
