#!/usr/bin/env node
// Guarantees what the customer downloads is CLEAN: the clean-archive helper must
// strip macOS Finder/AppleDouble junk and reject wrong-platform native binaries
// before any pack is uploaded to the CDN.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { createCleanTarball, assertCleanArchive, purgeMacJunk } from "./lib/clean-archive.mjs";

const work = fs.mkdtempSync("/tmp/clean-archive-test-");
const stage = `${work}/stage`;
fs.mkdirSync(`${stage}/sub`, { recursive: true });
fs.writeFileSync(`${stage}/sub/mod.py`, "x = 1\n");
fs.writeFileSync(`${stage}/sub/win.pyd`, "MZ");
// Seed the exact junk a macOS build would leave: Finder file, AppleDouble, xattr.
fs.writeFileSync(`${stage}/.DS_Store`, "finder");
fs.writeFileSync(`${stage}/sub/._mod.py`, "appledouble");
try {
  execFileSync("xattr", ["-w", "com.apple.quarantine", "1", `${stage}/sub/mod.py`], { stdio: "ignore" });
} catch {
  /* xattr may be absent off macOS — the test still validates on-disk purge */
}

// A Windows pack built from a dirty macOS stage must come out clean + verified.
const winTar = `${work}/pack-win32-x64.tar.gz`;
createCleanTarball(stage, winTar, { platform: "win32-x64" });
const listing = execFileSync("tar", ["-tzf", winTar], { encoding: "utf8" });
assert.doesNotMatch(listing, /(^|\/)\._/m, "no AppleDouble ._* in the archive");
assert.doesNotMatch(listing, /\.DS_Store/, "no .DS_Store in the archive");
assert.doesNotMatch(listing, /__MACOSX/, "no __MACOSX in the archive");
assert.match(listing, /sub\/mod\.py/, "real content survives");

// A darwin binary must NOT be shippable inside a Windows pack.
fs.writeFileSync(`${stage}/sub/libfoo.dylib`, "macho");
assert.throws(
  () => createCleanTarball(stage, `${work}/dirty-win.tar.gz`, { platform: "win32-x64" }),
  /darwin binaries/,
  "a Windows pack containing a .dylib must be rejected",
);

// The same dylib is legitimate inside a darwin pack.
createCleanTarball(stage, `${work}/pack-darwin-arm64.tar.gz`, { platform: "darwin-arm64" });

// assertCleanArchive must independently flag a hand-made dirty archive.
const dirtyDir = `${work}/dirty`;
fs.mkdirSync(dirtyDir, { recursive: true });
fs.writeFileSync(`${dirtyDir}/.DS_Store`, "x");
fs.writeFileSync(`${dirtyDir}/ok.txt`, "y");
const dirtyTar = `${work}/hand-dirty.tar.gz`;
// Build WITHOUT the cleaner (COPYFILE disabled off) so .DS_Store is retained.
execFileSync("tar", ["-czf", dirtyTar, "-C", dirtyDir, "."]);
assert.throws(() => assertCleanArchive(dirtyTar, { platform: "win32-x64" }), /macOS junk/, "dirty archive is caught");

// purgeMacJunk removes on-disk junk and is idempotent / non-throwing.
purgeMacJunk(dirtyDir);
assert.ok(!fs.existsSync(`${dirtyDir}/.DS_Store`), "purge removes .DS_Store");
purgeMacJunk(dirtyDir);

fs.rmSync(work, { recursive: true, force: true });
console.log("clean-archive: ok");
