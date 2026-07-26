"use strict";

const exportPlanner = require("./workspace-export-planner");

const MAX_IMPORT_FILES = (exportPlanner.MAX_TOTAL_FILES * 2) + 100;
const MAX_IMPORT_TOTAL_BYTES = 2 * 1024 * 1024 * 1024;

function assertImportArchiveLimits(zip, options = {}) {
  const maxFiles = Math.max(1, Number(options.maxFiles || MAX_IMPORT_FILES));
  const maxFileBytes = Math.max(
    1,
    Number(options.maxFileBytes || exportPlanner.MAX_FILE_BYTES),
  );
  const maxTotalBytes = Math.max(
    1,
    Number(options.maxTotalBytes || MAX_IMPORT_TOTAL_BYTES),
  );
  const entries = Object.values(zip.files).filter((entry) => !entry.dir);
  if (entries.length > maxFiles) throw new Error("PACK_TOO_MANY_FILES");
  let totalBytes = 0;
  for (const entry of entries) {
    const size = Number(entry?._data?.uncompressedSize || 0);
    if (!Number.isFinite(size) || size < 0) throw new Error("PACK_SIZE_INVALID");
    if (size > maxFileBytes) throw new Error("PACK_FILE_TOO_LARGE");
    totalBytes += size;
    if (totalBytes > maxTotalBytes) throw new Error("PACK_UNCOMPRESSED_TOO_LARGE");
  }
}

module.exports = {
  assertImportArchiveLimits,
  MAX_IMPORT_FILES,
  MAX_IMPORT_TOTAL_BYTES,
};
