#!/usr/bin/env node
/**
 * One-time login capture: pin the local-only, secure session store and the
 * login-complete detection (precise signals + heuristic). The actual headful
 * browser capture is integration-verified; everything else is deterministic.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import module from "node:module";
import { assert } from "./lib/test-assert.mjs";

const require = module.createRequire(import.meta.url);
const { slugifySystem, sessionStorePath, sessionInfo, loginComplete, writeSessionFileSecure } = require("../resources/skills-catalog/lily-web-system-learning/scripts/capture_session.cjs");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lily-session-"));

try {
  // path + slug
  assert(slugifySystem("UCMDS MOD!!") === "ucmds-mod", `slug, got ${slugifySystem("UCMDS MOD!!")}`);
  const p = sessionStorePath("Demo ERP", tmp);
  assert(p === path.join(tmp, "web-sessions", "demo-erp.json"), `session path under userData/web-sessions, got ${p}`);

  // login-complete: precise session-cookie signal
  assert(loginComplete({ url: "x", cookies: [{ name: "SESSION", value: "a" }], opts: { sessionCookie: "SESSION" } }) === true, "session cookie present → logged in");
  assert(loginComplete({ url: "x", cookies: [{ name: "OTHER", value: "a" }], opts: { sessionCookie: "SESSION" } }) === false, "named cookie missing → not logged in");
  // precise success-url signal
  assert(loginComplete({ url: "https://erp/home", cookies: [], opts: { successUrlContains: "/home" } }) === true, "success url match → logged in");
  // heuristic: left login page + has a cookie
  assert(loginComplete({ url: "https://erp/dash", loginUrl: "https://erp/login", cookies: [{ name: "s", value: "1" }] }) === true, "left login + cookie → logged in");
  assert(loginComplete({ url: "https://erp/login", loginUrl: "https://erp/login", cookies: [{ name: "s", value: "1" }] }) === false, "still on login page → not yet");
  assert(loginComplete({ url: "https://erp/dash", loginUrl: "https://erp/login", cookies: [] }) === false, "no cookie → not yet");

  // secure write: file 0600, dir present, content intact
  const file = path.join(tmp, "web-sessions", "demo-erp.json");
  writeSessionFileSecure(file, { cookies: [{ name: "s", value: "1", domain: "erp.example.com", path: "/" }], origins: [] });
  assert(fs.existsSync(file), "session file written");
  if (process.platform !== "win32") {
    const mode = fs.statSync(file).mode & 0o777;
    assert(mode === 0o600, `session file must be 0600, got ${mode.toString(8)}`);
  }
  const info = sessionInfo(file);
  assert(info.exists && info.cookieCount === 1, "sessionInfo reports cookie count");
  assert(sessionInfo(path.join(tmp, "nope.json")).exists === false, "missing session → not exists");

  console.log("PASS: test-web-system-session-capture (11 tests)");
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
