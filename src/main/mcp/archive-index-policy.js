"use strict";

const { isArchiveFilePath } = require("./archive-intelligence");

const DEFAULT_MAX_ARCHIVES = 20;
const DEFAULT_ARCHIVE_INSPECTION_MS = 30_000;

function createArchiveIndexInspector(input = {}, inspectPath) {
  const maxArchives = Math.max(
    1,
    Math.min(Number(input.maxArchives || DEFAULT_MAX_ARCHIVES), 100),
  );
  const budgetMs = Math.max(
    1000,
    Math.min(Number(input.maxArchiveInspectionMs || DEFAULT_ARCHIVE_INSPECTION_MS), 5 * 60_000),
  );
  const deadline = Date.now() + budgetMs;
  let archivesInspected = 0;

  return (filePath) => {
    if (!isArchiveFilePath(filePath)) {
      return { info: inspectPath({ path: filePath }) };
    }
    if (archivesInspected >= maxArchives || Date.now() >= deadline) {
      return { skippedReason: "archive inspection limit reached" };
    }
    archivesInspected += 1;
    return {
      info: inspectPath(
        { path: filePath },
        { archiveTimeoutMs: Math.max(1000, deadline - Date.now()) },
      ),
    };
  };
}

module.exports = {
  createArchiveIndexInspector,
};
