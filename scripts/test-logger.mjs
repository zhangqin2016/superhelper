#!/usr/bin/env node

import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { Logger } = require("../src/main/logger.js");

const original = {
  log: console.log,
  warn: console.warn,
  error: console.error,
};
const lines = [];

try {
  console.log = (...args) => lines.push(["log", args.join(" ")]);
  console.warn = (...args) => lines.push(["warn", args.join(" ")]);
  console.error = (...args) => lines.push(["error", args.join(" ")]);

  const logger = new Logger("logger-test");
  logger.info("serve ready on %s (cwd %s)", "http://127.0.0.1:4096", "/tmp/app");
  logger.warn("failed %d time(s): %s", 2, "network");
  logger.error("plain");

  assert.equal(lines.length, 3);
  assert.match(lines[0][1], /serve ready on http:\/\/127\.0\.0\.1:4096 \(cwd \/tmp\/app\)/);
  assert.doesNotMatch(lines[0][1], /%s/);
  assert.match(lines[1][1], /failed 2 time\(s\): network/);
  assert.doesNotMatch(lines[1][1], /%d|%s/);
  assert.match(lines[2][1], /plain/);
} finally {
  console.log = original.log;
  console.warn = original.warn;
  console.error = original.error;
}

console.log("logger: ok");
