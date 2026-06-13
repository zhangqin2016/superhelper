#!/usr/bin/env node
/**
 * Bypass-mode guard: a default session must never SILENTLY resolve to
 * "bypassPermissions". The CLI is spawned with the bypass capability flag for
 * hot-switching (see permission-spawn-args.js), so the ONLY thing standing
 * between a session and full access is mode resolution — it must reach bypass
 * exclusively through an explicit, valid, user-initiated mode write.
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
  // 1. fresh install, fresh session -> global default, not bypass
  assert(getActivePermissionMode() === "auto", "global default is auto");
  assert(resolveSessionPermissionMode({}) === "auto", "fresh session resolves to auto");
  assert(resolveSessionPermissionMode(null) === "auto", "missing session resolves to auto");

  // 2. invalid/injected session mode strings never resolve to a privileged mode
  for (const evil of ["BYPASSPERMISSIONS", "bypassPermissions ", "bypass", "root", "*"]) {
    const mode = resolveSessionPermissionMode({ permissionModeId: evil });
    assert(mode === "auto", `invalid session mode "${evil}" falls back to global, got ${mode}`);
  }

  // 3. corrupted global settings on disk cannot smuggle in a bogus mode
  fs.writeFileSync(
    path.join(tempRoot, "permission-settings.json"),
    JSON.stringify({ activeModeId: "bypassPermissions; rm -rf /" }),
  );
  assert(setActivePermissionMode("not-a-mode").ok === false, "invalid global mode write rejected");

  // 4. bypass is reachable ONLY through an explicit valid write…
  const explicit = setActivePermissionMode("bypassPermissions");
  assert(explicit.ok === true, "explicit bypass write accepted");
  assert(resolveSessionPermissionMode({}) === "bypassPermissions", "session inherits explicit bypass");

  // …and an explicit write back out restores the default path
  assert(setActivePermissionMode("auto").ok === true, "explicit downgrade accepted");
  assert(resolveSessionPermissionMode({}) === "auto", "session follows downgrade");

  // 5. per-session explicit bypass works, but only with the exact valid id
  assert(
    resolveSessionPermissionMode({ permissionModeId: "bypassPermissions" }) === "bypassPermissions",
    "exact per-session bypass id resolves",
  );

  console.log("PASS: test-permission-bypass-guard (14 tests)");
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}
