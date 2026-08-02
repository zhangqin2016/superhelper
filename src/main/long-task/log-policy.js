"use strict";

const fs = require("node:fs");

const DEFAULT_MAX_LOG_BYTES = 32 * 1024 * 1024;
const DEFAULT_RETAIN_LOG_BYTES = 4 * 1024 * 1024;

function boundedPositive(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}

function enforceLogQuota(file, options = {}) {
  const maxBytes = boundedPositive(options.maxBytes, DEFAULT_MAX_LOG_BYTES);
  const retainBytes = Math.min(maxBytes, boundedPositive(options.retainBytes, DEFAULT_RETAIN_LOG_BYTES));
  let stat;
  try { stat = fs.statSync(file); } catch { return { rotated: false, byteSize: 0 }; }
  if (stat.size <= maxBytes) return { rotated: false, byteSize: stat.size };
  const start = Math.max(0, stat.size - retainBytes);
  const fd = fs.openSync(file, "r+");
  try {
    const buffer = Buffer.alloc(stat.size - start);
    fs.readSync(fd, buffer, 0, buffer.length, start);
    fs.writeSync(fd, buffer, 0, buffer.length, 0);
    fs.ftruncateSync(fd, buffer.length);
    fs.fsyncSync(fd);
    return { rotated: true, byteSize: buffer.length, droppedBytes: start };
  } finally {
    fs.closeSync(fd);
  }
}

function enforceGlobalLogQuota(dir, options = {}) {
  const maxBytes = boundedPositive(options.maxBytes, 512 * 1024 * 1024);
  const retainBytes = boundedPositive(options.retainBytes, 64 * 1024);
  let files;
  try {
    files = fs.readdirSync(dir)
      .filter((name) => /\.(?:stdout|stderr)\.log$/.test(name))
      .map((name) => {
        const file = require("node:path").join(dir, name);
        const stat = fs.statSync(file);
        return { file, size: stat.size, mtimeMs: stat.mtimeMs };
      })
      .sort((a, b) => a.mtimeMs - b.mtimeMs);
  } catch {
    return { byteSize: 0, trimmedFiles: 0 };
  }
  let byteSize = files.reduce((sum, item) => sum + item.size, 0);
  let trimmedFiles = 0;
  for (const item of files) {
    if (byteSize <= maxBytes) break;
    const result = enforceLogQuota(item.file, { maxBytes: Math.max(retainBytes, item.size - 1), retainBytes });
    if (result.rotated) {
      byteSize -= item.size - result.byteSize;
      trimmedFiles += 1;
    }
  }
  return { byteSize, trimmedFiles };
}

module.exports = { DEFAULT_MAX_LOG_BYTES, DEFAULT_RETAIN_LOG_BYTES, enforceGlobalLogQuota, enforceLogQuota };
