#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import module from "node:module";

const require = module.createRequire(import.meta.url);

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "lily-challenge-store-"));

const { ChallengeStore } = require("./dev-self-challenge/lib/challenge-store.js");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function makeConfig(dir) {
  return {
    challengeDataDir: () => dir,
  };
}

function freshDir(name) {
  return fs.mkdtempSync(path.join(tempRoot, `${name}-`));
}

try {
  // --- Empty state ---
  {
    const store = new ChallengeStore(makeConfig(freshDir("empty")));
    const history = store.listHistory();
    assert(Array.isArray(history), "listHistory should return an array");
    assert(history.length === 0, "empty store should have no history entries");
    console.log("empty state: ok");
  }

  // --- Append and list history ---
  {
    const store = new ChallengeStore(makeConfig(freshDir("append")));
    const entry = store.appendHistory({
      type: "code_review",
      prompt: "找出代码中的安全问题",
      result: "发现 3 个安全问题",
      score: 85,
      filesChanged: ["src/auth.js", "src/api.js"],
      issues: ["SQL注入风险", "XSS漏洞"],
      suggestions: [
        "使用参数化查询替代字符串拼接",
        "对用户输入进行转义",
      ],
      durationMs: 45000,
    });
    assert(entry.id, "entry should have an id");
    assert(entry.id.startsWith("ch_"), "entry id should start with ch_");
    assert(entry.timestamp, "entry should have a timestamp");
    assert(entry.type === "code_review", "entry type should match");
    assert(entry.score === 85, "entry score should match");
    assert(Array.isArray(entry.filesChanged), "filesChanged should be an array");
    assert(entry.filesChanged.length === 2, "filesChanged should have 2 items");
    assert(Array.isArray(entry.issues), "issues should be an array");
    assert(entry.issues.length === 2, "issues should have 2 items");
    assert(entry.suggestions.length === 2, "suggestions should have 2 items");
    assert(entry.durationMs === 45000, "durationMs should match");

    const history = store.listHistory();
    assert(history.length === 1, "history should have 1 entry");
    assert(history[0].id === entry.id, "history entry id should match");
    console.log("append and list history: ok");
  }

  // --- Get by id ---
  {
    const store = new ChallengeStore(makeConfig(freshDir("getbyid")));
    const entry = store.appendHistory({
      type: "refactor",
      prompt: "重构用户模块",
      result: "完成重构",
    });
    const found = store.getHistory(entry.id);
    assert(found !== null, "getHistory should return the entry");
    assert(found.id === entry.id, "getHistory should return the correct entry");
    assert(found.type === "refactor", "getHistory entry type should match");
    assert(found.prompt === "重构用户模块", "getHistory entry prompt should match");

    const notFound = store.getHistory("ch_nonexistent");
    assert(notFound === null, "getHistory should return null for unknown id");

    const noFile = store.getHistory("ch_nonexistent_no_file");
    assert(noFile === null, "getHistory should return null when history file does not exist");
    console.log("get by id: ok");
  }

  // --- Limit parameter ---
  {
    const store = new ChallengeStore(makeConfig(freshDir("limit")));
    // Append 5 entries
    for (let i = 0; i < 5; i++) {
      store.appendHistory({
        type: "test",
        prompt: `Entry ${i}`,
        result: "done",
      });
    }
    const all = store.listHistory();
    assert(all.length === 5, "should have 5 entries");
    const limited = store.listHistory({ limit: 2 });
    assert(limited.length === 2, "limited list should return 2 entries");
    // Most recent first — so should be last 2 appended
    assert(limited[0].prompt === "Entry 4", `limited should return most recent first, got ${limited[0].prompt}`);
    assert(limited[1].prompt === "Entry 3", `limited second entry should be Entry 3, got ${limited[1].prompt}`);

    const maxed = store.listHistory({ limit: 999 });
    assert(maxed.length === 5, "listHistory should cap at 500 limit implicitly, but return all entries when fewer exist");
    console.log("limit parameter: ok");
  }

  // --- Lock acquire/release ---
  {
    const store = new ChallengeStore(makeConfig(freshDir("lock")));
    assert(!store.isLocked(), "store should not be locked initially");

    const acquired = store.acquireLock();
    assert(acquired, "acquireLock should return true on fresh lock");
    assert(store.isLocked(), "store should report locked after acquire");

    const secondAttempt = store.acquireLock();
    assert(!secondAttempt, "acquireLock should return false when already locked");

    store.releaseLock();
    assert(!store.isLocked(), "store should not be locked after release");

    // Double release should not crash
    store.releaseLock();
    console.log("lock acquire/release: ok");
  }

  // --- Stale lock acquisition ---
  {
    const staleDir = freshDir("stale-lock");
    const store = new ChallengeStore(makeConfig(staleDir));
    // Manually create a lock file with a timestamp older than 30 minutes
    const lockFile = path.join(staleDir, "lock");
    const oldTimestamp = new Date(Date.now() - 31 * 60 * 1000).toISOString();
    fs.writeFileSync(lockFile, oldTimestamp, "utf8");
    assert(store.isLocked(), "stale lock file should still make isLocked report true");

    const acquired = store.acquireLock();
    assert(acquired, "should acquire lock when existing lock is stale");
    assert(store.isLocked(), "store should report locked after acquiring stale lock");

    store.releaseLock();
    assert(!store.isLocked(), "store should unlock after release");
    console.log("stale lock acquisition: ok");
  }

  // --- History file max 500 entries ---
  {
    const store = new ChallengeStore(makeConfig(freshDir("max500")));
    // Append 501 entries
    for (let i = 0; i < 501; i++) {
      store.appendHistory({
        type: "test",
        prompt: `Bulk entry ${i}`,
        result: "done",
      });
    }
    const history = store.listHistory({ limit: 500 });
    assert(history.length <= 500, `history should be capped at 500 entries, got ${history.length}`);
    assert(history.length === 500, `history should have exactly 500 entries after 501 appends`);
    assert(history[0].prompt === "Bulk entry 500", `most recent should be last appended`);
    assert(history[history.length - 1].prompt === "Bulk entry 1", `oldest should be the 401st appended (index 1)`);
    console.log("history max 500 entries: ok");
  }

  // --- Concurrent lock enforcement ---
  {
    const concurrentDir = freshDir("concurrent");
    const storeA = new ChallengeStore(makeConfig(concurrentDir));
    const storeB = new ChallengeStore(makeConfig(concurrentDir));
    storeA.releaseLock(); // clean slate
    assert(storeA.acquireLock(), "storeA should acquire lock");
    assert(!storeB.acquireLock(), "storeB should not acquire lock when storeA holds it");
    storeA.releaseLock();
    assert(storeB.acquireLock(), "storeB should acquire lock after storeA releases");
    storeB.releaseLock();
    console.log("concurrent lock enforcement: ok");
  }

  // --- listHistory returns entries sorted most-recent-first ---
  {
    const store = new ChallengeStore(makeConfig(freshDir("sort")));
    store.appendHistory({ type: "test", prompt: "First", result: "done" });
    store.appendHistory({ type: "test", prompt: "Second", result: "done" });
    store.appendHistory({ type: "test", prompt: "Third", result: "done" });
    const history = store.listHistory();
    assert(history.length === 3, "should have 3 entries");
    assert(history[0].prompt === "Third", "most recent entry should be first");
    assert(history[1].prompt === "Second", "second entry should be Second");
    assert(history[2].prompt === "First", "oldest entry should be last");
    console.log("listHistory sort order: ok");
  }

  console.log("\nAll tests passed!");
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}
