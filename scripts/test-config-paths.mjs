#!/usr/bin/env node
//
// config base-path resolution must work WITHOUT electron — that's the whole
// point of decoupling it (so the 41 modules that import config, plus CLIs and
// tests, don't need to mock electron). This test runs in plain node and never
// touches electron's app.

import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { assert } from "./lib/test-assert.mjs";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Ensure no ambient override leaks in from the runner.
delete process.env.LILY_USER_DATA_DIR;
delete process.env.LILY_HOME;
delete process.env.LILY_DOCUMENTS_DIR;

const config = require(path.join(ROOT, "src/main/config.js"));

// 1. Fail loud before anything is bound: a wrong path must never be guessed.
let threw = false;
try {
  config.userHome();
} catch (err) {
  threw = /unavailable/.test(err.message);
}
assert(threw, "userHome() must throw when no env/binding/electron provides 'home'");

// 2. Injection (what electron main does at startup) — no electron needed here.
config.bindRuntimePaths({ userData: "/tmp/ud", home: "/tmp/home", documents: "/tmp/docs" });
assert(config.userDataPath("sessions.json") === path.join("/tmp/ud", "sessions.json"), "userDataPath should use injected userData");
assert(config.userHome() === "/tmp/home", "userHome should use injected home");
assert(config.sessionMessagesDir() === path.join("/tmp/ud", "session-messages"), "derived dir should chain off injected userData");
const expectedWs = process.platform === "win32"
  ? path.join("/tmp/docs", "Lily Workbench")
  : path.join("/tmp/home", "Lily Workbench");
assert(config.defaultWorkspacePath() === expectedWs, "defaultWorkspacePath should derive from injected base");

// 3. Env override wins over injection (this is how agent subprocesses/CLIs get
//    the SAME userData as the main process — see runtime-packs).
process.env.LILY_USER_DATA_DIR = "/tmp/env-ud";
assert(config.userDataPath() === "/tmp/env-ud", "LILY_USER_DATA_DIR must override the injected userData");
delete process.env.LILY_USER_DATA_DIR;
assert(config.userDataPath() === "/tmp/ud", "without env, injected userData applies again");

console.log("config-paths: ok (resolves without electron — injection + env + fail-loud)");
