// Guarantee the artifacts customers download are CLEAN — no macOS Finder /
// AppleDouble junk (._*, .DS_Store, __MACOSX) and no wrong-platform native
// binaries — regardless of which host built them. macOS `tar` embeds AppleDouble
// (._*) entries from a file's extended attributes at archive time, so a pack
// built on a Mac ships that junk to the client unless we strip xattrs and
// disable AppleDouble. This module centralizes that so every publisher is clean.

import { execFileSync } from "node:child_process";

const MAC_JUNK_RE = /(^|\/)(\._[^/]+|\.DS_Store|__MACOSX)(\/|$)/;

// Strip extended attributes and delete any on-disk Finder junk from a staging
// dir before it is archived. Best-effort: never throws.
export function purgeMacJunk(dir) {
  if (process.platform === "darwin") {
    try {
      execFileSync("xattr", ["-rc", dir], { stdio: "ignore" });
    } catch {
      /* best effort — xattr may be absent in CI */
    }
  }
  try {
    execFileSync(
      "find",
      [dir, "(", "-name", "._*", "-o", "-name", ".DS_Store", "-o", "-name", "__MACOSX", ")", "-exec", "rm", "-rf", "{}", "+"],
      { stdio: "ignore" },
    );
  } catch {
    /* best effort */
  }
}

// Fail if a finished archive still carries macOS junk, or (for a non-darwin
// target) a darwin binary — i.e. the download would NOT be clean.
export function assertCleanArchive(outFile, { platform } = {}) {
  const listing = execFileSync("tar", ["-tzf", outFile], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const lines = listing.split("\n").filter(Boolean);
  const junk = lines.filter((l) => MAC_JUNK_RE.test(l));
  if (junk.length) {
    throw new Error(
      `archive ${outFile} contains macOS junk (${junk.length}): ${junk.slice(0, 5).join(", ")}`,
    );
  }
  if (platform && !platform.startsWith("darwin")) {
    const darwinBins = lines.filter((l) => /\.dylib(\.|$)/.test(l) || /-darwin-/.test(l));
    if (darwinBins.length) {
      throw new Error(
        `archive ${outFile} targets ${platform} but contains darwin binaries (${darwinBins.length}): ${darwinBins.slice(0, 5).join(", ")}`,
      );
    }
  }
  return lines.length;
}

// Purge → gzip-tar the dir CONTENTS flat (-C dir .) with AppleDouble disabled →
// verify the result is clean. Drop-in replacement for a raw `tar -czf`.
export function createCleanTarball(dir, outFile, { platform } = {}) {
  purgeMacJunk(dir);
  execFileSync("tar", ["-czf", outFile, "-C", dir, "."], {
    stdio: "inherit",
    env: { ...process.env, COPYFILE_DISABLE: "1" },
  });
  assertCleanArchive(outFile, { platform });
  return outFile;
}
