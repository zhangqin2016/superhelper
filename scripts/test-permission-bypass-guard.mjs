#!/usr/bin/env node
/**
 * Full-autonomy guard: a session must never SILENTLY resolve to "full" (the
 * allow-everything mode). Mode resolution is the only gate between a session and
 * full access, so it must reach "full" exclusively through an explicit, valid,
 * user-initiated write — injected/partial/uppercase strings fall back to the safe
 * "ask" default. (A prior explicit legacy "bypassPermissions" choice is migrated
 * to "full" on purpose; partial look-alikes are not.)
 */
import module from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { assert } from "./lib/test-assert.mjs";

const require = module.createRequire(import.meta.url);
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "lily-bypass-guard-"));

const electronPath = require.resolve("electron");
require.cache[electronPath] = {
  id: electronPath,
  filename: electronPath,
  loaded: true,
  exports: {
    app: { getPath: () => tempRoot },
  },
};

const {
  resolveSessionPermissionMode,
  getActivePermissionMode,
  setActivePermissionMode,
} = require("../src/main/permission-settings.js");

try {
  // 1. fresh install, fresh session -> safe default, not full
  assert(getActivePermissionMode() === "ask", "global default is ask");
  assert(resolveSessionPermissionMode({}) === "ask", "fresh session resolves to ask");
  assert(resolveSessionPermissionMode(null) === "ask", "missing session resolves to ask");

  // 2. invalid/injected session mode strings never resolve to a privileged mode
  for (const evil of ["FULL", "full ", "bypassPermissions ", "bypass", "root", "*"]) {
    const mode = resolveSessionPermissionMode({ permissionModeId: evil });
    assert(mode === "ask", `invalid session mode "${evil}" falls back to safe default, got ${mode}`);
  }

  // 3. corrupted global settings on disk cannot smuggle in a bogus mode
  fs.writeFileSync(
    path.join(tempRoot, "permission-settings.json"),
    JSON.stringify({ activeModeId: "full; rm -rf /" }),
  );
  assert(setActivePermissionMode("not-a-mode").ok === false, "invalid global mode write rejected");

  // 4. full autonomy is reachable ONLY through an explicit valid write…
  const explicit = setActivePermissionMode("full");
  assert(explicit.ok === true, "explicit full write accepted");
  assert(resolveSessionPermissionMode({}) === "full", "session inherits explicit full");

  // …and an explicit write back out restores the safe path
  assert(setActivePermissionMode("ask").ok === true, "explicit downgrade accepted");
  assert(resolveSessionPermissionMode({}) === "ask", "session follows downgrade");

  // 5. per-session explicit full works with the exact id; a legacy bypass id migrates to it
  assert(
    resolveSessionPermissionMode({ permissionModeId: "full" }) === "full",
    "exact per-session full id resolves",
  );
  assert(
    resolveSessionPermissionMode({ permissionModeId: "bypassPermissions" }) === "full",
    "legacy bypassPermissions migrates to full",
  );

  console.log("PASS: test-permission-bypass-guard (15 tests)");
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}
