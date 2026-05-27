"use strict";

/**
 * Runs git diff in the project directory to extract CLI-made changes.
 */

const { spawn } = require("node:child_process");

const MAX_DIFF_SIZE = 500 * 1024;

class DiffRunner {
  /**
   * Get the working tree diff for a project directory.
   * @param {string} cwd Project root path
   * @returns {Promise<{diffs: Array<{file: string, status: string, hunks: string}>, summary: {added: number, deleted: number, files: number}}>}
   */
  getDiff(cwd) {
    return new Promise((resolve) => {
      const child = spawn("git", [
        "-C", cwd,
        "diff", "--stat", "-p",
        "--diff-filter=AM",
      ], {
        stdio: ["ignore", "pipe", "pipe"],
      });

      let stdout = "";
      let stderr = "";

      child.stdout.on("data", (chunk) => {
        stdout += chunk.toString();
        if (stdout.length > MAX_DIFF_SIZE) {
          child.kill();
        }
      });

      child.stderr.on("data", (chunk) => {
        stderr += chunk.toString();
      });

      child.on("close", (code) => {
        if (code !== 0 && code !== null && !stdout.trim()) {
          resolve({ diffs: [], summary: { added: 0, deleted: 0, files: 0 } });
          return;
        }
        resolve(this._parseDiff(stdout));
      });

      child.on("error", () => {
        resolve({ diffs: [], summary: { added: 0, deleted: 0, files: 0 } });
      });
    });
  }

  /**
   * Accept changes for specific files (stage them).
   * @param {string} cwd
   * @param {string[]} filePaths
   */
  acceptFiles(cwd, filePaths) {
    return new Promise((resolve) => {
      if (filePaths.length === 0) {
        resolve({ ok: true });
        return;
      }
      const child = spawn("git", ["-C", cwd, "add", "--", ...filePaths], {
        stdio: "ignore",
      });
      child.on("close", (code) => {
        resolve({ ok: code === 0 });
      });
      child.on("error", () => resolve({ ok: false }));
    });
  }

  /**
   * Revert changes for specific files.
   * @param {string} cwd
   * @param {string[]} filePaths
   */
  rejectFiles(cwd, filePaths) {
    return new Promise((resolve) => {
      if (filePaths.length === 0) {
        resolve({ ok: true });
        return;
      }
      const child = spawn("git", ["-C", cwd, "checkout", "--", ...filePaths], {
        stdio: "ignore",
      });
      child.on("close", (code) => {
        resolve({ ok: code === 0 });
      });
      child.on("error", () => resolve({ ok: false }));
    });
  }

  _parseDiff(raw) {
    const diffs = [];
    const files = raw.split(/^diff --git /m).filter(Boolean);

    for (const fileDiff of files) {
      const headerMatch = fileDiff.match(/^a\/(.*?) b\/(.*?)$/m);
      if (!headerMatch) continue;
      const file = headerMatch[2];

      const statMatch = fileDiff.match(/^@@ (.*?) @@/m);
      let status = "modified";
      if (fileDiff.includes("new file mode")) status = "added";
      else if (fileDiff.includes("deleted file mode")) status = "deleted";

      diffs.push({
        file,
        status,
        hunks: "diff --git " + fileDiff,
      });
    }

    // Build summary
    let added = 0;
    let deleted = 0;
    const addRe = /^\+(?!\+\+)/gm;
    const delRe = /^-(?!--)/gm;
    for (const d of diffs) {
      const adds = (d.hunks.match(addRe) || []).length;
      const dels = (d.hunks.match(delRe) || []).length;
      added += adds;
      deleted += dels;
    }

    return {
      diffs,
      summary: { added, deleted, files: diffs.length },
    };
  }
}

module.exports = DiffRunner;
