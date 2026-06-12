"use strict";

const path = require("node:path");

const CHALLENGE_FRESH_WINDOW_MS = 60 * 60 * 1000; // 1 hour

/**
 * Parse git diff output into a list of changed files with their change type.
 *
 * @param {string} diffOutput - Raw git diff output.
 * @returns {Array<{path: string, type: "M"|"A"}>}
 */
function parseChangedFiles(diffOutput) {
  if (!diffOutput || diffOutput.trim() === "") {
    return [];
  }

  const files = [];
  const lines = diffOutput.split("\n");
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Detect file header: diff --git a/path b/path
    if (line.startsWith("diff --git ")) {
      // Extract path from "diff --git a/<path> b/<path>"
      const match = line.match(/^diff --git a\/(.+) b\/\1$/);
      if (!match) {
        i++;
        continue;
      }

      const filePath = match[1];

      // Skip dot-prefixed files (like .gitignore)
      const basename = path.basename(filePath);
      if (basename.startsWith(".")) {
        i++;
        continue;
      }

      // Determine change type by looking ahead for "new file mode" or "deleted file mode"
      let type = "M"; // default: modified
      let lookAhead = i + 1;
      while (lookAhead < lines.length && lookAhead < i + 5) {
        const nextLine = lines[lookAhead].trim();
        if (nextLine.startsWith("new file mode")) {
          type = "A";
          break;
        }
        // Stop looking if we hit the next diff header
        if (nextLine.startsWith("diff --git ")) {
          break;
        }
        // Stop at hunk header or --- line
        if (nextLine.startsWith("@@") || nextLine.startsWith("---")) {
          break;
        }
        lookAhead++;
      }

      files.push({ path: filePath, type });
    }

    i++;
  }

  return files;
}

/**
 * Analyze git diff output for challenge generation.
 *
 * @param {string} diffOutput - Raw git diff output.
 * @returns {{ changedFiles: Array<{path: string, type: "M"|"A"}>, modules: Set<string>, hasChanges: boolean }}
 */
function analyzeDiff(diffOutput) {
  const changedFiles = parseChangedFiles(diffOutput);
  const modules = new Set();

  for (const file of changedFiles) {
    const basename = path.basename(file.path, path.extname(file.path));
    modules.add(basename);
  }

  return {
    changedFiles,
    modules,
    hasChanges: changedFiles.length > 0,
  };
}

/**
 * Check if the diff has changes that haven't been challenged recently.
 *
 * @param {string} diffOutput - Raw git diff output.
 * @param {Array<{type: string, changedFiles: Array<string>, timestamp: string}>} [recentChallenges=[]]
 * @returns {boolean} - True if there are unchallenged changes.
 */
function hasUnchallengedChanges(diffOutput, recentChallenges = []) {
  const analysis = analyzeDiff(diffOutput);

  if (!analysis.hasChanges) {
    return false;
  }

  const changedPaths = new Set(analysis.changedFiles.map((f) => f.path));

  // Collect all recently challenged files from diff-driven challenges (within 1 hour)
  const now = Date.now();
  const challengedFiles = new Set();

  for (const challenge of recentChallenges) {
    if (challenge.type !== "diff-driven") {
      continue;
    }
    const challengeTime = new Date(challenge.timestamp).getTime();
    if (now - challengeTime > CHALLENGE_FRESH_WINDOW_MS) {
      continue;
    }
    for (const challengedPath of challenge.changedFiles || []) {
      challengedFiles.add(challengedPath);
    }
  }

  // Check if any current changed file hasn't been challenged recently
  for (const changedPath of changedPaths) {
    if (!challengedFiles.has(changedPath)) {
      return true;
    }
  }

  return false;
}

module.exports = { analyzeDiff, hasUnchallengedChanges, parseChangedFiles };
