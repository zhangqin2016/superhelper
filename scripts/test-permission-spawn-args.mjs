#!/usr/bin/env node
import module from "node:module";

const require = module.createRequire(import.meta.url);
const {
  ALLOW_BYPASS_FLAG,
  appendPermissionSpawnArgs,
} = require("../src/main/permission-spawn-args.js");

function assertSpawnArgs(permissionMode, expectedMode) {
  const args = [];
  appendPermissionSpawnArgs(args, permissionMode);
  const expected = ["--permission-mode", expectedMode, ALLOW_BYPASS_FLAG];
  if (args.length !== expected.length || !args.every((v, i) => v === expected[i])) {
    throw new Error(
      `appendPermissionSpawnArgs(${JSON.stringify(permissionMode)}) => ${JSON.stringify(args)}, expected ${JSON.stringify(expected)}`,
    );
  }
}

assertSpawnArgs("bypassPermissions", "bypassPermissions");
assertSpawnArgs("auto", "auto");
assertSpawnArgs(undefined, "default");

// Native CLI modes pass through unchanged.
assertSpawnArgs("acceptEdits", "acceptEdits");
assertSpawnArgs("plan", "plan");

// Regression: "dontAsk" is an app-internal mode the approval broker enforces; it
// is NOT a CLI --permission-mode choice. Passing it raw made the CLI reject the
// arg and exit at startup, which broke every unattended scheduled run. It must
// be mapped to a valid CLI mode (the broker still receives the real "dontAsk").
assertSpawnArgs("dontAsk", "default");
// Any other unknown/app-only value also fails closed to a valid CLI mode.
assertSpawnArgs("someFutureAppMode", "default");

console.log("permission-spawn-args: ok");
