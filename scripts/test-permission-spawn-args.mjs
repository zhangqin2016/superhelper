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

console.log("permission-spawn-args: ok");
