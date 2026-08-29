#!/usr/bin/env node
import module from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = module.createRequire(import.meta.url);
const {
  loginShellPathEntries,
  sanitizeExecutablePathEntries,
} = require(path.join(__dirname, "../src/main/executable-paths.js"));

let childEnv = null;
let shellRuns = 0;
const shellEntries = loginShellPathEntries({
  platform: "linux",
  home: os.homedir(),
  env: {
    HOME: os.homedir(),
    USER: "tester",
    SHELL: "/bin/sh",
    PATH: "/usr/bin:/bin",
    API_TOKEN: "must-not-leak",
    NODE_OPTIONS: "--require /tmp/unsafe.js",
  },
  fileExists: () => true,
  spawnSync(_shell, _args, options) {
    shellRuns += 1;
    childEnv = options.env;
    return {
      stdout: "__LILY_EXECUTABLE_PATH__/fake/banner/bin\nshell banner\n__LILY_EXECUTABLE_PATH__/opt/tool/bin:/usr/bin:relative\n",
    };
  },
});

if (shellEntries.join(":") !== "/opt/tool/bin:/usr/bin:relative") {
  throw new Error(`login-shell PATH marker was not parsed: ${shellEntries.join(":")}`);
}
if (childEnv.API_TOKEN || childEnv.NODE_OPTIONS) {
  throw new Error("login-shell discovery leaked non-platform host variables");
}
loginShellPathEntries({
  platform: "linux",
  home: os.homedir(),
  env: { HOME: os.homedir(), USER: "tester", SHELL: "/bin/sh", PATH: "/usr/bin:/bin" },
  fileExists: () => true,
  spawnSync() {
    shellRuns += 1;
    return { stdout: "" };
  },
});
if (shellRuns !== 1) throw new Error("successful login-shell PATH discovery was not cached");

const sanitized = sanitizeExecutablePathEntries([
  "/usr/bin", "/usr/bin/", ".", "relative", "/opt/tool/bin",
], {
  platform: "linux",
  isDirectory: (entry) => entry === "/usr/bin" || entry === "/opt/tool/bin",
});
if (sanitized.join(":") !== "/usr/bin:/opt/tool/bin") {
  throw new Error(`unsafe or duplicate executable paths survived: ${sanitized.join(":")}`);
}

console.log("PASS: test-executable-paths");
