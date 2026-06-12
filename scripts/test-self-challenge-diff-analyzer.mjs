#!/usr/bin/env node

import module from "node:module";

const require = module.createRequire(import.meta.url);

const { analyzeDiff, hasUnchallengedChanges, parseChangedFiles } = require("./dev-self-challenge/lib/diff-analyzer.js");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const SAMPLE_DIFF = `diff --git a/src/foo.js b/src/foo.js
index abc..def 100644
--- a/src/foo.js
+++ b/src/foo.js
@@ -1,5 +1,7 @@
-const a = 1;
+const a = 2;
 console.log(a);
+console.log("new line");

diff --git a/src/bar.ts b/src/bar.ts
new file mode 100644
index 000..123 000000
--- /dev/null
+++ b/src/bar.ts
@@ -0,0 +1,3 @@
+const x = 10;
+console.log(x);
+export default x;

diff --git a/.gitignore b/.gitignore
index 111..222 100644
--- a/.gitignore
+++ b/.gitignore
@@ -1 +1,2 @@
 node_modules/
+dist/
`;

const DOTFILE_DIFF = `diff --git a/.gitignore b/.gitignore
index 111..222 100644
--- a/.gitignore
+++ b/.gitignore
@@ -1 +1,2 @@
 node_modules/
+dist/
`;

const MODIFIED_ONLY_DIFF = `diff --git a/src/utils.js b/src/utils.js
index 123..456 100644
--- a/src/utils.js
+++ b/src/utils.js
@@ -1,3 +1,4 @@
 function add(a, b) {
+  if (typeof a !== "number") throw new Error("invalid");
   return a + b;
 }
`;

const ADDED_ONLY_DIFF = `diff --git a/src/new-module.js b/src/new-module.js
new file mode 100644
index 000..789 000000
--- /dev/null
+++ b/src/new-module.js
@@ -0,0 +1,5 @@
+export function hello() {
+  return "world";
+}
`;

let exitCode = 0;

try {
  // ==================== parseChangedFiles ====================

  // --- Empty diff ---
  {
    const result = parseChangedFiles("");
    assert(Array.isArray(result), "parseChangedFiles should return an array");
    assert(result.length === 0, "empty diff should return empty array");
    console.log("parseChangedFiles empty diff: ok");
  }

  // --- Modified files detected ---
  {
    const files = parseChangedFiles(MODIFIED_ONLY_DIFF);
    assert(files.length === 1, `should find 1 changed file, got ${files.length}`);
    assert(files[0].path === "src/utils.js", `file path should be src/utils.js, got ${files[0].path}`);
    assert(files[0].type === "M", `modified file should have type M, got ${files[0].type}`);
    console.log("parseChangedFiles modified: ok");
  }

  // --- Added files detected ---
  {
    const files = parseChangedFiles(ADDED_ONLY_DIFF);
    assert(files.length === 1, `should find 1 added file, got ${files.length}`);
    assert(files[0].path === "src/new-module.js", `file path should be src/new-module.js, got ${files[0].path}`);
    assert(files[0].type === "A", `added file should have type A, got ${files[0].type}`);
    console.log("parseChangedFiles added: ok");
  }

  // --- Mixed modified and added files ---
  {
    const files = parseChangedFiles(SAMPLE_DIFF);
    // src/foo.js (M), src/bar.ts (A), .gitignore (M)
    // But .gitignore is dot-prefixed so it should be skipped
    assert(files.length === 2, `sample diff should return 2 non-dot-prefixed files, got ${files.length}`);
    console.log("parseChangedFiles mixed: ok");
  }

  // ==================== analyzeDiff ====================

  // --- Empty diff ---
  {
    const result = analyzeDiff("");
    assert(Array.isArray(result.changedFiles), "changedFiles should be an array");
    assert(result.changedFiles.length === 0, "empty diff should have no changed files");
    assert(result.modules instanceof Set, "modules should be a Set");
    assert(result.modules.size === 0, "empty diff should have no modules");
    assert(result.hasChanges === false, "empty diff should have hasChanges false");
    console.log("analyzeDiff empty diff: ok");
  }

  // --- Sample diff with mixed changes ---
  {
    const result = analyzeDiff(SAMPLE_DIFF);
    assert(result.hasChanges === true, "sample diff should have changes");
    assert(result.changedFiles.length === 2, `sample diff should have 2 non-dotfile changes, got ${result.changedFiles.length}`);
    // Check specific files
    const fooEntry = result.changedFiles.find((f) => f.path === "src/foo.js");
    assert(fooEntry, "should include src/foo.js");
    assert(fooEntry.type === "M", "src/foo.js should be modified");

    const barEntry = result.changedFiles.find((f) => f.path === "src/bar.ts");
    assert(barEntry, "should include src/bar.ts");
    assert(barEntry.type === "A", "src/bar.ts should be added");

    // Ensure dotfile is excluded
    const gitignoreEntry = result.changedFiles.find((f) => f.path === ".gitignore");
    assert(!gitignoreEntry, "dot-prefixed files should be excluded");

    // Check module names (basename without extension)
    assert(result.modules.has("foo"), "modules should include foo");
    assert(result.modules.has("bar"), "modules should include bar");
    assert(!result.modules.has("gitignore"), "should not include gitignore module");
    assert(result.modules.size === 2, `should have exactly 2 modules, got ${result.modules.size}`);
    console.log("analyzeDiff sample diff: ok");
  }

  // --- Dotfile-only diff ---
  {
    const result = analyzeDiff(DOTFILE_DIFF);
    assert(result.hasChanges === false, "dotfile-only diff should have hasChanges false");
    assert(result.changedFiles.length === 0, "dotfile-only diff should have no changed files");
    assert(result.modules.size === 0, "dotfile-only diff should have no modules");
    console.log("analyzeDiff dotfile-only: ok");
  }

  // ---------- Module name extraction ----------
  {
    const diff = `diff --git a/src/sub/dir/tool.tsx b/src/sub/dir/tool.tsx
index a..b 100644
--- a/src/sub/dir/tool.tsx
+++ b/src/sub/dir/tool.tsx
@@ -1 +1,2 @@
 old
+new`;
    const result = analyzeDiff(diff);
    assert(result.modules.has("tool"), "module name should be basename without extension");
    assert(result.modules.size === 1, "should extract 1 module from deep path");
    console.log("module name extraction: ok");
  }

  // ==================== hasUnchallengedChanges ====================

  // --- No diff changes ---
  {
    const result = hasUnchallengedChanges("", []);
    assert(result === false, "no diff changes should return false");
    console.log("hasUnchallengedChanges no changes: ok");
  }

  // --- Diff has changes, no challenges ---
  {
    const result = hasUnchallengedChanges(MODIFIED_ONLY_DIFF, []);
    assert(result === true, "changes with no challenges should return true");
    console.log("hasUnchallengedChanges no challenges: ok");
  }

  // --- Diff has changes, all files recently challenged ---
  {
    const now = new Date();
    const recentChallenges = [
      {
        type: "diff-driven",
        changedFiles: ["src/utils.js"],
        timestamp: now.toISOString(),
      },
    ];
    const result = hasUnchallengedChanges(MODIFIED_ONLY_DIFF, recentChallenges);
    assert(result === false, "all files recently challenged should return false");
    console.log("hasUnchallengedChanges all challenged: ok");
  }

  // --- Diff has changes, some files not yet challenged ---
  {
    const now = new Date();
    const recentChallenges = [
      {
        type: "diff-driven",
        changedFiles: ["src/unrelated.js"],
        timestamp: now.toISOString(),
      },
    ];
    const result = hasUnchallengedChanges(MODIFIED_ONLY_DIFF, recentChallenges);
    assert(result === true, "unchallenged files should return true");
    console.log("hasUnchallengedChanges some unchallenged: ok");
  }

  // --- Non-diff-driven challenges should be ignored ---
  {
    const now = new Date();
    const challenges = [
      {
        type: "code_review",
        changedFiles: ["src/utils.js"],
        timestamp: now.toISOString(),
      },
    ];
    const result = hasUnchallengedChanges(MODIFIED_ONLY_DIFF, challenges);
    assert(result === true, "non-diff-driven challenges should be ignored");
    console.log("hasUnchallengedChanges ignores non-diff-driven: ok");
  }

  // --- Stale challenges (older than 1 hour) should be ignored ---
  {
    const oldTimestamp = new Date(Date.now() - 61 * 60 * 1000).toISOString();
    const challenges = [
      {
        type: "diff-driven",
        changedFiles: ["src/utils.js"],
        timestamp: oldTimestamp,
      },
    ];
    const result = hasUnchallengedChanges(MODIFIED_ONLY_DIFF, challenges);
    assert(result === true, "stale challenges (>1h) should be ignored");
    console.log("hasUnchallengedChanges stale challenges: ok");
  }

  console.log("\nAll tests passed!");
} catch (err) {
  console.error("TEST FAILED:", err.message);
  exitCode = 1;
}

process.exit(exitCode);
