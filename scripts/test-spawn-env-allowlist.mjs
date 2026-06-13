#!/usr/bin/env node
/**
 * Agent subprocess env allowlist: host credentials and behavior-changing
 * variables must NOT leak into agent subprocesses (P0 — the agent runs
 * arbitrary tools; the host shell's secrets are not its input). Platform
 * basics and the app's own variables must survive.
 */
import module from "node:module";
import { assert } from "./lib/test-assert.mjs";

const require = module.createRequire(import.meta.url);
const { pickInheritedEnv } = require("../src/main/spawn-env-allowlist.js");

const host = {
  // must survive
  HOME: "/Users/me",
  USER: "me",
  SHELL: "/bin/zsh",
  TMPDIR: "/tmp",
  LANG: "en_US.UTF-8",
  LC_ALL: "en_US.UTF-8",
  XDG_CONFIG_HOME: "/Users/me/.config",
  LILY_LOCALE: "zh-CN",
  LILY_API_KEY: "lily_secret",
  LILY_GATEWAY_TOKEN: "gateway_secret",
  HTTPS_PROXY: "http://proxy:8080",
  SSH_AUTH_SOCK: "/tmp/ssh-sock",
  // must be withheld
  NODE_OPTIONS: "--require /tmp/evil.js",
  ELECTRON_RUN_AS_NODE: "1",
  NPM_CONFIG_REGISTRY: "http://evil",
  NPM_TOKEN: "npm_secret",
  GIT_SSH_COMMAND: "ssh -o ProxyCommand=evil",
  AWS_SECRET_ACCESS_KEY: "aws_secret",
  GITHUB_TOKEN: "gh_secret",
  OPENAI_API_KEY: "sk-secret",
  LD_PRELOAD: "/tmp/evil.so",
  DYLD_INSERT_LIBRARIES: "/tmp/evil.dylib",
  PATH: "/host/path", // PATH is rebuilt explicitly by spawn-env, never inherited
};

const env = pickInheritedEnv(host);

for (const key of ["HOME", "USER", "SHELL", "TMPDIR", "LANG", "LC_ALL", "XDG_CONFIG_HOME", "LILY_LOCALE", "HTTPS_PROXY", "SSH_AUTH_SOCK"]) {
  assert(env[key] === host[key], `${key} preserved`);
}
for (const key of ["LILY_API_KEY", "LILY_GATEWAY_TOKEN", "NODE_OPTIONS", "ELECTRON_RUN_AS_NODE", "NPM_CONFIG_REGISTRY", "NPM_TOKEN", "GIT_SSH_COMMAND", "AWS_SECRET_ACCESS_KEY", "GITHUB_TOKEN", "OPENAI_API_KEY", "LD_PRELOAD", "DYLD_INSERT_LIBRARIES", "PATH"]) {
  assert(!(key in env), `${key} withheld`);
}
assert(Object.keys(pickInheritedEnv({ FOO: undefined })).length === 0, "undefined values dropped");

console.log("PASS: test-spawn-env-allowlist");
