#!/usr/bin/env node
// Entry point: node scripts/dev-self-challenge/run.mjs
// Cron: 0 * * * * cd /path/to/project && node scripts/dev-self-challenge/run.mjs

import { execSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import module from "node:module";

const require = module.createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---- Constants ----
const DRY_RUN = process.env.CHALLENGE_DRY_RUN === "1";
const DATA_DIR =
  process.env.CHALLENGE_DATA_DIR ||
  path.resolve(__dirname, "..", "..", ".lily-work", "challenges");
const PROJECT_ROOT = path.resolve(__dirname, "..", "..");

const config = { challengeDataDir: () => DATA_DIR };

// ---- Lazy-require CJS modules ----
const { ChallengeStore } = require("./lib/challenge-store.js");
const { CapabilityTracker } = require("./lib/capability-tracker.js");
const { ChallengeGenerator } = require("./lib/challenge-generator.js");
const { ChallengeExecutor } = require("./lib/challenge-executor.js");
const { ChallengeEvaluator } = require("./lib/challenge-evaluator.js");

// ---- Main ----
async function main() {
  console.log(`[challenge] start | dry=${DRY_RUN} | dir=${DATA_DIR}`);

  // 1. Init modules
  const store = new ChallengeStore(config);
  const tracker = new CapabilityTracker(config, store);
  const generator = new ChallengeGenerator(config, store, tracker);
  const executor = new ChallengeExecutor();
  const evaluator = new ChallengeEvaluator();

  // 2. Check lock — exit if another run is in progress
  if (store.isLocked()) {
    console.log("[challenge] locked — another run in progress, exiting");
    return;
  }

  // 3. Get git diff
  let diff = "";
  try {
    diff = execSync("git diff HEAD~1 --diff-filter=AM", {
      cwd: PROJECT_ROOT,
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
    });
  } catch {
    // HEAD~1 may not exist (e.g. first commit) — proceed with empty diff
    diff = "";
  }

  // 4. Generate challenge
  const challenge = generator.generate({ diff });

  // 5. No challenge needed
  if (!challenge) {
    console.log("[challenge] no challenge needed — exiting");
    return;
  }

  console.log(
    `[challenge] generated | type=${challenge.type} dimension=${challenge.dimension}`,
  );

  // 6. Acquire lock
  if (!store.acquireLock()) {
    console.log("[challenge] could not acquire lock — exiting");
    return;
  }

  let lockHeld = true;
  const releaseLock = () => {
    if (lockHeld) {
      store.releaseLock();
      lockHeld = false;
    }
  };

  try {
    // 7. Execute challenge
    const execStart = Date.now();
    let execResult;

    if (DRY_RUN) {
      // Fake success result for dry-run mode
      execResult = {
        ok: true,
        output: "[dry-run] simulated execution output",
        errorOutput: "",
        durationMs: Date.now() - execStart,
      };
    } else if (!executor.hasEngine()) {
      // No real engine available — skip execution gracefully
      console.log("[challenge] skip: engine not available (install lily-workbench CLI)");
      store.releaseLock();
      return;
    } else {
      execResult = await executor.execute({
        prompt: challenge.prompt,
        cwd: PROJECT_ROOT,
      });
    }

    const durationMs = execResult.durationMs || Date.now() - execStart;

    if (!execResult.ok) {
      console.log(
        `[challenge] execution failed | duration=${durationMs}ms error=${execResult.error}`,
      );

      // Save failure record
      store.appendHistory({
        type: challenge.type,
        dimension: challenge.dimension,
        prompt: challenge.prompt,
        result: "fail",
        score: 0,
        filesChanged: challenge.changedFiles || [],
        issues: [{ severity: "critical", description: execResult.error || "Execution failed" }],
        suggestions: [],
        durationMs,
      });

      // Update dimension (score 0, fail)
      tracker.updateDimension(challenge.dimension, { score: 0, verdict: "fail" });

      releaseLock();
      console.log("[challenge] failure recorded — exiting");
      return;
    }

    console.log(
      `[challenge] execution completed | duration=${durationMs}ms output=${execResult.output.length}chars`,
    );

    // 8. Evaluate result
    let evalResult;

    if (DRY_RUN) {
      // Fake eval result for dry-run mode
      evalResult = {
        ok: true,
        verdict: "pass",
        totalScore: 7,
        scores: {
          completeness: 1,
          correctness: 2,
          style: 2,
          scope: 1,
          robustness: 1,
        },
        issues: [],
        suggestions: [
          {
            type: "test",
            description: `Consider adding tests for files: ${(challenge.changedFiles || []).join(", ") || "none"}`,
          },
        ],
      };
    } else {
      evalResult = await evaluator.evaluate({
        task: challenge.prompt,
        output: execResult.output,
        changedFiles: challenge.changedFiles,
        cwd: PROJECT_ROOT,
      });
    }

    console.log(
      `[challenge] evaluated | verdict=${evalResult.verdict} score=${evalResult.totalScore}`,
    );

    // 9. Save to store and tracker
    store.appendHistory({
      type: challenge.type,
      dimension: challenge.dimension,
      prompt: challenge.prompt,
      result: evalResult.verdict,
      score: evalResult.totalScore,
      filesChanged: challenge.changedFiles || [],
      issues: evalResult.issues || [],
      suggestions: evalResult.suggestions || [],
      durationMs,
    });

    tracker.updateDimension(challenge.dimension, {
      score: evalResult.totalScore,
      verdict: evalResult.verdict,
    });

    // 10. Print suggestions
    const suggestions = evalResult.suggestions || [];
    if (suggestions.length > 0) {
      console.log("[challenge] suggestions:");
      for (const s of suggestions) {
        console.log(`  - [${s.type || "info"}] ${s.description}`);
      }
    }

    console.log("[challenge] complete");
  } finally {
    releaseLock();
  }
}

main().catch((err) => {
  console.error("[challenge] error:", err.message);
  process.exit(1);
});
