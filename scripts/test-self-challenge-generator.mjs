#!/usr/bin/env node

import module from "node:module";
import fs from "node:fs";

const require = module.createRequire(import.meta.url);

const { ChallengeGenerator, CAPABILITY_PROMPTS } = require("./dev-self-challenge/lib/challenge-generator.js");
const { ChallengeStore } = require("./dev-self-challenge/lib/challenge-store.js");
const { CapabilityTracker } = require("./dev-self-challenge/lib/capability-tracker.js");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const SAMPLE_DIFF = `diff --git a/src/turn-orchestrator.js b/src/turn-orchestrator.js
index abc..def 100644
--- a/src/turn-orchestrator.js
+++ b/src/turn-orchestrator.js
@@ -1,5 +1,7 @@
-const a = 1;
+const a = 2;
 console.log(a);
+console.log("new line");

diff --git a/src/session-manager.js b/src/session-manager.js
index abc..def 100644
--- a/src/session-manager.js
+++ b/src/session-manager.js
@@ -1,5 +1,7 @@
 function manage() {
+  return true;
 }
`;

let exitCode = 0;
const tmpDirs = [];

try {
  // ==================== Diff-driven challenge ====================

  // --- Diff-driven challenge when diff has changes ---
  {
    const tmpDir = fs.mkdtempSync("/tmp/challenge-gen-test-");
    tmpDirs.push(tmpDir);
    const config = { challengeDataDir: () => tmpDir };
    const store = new ChallengeStore(config);
    const tracker = new CapabilityTracker(config, store);
    const generator = new ChallengeGenerator(config, store, tracker);

    const result = generator.generate({ diff: SAMPLE_DIFF });

    assert(result !== null, "should generate a challenge when diff has changes");
    assert(result.type === "diff-driven", `type should be diff-driven, got ${JSON.stringify(result.type)}`);
    assert(typeof result.prompt === "string" && result.prompt.length > 0, "prompt should be a non-empty string");
    assert(result.prompt.includes("turn-orchestrator"), "prompt should mention turn-orchestrator");
    assert(result.prompt.includes("session-manager"), "prompt should mention session-manager");
    assert(result.dimension === "cross-module", `dimension should be cross-module, got ${JSON.stringify(result.dimension)}`);
    assert(Array.isArray(result.changedFiles), "changedFiles should be an array");
    assert(result.changedFiles.includes("src/turn-orchestrator.js"), "changedFiles should include src/turn-orchestrator.js");
    assert(result.changedFiles.includes("src/session-manager.js"), "changedFiles should include src/session-manager.js");
    console.log("diff-driven challenge: ok");
  }

  // ==================== Dimension mapping ====================

  // --- agent-session → error-handling ---
  {
    const tmpDir = fs.mkdtempSync("/tmp/challenge-gen-test-");
    tmpDirs.push(tmpDir);
    const config = { challengeDataDir: () => tmpDir };
    const store = new ChallengeStore(config);
    const tracker = new CapabilityTracker(config, store);
    const generator = new ChallengeGenerator(config, store, tracker);

    const diff = `diff --git a/src/agent-session.js b/src/agent-session.js
index a..b 100644
--- a/src/agent-session.js
+++ b/src/agent-session.js
@@ -1 +1,2 @@
 old
+new`;
    const result = generator.generate({ diff });
    assert(result.dimension === "error-handling", `agent-session should map to error-handling, got ${JSON.stringify(result.dimension)}`);
    console.log("dimension mapping agent-session → error-handling: ok");
  }

  // --- turn-orchestrator → cross-module ---
  {
    const tmpDir = fs.mkdtempSync("/tmp/challenge-gen-test-");
    tmpDirs.push(tmpDir);
    const config = { challengeDataDir: () => tmpDir };
    const store = new ChallengeStore(config);
    const tracker = new CapabilityTracker(config, store);
    const generator = new ChallengeGenerator(config, store, tracker);

    const diff = `diff --git a/src/turn-orchestrator.js b/src/turn-orchestrator.js
index a..b 100644
--- a/src/turn-orchestrator.js
+++ b/src/turn-orchestrator.js
@@ -1 +1,2 @@
 old
+new`;
    const result = generator.generate({ diff });
    assert(result.dimension === "cross-module", `turn-orchestrator should map to cross-module, got ${JSON.stringify(result.dimension)}`);
    console.log("dimension mapping turn-orchestrator → cross-module: ok");
  }

  // --- scheduled-tasks → cross-module ---
  {
    const tmpDir = fs.mkdtempSync("/tmp/challenge-gen-test-");
    tmpDirs.push(tmpDir);
    const config = { challengeDataDir: () => tmpDir };
    const store = new ChallengeStore(config);
    const tracker = new CapabilityTracker(config, store);
    const generator = new ChallengeGenerator(config, store, tracker);

    const diff = `diff --git a/src/scheduled-tasks.js b/src/scheduled-tasks.js
index a..b 100644
--- a/src/scheduled-tasks.js
+++ b/src/scheduled-tasks.js
@@ -1 +1,2 @@
 old
+new`;
    const result = generator.generate({ diff });
    assert(result.dimension === "cross-module", `scheduled-tasks should map to cross-module, got ${JSON.stringify(result.dimension)}`);
    console.log("dimension mapping scheduled-tasks → cross-module: ok");
  }

  // --- session-manager → refactoring ---
  {
    const tmpDir = fs.mkdtempSync("/tmp/challenge-gen-test-");
    tmpDirs.push(tmpDir);
    const config = { challengeDataDir: () => tmpDir };
    const store = new ChallengeStore(config);
    const tracker = new CapabilityTracker(config, store);
    const generator = new ChallengeGenerator(config, store, tracker);

    const diff = `diff --git a/src/session-manager.js b/src/session-manager.js
index a..b 100644
--- a/src/session-manager.js
+++ b/src/session-manager.js
@@ -1 +1,2 @@
 old
+new`;
    const result = generator.generate({ diff });
    assert(result.dimension === "refactoring", `session-manager should map to refactoring, got ${JSON.stringify(result.dimension)}`);
    console.log("dimension mapping session-manager → refactoring: ok");
  }

  // --- default (unknown module) → code-analysis ---
  {
    const tmpDir = fs.mkdtempSync("/tmp/challenge-gen-test-");
    tmpDirs.push(tmpDir);
    const config = { challengeDataDir: () => tmpDir };
    const store = new ChallengeStore(config);
    const tracker = new CapabilityTracker(config, store);
    const generator = new ChallengeGenerator(config, store, tracker);

    const diff = `diff --git a/src/unknown-module.js b/src/unknown-module.js
index a..b 100644
--- a/src/unknown-module.js
+++ b/src/unknown-module.js
@@ -1 +1,2 @@
 old
+new`;
    const result = generator.generate({ diff });
    assert(result.dimension === "code-analysis", `default should map to code-analysis, got ${JSON.stringify(result.dimension)}`);
    console.log("dimension mapping default → code-analysis: ok");
  }

  // ==================== Capability-driven challenge ====================

  // --- Capability-driven when no diff and 3+ rounds without diff ---
  {
    const tmpDir = fs.mkdtempSync("/tmp/challenge-gen-test-");
    tmpDirs.push(tmpDir);
    const config = { challengeDataDir: () => tmpDir };
    const store = new ChallengeStore(config);
    const tracker = new CapabilityTracker(config, store);
    const generator = new ChallengeGenerator(config, store, tracker);

    store.appendHistory({ type: "code_review", prompt: "a", result: "pass", score: 5 });
    store.appendHistory({ type: "code_review", prompt: "b", result: "pass", score: 5 });
    store.appendHistory({ type: "code_review", prompt: "c", result: "pass", score: 5 });

    const result = generator.generate({ lastChallengeAt: Date.now() - 10 * 60 * 1000 });

    assert(result !== null, "should generate a capability-driven challenge");
    assert(result.type === "capability-driven", `type should be capability-driven, got ${JSON.stringify(result.type)}`);
    assert(typeof result.prompt === "string" && result.prompt.length > 0, "prompt should be a non-empty string");
    assert(result.prompt === CAPABILITY_PROMPTS[result.dimension], "prompt should match the dimension's CAPABILITY_PROMPTS entry");
    assert(Array.isArray(result.changedFiles), "changedFiles should be an array");
    assert(result.changedFiles.length === 0, "capability-driven should have empty changedFiles");
    console.log("capability-driven challenge: ok");
  }

  // --- Weakest dimension is selected ---
  {
    const tmpDir = fs.mkdtempSync("/tmp/challenge-gen-test-");
    tmpDirs.push(tmpDir);
    const config = { challengeDataDir: () => tmpDir };
    const store = new ChallengeStore(config);
    const tracker = new CapabilityTracker(config, store);
    const generator = new ChallengeGenerator(config, store, tracker);

    tracker.updateDimension("code-analysis", { score: 3, verdict: "pass" });
    tracker.updateDimension("refactoring", { score: 8, verdict: "pass" });

    store.appendHistory({ type: "code_review", prompt: "a", result: "pass", score: 5 });
    store.appendHistory({ type: "code_review", prompt: "b", result: "pass", score: 5 });
    store.appendHistory({ type: "code_review", prompt: "c", result: "pass", score: 5 });

    const result = generator.generate({ lastChallengeAt: Date.now() - 10 * 60 * 1000 });

    assert(result.dimension === "code-analysis", `weakest dimension should be code-analysis (score 3), got ${JSON.stringify(result.dimension)}`);
    console.log("weakest dimension selection: ok");
  }

  // --- Paused dimension is skipped ---
  {
    const tmpDir = fs.mkdtempSync("/tmp/challenge-gen-test-");
    tmpDirs.push(tmpDir);
    const config = { challengeDataDir: () => tmpDir };
    const store = new ChallengeStore(config);
    const tracker = new CapabilityTracker(config, store);
    const generator = new ChallengeGenerator(config, store, tracker);

    // 2 consecutive fails → paused
    tracker.updateDimension("code-analysis", { score: 1, verdict: "fail" });
    tracker.updateDimension("code-analysis", { score: 1, verdict: "fail" });
    // Lower another dimension that is NOT paused
    tracker.updateDimension("refactoring", { score: 3, verdict: "pass" });

    store.appendHistory({ type: "code_review", prompt: "a", result: "pass", score: 5 });
    store.appendHistory({ type: "code_review", prompt: "b", result: "pass", score: 5 });
    store.appendHistory({ type: "code_review", prompt: "c", result: "pass", score: 5 });

    const result = generator.generate({ lastChallengeAt: Date.now() - 10 * 60 * 1000 });

    assert(result.dimension !== "code-analysis", "should skip paused dimension");
    assert(result.dimension === "refactoring", `should pick weakest non-paused dimension (refactoring with score 3), got ${JSON.stringify(result.dimension)}`);
    console.log("paused dimension skipped: ok");
  }

  // ==================== Cooldown ====================

  // --- Cooldown prevents generation when last challenge was <5 min ago ---
  {
    const tmpDir = fs.mkdtempSync("/tmp/challenge-gen-test-");
    tmpDirs.push(tmpDir);
    const config = { challengeDataDir: () => tmpDir };
    const store = new ChallengeStore(config);
    const tracker = new CapabilityTracker(config, store);
    const generator = new ChallengeGenerator(config, store, tracker);

    const result = generator.generate({
      diff: SAMPLE_DIFF,
      lastChallengeAt: Date.now() - 60 * 1000, // 1 minute ago (within 5-min cooldown)
    });

    assert(result === null, "cooldown should prevent generation when last challenge is within 5 minutes");
    console.log("cooldown check: ok");
  }

  // ==================== Nothing to do ====================

  // --- Null return when no diff and not enough rounds ---
  {
    const tmpDir = fs.mkdtempSync("/tmp/challenge-gen-test-");
    tmpDirs.push(tmpDir);
    const config = { challengeDataDir: () => tmpDir };
    const store = new ChallengeStore(config);
    const tracker = new CapabilityTracker(config, store);
    const generator = new ChallengeGenerator(config, store, tracker);

    // No diff, no history → should return null
    const result = generator.generate({
      lastChallengeAt: Date.now() - 10 * 60 * 1000,
    });

    assert(result === null, "should return null when no diff and not enough rounds without diff");
    console.log("null return when nothing to do: ok");
  }

  console.log("\nAll tests passed!");
} catch (err) {
  console.error("TEST FAILED:", err.message);
  exitCode = 1;
} finally {
  for (const dir of tmpDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  }
}

process.exit(exitCode);
