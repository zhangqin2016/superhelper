"use strict";

const HELPER_ENV_KEYS = Object.freeze([
  "ComSpec",
  "LANG",
  "LC_ALL",
  "PATH",
  "PATHEXT",
  "Path",
  "SystemRoot",
  "TEMP",
  "TMP",
  "TMPDIR",
  "WINDIR",
]);

function helperEnvironment(
  source,
  auth,
  testReserveDelayMs,
  testCommitDelayMs,
  testCommitNeverRespond,
) {
  const env = {};
  for (const key of HELPER_ENV_KEYS) {
    if (typeof source[key] === "string") env[key] = source[key];
  }
  env.ELECTRON_RUN_AS_NODE = "1";
  env.LILY_DESTINATION_BROKER_AUTH = auth;
  if (testReserveDelayMs > 0) {
    env.LILY_DESTINATION_BROKER_TEST_RESERVE_DELAY_MS = String(testReserveDelayMs);
  }
  if (testCommitDelayMs > 0) {
    env.LILY_DESTINATION_BROKER_TEST_COMMIT_DELAY_MS = String(testCommitDelayMs);
  }
  if (testCommitNeverRespond) {
    env.LILY_DESTINATION_BROKER_TEST_COMMIT_NEVER_RESPOND = "1";
  }
  return env;
}

module.exports = { helperEnvironment };
