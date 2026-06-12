#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import module from "node:module";

const require = module.createRequire(import.meta.url);

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "lily-capability-"));

// These will fail initially since capability-tracker.js doesn't exist yet
const { ChallengeStore } = require("./dev-self-challenge/lib/challenge-store.js");
const { CapabilityTracker } = require("./dev-self-challenge/lib/capability-tracker.js");

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

let exitCode = 0;

try {
  // ==================== Default dimensions ====================

  // --- Default dimensions exist (>= 4) ---
  {
    const config = makeConfig(freshDir("defaults"));
    const store = new ChallengeStore(config);
    const tracker = new CapabilityTracker(config, store);
    const dims = tracker.listDimensions();
    assert(Array.isArray(dims), "listDimensions should return an array");
    assert(dims.length >= 4, `should have at least 4 dimensions, got ${dims.length}`);
    console.log(`default dimensions: ok (${dims.length} dimensions)`);
  }

  // --- Default score is 5 ---
  {
    const config = makeConfig(freshDir("default-score"));
    const store = new ChallengeStore(config);
    const tracker = new CapabilityTracker(config, store);
    const dims = tracker.listDimensions();
    dims.forEach((d) => {
      assert(d.score === 5, `default score should be 5 for ${d.key}, got ${d.score}`);
    });
    console.log("default score is 5: ok");
  }

  // --- getDimension returns null for unknown key ---
  {
    const config = makeConfig(freshDir("unknown-key"));
    const store = new ChallengeStore(config);
    const tracker = new CapabilityTracker(config, store);
    const dim = tracker.getDimension("nonexistent");
    assert(dim === null, "getDimension for unknown key should return null");
    console.log("getDimension unknown key: ok");
  }

  // ==================== updateDimension ====================

  // --- updateDimension changes score ---
  {
    const dir = freshDir("update-score");
    const config = makeConfig(dir);
    const store = new ChallengeStore(config);
    const tracker = new CapabilityTracker(config, store);
    const updated = tracker.updateDimension("code-analysis", { score: 8, verdict: "pass" });
    assert(updated.score === 8, `score should be updated to 8, got ${updated.score}`);
    assert(updated.key === "code-analysis", "should return dimension with key field");

    const dim = tracker.getDimension("code-analysis");
    assert(dim.score === 8, `getDimension should see updated score, got ${dim.score}`);
    console.log("updateDimension changes score: ok");
  }

  // --- Trend tracking (up/down) ---
  {
    const dir = freshDir("trend");
    const config = makeConfig(dir);
    const store = new ChallengeStore(config);
    const tracker = new CapabilityTracker(config, store);

    // Initial trend should be "stable"
    let dim = tracker.getDimension("test-generation");
    assert(dim.trend === "stable", `initial trend should be stable, got ${dim.trend}`);

    // Score up (5 -> 7) => trend "up"
    tracker.updateDimension("test-generation", { score: 7, verdict: "pass" });
    dim = tracker.getDimension("test-generation");
    assert(dim.trend === "up", `trend should be up after score increase, got ${dim.trend}`);

    // Score down (7 -> 3) => trend "down"
    tracker.updateDimension("test-generation", { score: 3, verdict: "fail" });
    dim = tracker.getDimension("test-generation");
    assert(dim.trend === "down", `trend should be down after score decrease, got ${dim.trend}`);

    // Score unchanged (3 -> 3) => keep existing or "stable"
    tracker.updateDimension("test-generation", { score: 3, verdict: "pass" });
    dim = tracker.getDimension("test-generation");
    assert(dim.trend === "stable" || dim.trend === "down",
      `trend should be stable or keep previous when unchanged, got ${dim.trend}`);

    console.log("trend tracking: ok");
  }

  // --- Consecutive fail counting ---
  {
    const dir = freshDir("consecutive-fails");
    const config = makeConfig(dir);
    const store = new ChallengeStore(config);
    const tracker = new CapabilityTracker(config, store);

    tracker.updateDimension("error-handling", { score: 4, verdict: "fail" });
    let dim = tracker.getDimension("error-handling");
    assert(dim.consecutiveFails === 1, `should be 1 after 1 fail, got ${dim.consecutiveFails}`);

    tracker.updateDimension("error-handling", { score: 3, verdict: "fail" });
    dim = tracker.getDimension("error-handling");
    assert(dim.consecutiveFails === 2, `should be 2 after 2 fails, got ${dim.consecutiveFails}`);

    // Pass resets to 0
    tracker.updateDimension("error-handling", { score: 5, verdict: "pass" });
    dim = tracker.getDimension("error-handling");
    assert(dim.consecutiveFails === 0, `should be 0 after pass, got ${dim.consecutiveFails}`);

    console.log("consecutive fail counting: ok");
  }

  // --- Paused after 2 consecutive fails ---
  {
    const dir = freshDir("paused");
    const config = makeConfig(dir);
    const store = new ChallengeStore(config);
    const tracker = new CapabilityTracker(config, store);

    // One fail => not paused
    tracker.updateDimension("multi-locale", { score: 4, verdict: "fail" });
    let dim = tracker.getDimension("multi-locale");
    assert(!dim.paused, `should not be paused after 1 fail`);

    // Two fails => paused
    tracker.updateDimension("multi-locale", { score: 3, verdict: "fail" });
    dim = tracker.getDimension("multi-locale");
    assert(dim.paused === true, `should be paused after 2 consecutive fails`);

    // Pass resets paused
    tracker.updateDimension("multi-locale", { score: 5, verdict: "pass" });
    dim = tracker.getDimension("multi-locale");
    assert(dim.consecutiveFails === 0, "consecutiveFails should reset after pass");
    assert(!dim.paused, "should not be paused after pass");

    console.log("paused after 2 consecutive fails: ok");
  }

  // ==================== getWeakestDimension ====================

  // --- getWeakestDimension picks lowest score ---
  {
    const dir = freshDir("weakest");
    const config = makeConfig(dir);
    const store = new ChallengeStore(config);
    const tracker = new CapabilityTracker(config, store);

    tracker.updateDimension("code-analysis", { score: 2, verdict: "pass" });
    tracker.updateDimension("refactoring", { score: 8, verdict: "pass" });

    const weakest = tracker.getWeakestDimension();
    assert(weakest !== null, "should return a dimension");
    assert(weakest.key === "code-analysis",
      `weakest should be code-analysis (score 2), got ${weakest.key} (${weakest.score})`);
    console.log("getWeakestDimension picks lowest: ok");
  }

  // --- getWeakestDimension skips paused when others available ---
  {
    const dir = freshDir("weakest-skip-paused");
    const config = makeConfig(dir);
    const store = new ChallengeStore(config);
    const tracker = new CapabilityTracker(config, store);

    // Make code-analysis paused (2 consecutive fails)
    tracker.updateDimension("code-analysis", { score: 2, verdict: "fail" });
    tracker.updateDimension("code-analysis", { score: 2, verdict: "fail" });

    // Set refactoring to a low but non-paused score
    tracker.updateDimension("refactoring", { score: 3, verdict: "pass" });

    const weakest = tracker.getWeakestDimension();
    assert(weakest !== null, "should return a non-paused dimension");
    assert(weakest.key === "refactoring",
      `weakest should be refactoring (score 3), got ${weakest.key} (${weakest.score})`);
    console.log("getWeakestDimension skips paused: ok");
  }

  // --- getWeakestDimension returns null when all paused ---
  {
    const dir = freshDir("all-paused");
    const config = makeConfig(dir);
    const store = new ChallengeStore(config);
    const tracker = new CapabilityTracker(config, store);

    const dims = tracker.listDimensions();
    for (const d of dims) {
      tracker.updateDimension(d.key, { score: 1, verdict: "fail" });
      tracker.updateDimension(d.key, { score: 1, verdict: "fail" });
    }

    const weakest = tracker.getWeakestDimension();
    assert(weakest === null, "should return null when all dimensions are paused");
    console.log("getWeakestDimension null when all paused: ok");
  }

  // ==================== Persistence ====================

  // --- Persistence across instances ---
  {
    const dir = freshDir("persistence");
    const config = makeConfig(dir);

    const store1 = new ChallengeStore(config);
    const tracker1 = new CapabilityTracker(config, store1);
    tracker1.updateDimension("cross-module", { score: 9, verdict: "pass" });

    const store2 = new ChallengeStore(config);
    const tracker2 = new CapabilityTracker(config, store2);
    const dim = tracker2.getDimension("cross-module");
    assert(dim !== null, "should persist cross-module dimension");
    assert(dim.score === 9, `persisted score should be 9, got ${dim.score}`);
    assert(dim.trend === "up", `persisted trend should be up, got ${dim.trend}`);

    console.log("persistence across instances: ok");
  }

  // ==================== Score clamping ====================

  // --- Score clamping (0-10) ---
  {
    const dir = freshDir("clamping");
    const config = makeConfig(dir);
    const store = new ChallengeStore(config);
    const tracker = new CapabilityTracker(config, store);

    const below = tracker.updateDimension("refactoring", { score: -5, verdict: "pass" });
    assert(below.score === 0, `negative score should clamp to 0, got ${below.score}`);

    const above = tracker.updateDimension("refactoring", { score: 15, verdict: "pass" });
    assert(above.score === 10, `score above 10 should clamp to 10, got ${above.score}`);

    console.log("score clamping (0-10): ok");
  }

  console.log("\nAll tests passed!");
} catch (err) {
  console.error("TEST FAILED:", err.message);
  exitCode = 1;
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}

process.exit(exitCode);
