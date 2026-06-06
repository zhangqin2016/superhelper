#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import module from "node:module";

const require = module.createRequire(import.meta.url);
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "lily-session-memory-"));
const electronPath = require.resolve("electron");

require.cache[electronPath] = {
  id: electronPath,
  filename: electronPath,
  loaded: true,
  exports: {
    app: {
      getPath: () => tempRoot,
    },
  },
};

const {
  clearSessionSummary,
  formatSessionSummary,
  readSessionSummary,
  updateSessionSummaryFromRecord,
} = require("../src/main/session-memory.js");

try {
  updateSessionSummaryFromRecord("s1", {
    terminal: "turn.completed",
    user: { text: "帮我重写前三章" },
    assistantText: "已经完成第一章。",
    fileChanges: [{ fileName: "第1章.md" }],
  });

  let summary = readSessionSummary("s1");
  if (summary.lastUserIntent !== "帮我重写前三章" || summary.pendingTask) {
    throw new Error(`completed turn summary incorrect: ${JSON.stringify(summary)}`);
  }
  if (!formatSessionSummary(summary).includes("第1章.md")) {
    throw new Error("formatted summary should include recent files");
  }

  updateSessionSummaryFromRecord("s1", {
    terminal: "turn.stalled",
    user: { text: "继续第二章" },
    assistantText: "正在继续。",
    fileChanges: [],
  });
  summary = readSessionSummary("s1");
  if (summary.pendingTask !== "继续第二章") {
    throw new Error(`stalled turn should record pending task: ${JSON.stringify(summary)}`);
  }

  clearSessionSummary("s1");
  if (readSessionSummary("s1")) {
    throw new Error("clearSessionSummary should remove summary file");
  }

  console.log("session-memory: ok");
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}
