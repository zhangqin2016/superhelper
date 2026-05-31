#!/usr/bin/env node
/**
 * Remove macOS archive metadata before packaging (Windows + Mac + all ship dirs).
 *
 * Usage:
 *   node scripts/purge-macos-junk.mjs              # purge default ship dirs
 *   node scripts/purge-macos-junk.mjs --check      # exit 1 if junk found (no delete)
 *   node scripts/purge-macos-junk.mjs --verify dist/win-unpacked
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  SHIP_PURGE_DEFAULT_REL_PATHS,
  findJunkUnder,
  purgeJunkUnder,
} = require("../src/main/ship-ignore.js");

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function defaultTargets() {
  return SHIP_PURGE_DEFAULT_REL_PATHS.map((rel) => path.join(ROOT, rel)).filter((p) =>
    fs.existsSync(p),
  );
}

function parseArgs() {
  const args = process.argv.slice(2);
  const checkOnly = args.includes("--check");
  const verifyIdx = args.indexOf("--verify");
  const verifyPath =
    verifyIdx >= 0 && args[verifyIdx + 1]
      ? path.resolve(args[verifyIdx + 1])
      : null;
  const paths = args.filter(
    (a, i) => a !== "--check" && a !== "--verify" && (verifyIdx < 0 || i !== verifyIdx + 1),
  );
  return {
    checkOnly,
    verifyPath,
    targets: paths.length ? paths.map((p) => path.resolve(p)) : defaultTargets(),
  };
}

function main() {
  const { checkOnly, verifyPath, targets } = parseArgs();

  if (verifyPath) {
    const { dirs, files } = findJunkUnder(verifyPath);
    if (dirs.length || files.length) {
      console.error("[purge-macos-junk] forbidden metadata in packaged output:");
      for (const d of dirs) console.error(`  dir  ${path.relative(ROOT, d) || d}`);
      for (const f of files.slice(0, 20)) {
        console.error(`  file ${path.relative(ROOT, f) || f}`);
      }
      if (files.length > 20) console.error(`  ... and ${files.length - 20} more files`);
      process.exit(1);
    }
    console.log(`[purge-macos-junk] verify ok — no macOS junk in ${verifyPath}`);
    return;
  }

  let totalDirs = 0;
  let totalFiles = 0;
  const found = [];

  for (const target of targets) {
    const { dirs, files } = findJunkUnder(target);
    if (dirs.length || files.length) {
      found.push({ target, dirs, files });
    }
    if (checkOnly) continue;
    const removed = purgeJunkUnder(target);
    totalDirs += removed.dirs;
    totalFiles += removed.files;
  }

  if (checkOnly) {
    if (found.length === 0) {
      console.log("[purge-macos-junk] check ok — no macOS junk in ship dirs");
      return;
    }
    console.error("[purge-macos-junk] macOS junk found (run without --check to purge):");
    for (const { target, dirs, files } of found) {
      console.error(
        `  ${path.relative(ROOT, target) || target}: ${dirs.length} dirs, ${files.length} files`,
      );
    }
    process.exit(1);
  }

  if (totalDirs || totalFiles) {
    console.log(
      `[purge-macos-junk] removed ${totalDirs} dir(s), ${totalFiles} file(s) from ship dirs`,
    );
  } else {
    console.log("[purge-macos-junk] nothing to remove");
  }
}

main();
