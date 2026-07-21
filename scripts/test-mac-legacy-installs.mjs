#!/usr/bin/env node
// macOS legacy-install detection: stale renamed-product bundles are found in
// both Applications dirs, the RUNNING app's bundle is always excluded, and
// the signature is stable for nag-once semantics.

import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  LEGACY_MAC_BUNDLE_NAMES,
  detectLegacyMacInstalls,
  legacyMacSignature,
} = require("../src/main/mac-legacy-installs.js");

const dirs = {
  "/Applications": ["Lily Workbench.app", "智能工作台.app", "Safari.app"],
  "/Users/alice/Applications": ["AI Super Terminal.app", "WeChat.app"],
};
const listDir = (dir) => {
  if (!(dir in dirs)) throw new Error("ENOENT");
  return dirs[dir];
};

// 1. Finds both legacy bundles, ignores unrelated apps.
{
  const found = detectLegacyMacInstalls({
    listDir,
    currentBundlePath: "/Applications/Lily Workbench.app",
    applicationsDirs: ["/Applications", "/Users/alice/Applications"],
  });
  assert.equal(found.length, 2);
  assert(found.some((f) => f.bundlePath === "/Applications/智能工作台.app"));
  assert(found.some((f) => f.bundlePath === "/Users/alice/Applications/AI Super Terminal.app"));
  assert(found.every((f) => f.displayName && !f.displayName.endsWith(".app")));
}

// 2. The running app's own bundle is excluded even if it matches a legacy name
//    (user renamed Lily Workbench.app back, or dev runs from a legacy-named bundle).
{
  const found = detectLegacyMacInstalls({
    listDir,
    currentBundlePath: "/Applications/智能工作台.app",
    applicationsDirs: ["/Applications", "/Users/alice/Applications"],
  });
  assert.equal(found.length, 1);
  assert.equal(found[0].bundlePath, "/Users/alice/Applications/AI Super Terminal.app");
}

// 3. Missing dirs and empty scans are fine.
{
  const found = detectLegacyMacInstalls({
    listDir,
    currentBundlePath: "",
    applicationsDirs: ["/nonexistent", "/Applications"],
  });
  assert.equal(found.length, 1);
}

// 4. Signature is order-stable and dedup-safe.
{
  const a = legacyMacSignature([{ bundlePath: "/B.app" }, { bundlePath: "/A.app" }]);
  const b = legacyMacSignature([{ bundlePath: "/A.app" }, { bundlePath: "/B.app" }]);
  assert.equal(a, b);
}

// 5. Only known legacy names match — a lookalike directory is not a finding.
{
  assert(LEGACY_MAC_BUNDLE_NAMES.every((name) => name.endsWith(".app")));
  const found = detectLegacyMacInstalls({
    listDir: () => ["智能工作台", "智能工作台备份.app", "lily-workbench.app"],
    currentBundlePath: "",
    applicationsDirs: ["/Applications"],
  });
  assert.equal(found.length, 0);
}

console.log("mac-legacy-installs: ok");
