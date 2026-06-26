#!/usr/bin/env node
/**
 * Bridge-side auto re-login orchestration (#1b slice 3). The connector bridge runs
 * in the Electron MAIN process — the ONLY place the credential vault can be
 * decrypted — so the child MCP/executor never sees the password. This wires the
 * two cores (WebCredentialStore + reloginViaApi) end to end: look up the credential
 * for a stale request URL, log in, and refresh the storageState FILE the executor
 * reads. Uses the REAL credential store + a fake fetch (no network).
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { handleWebSystemRelogin } = require("../src/main/connector-bridge.js");
const { WebCredentialStore } = require("../src/main/web-credential-store.js");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lily-bridge-relogin-"));
const store = new WebCredentialStore({ filePath: path.join(dir, "creds.json") });
store.saveCredential({ domain: "erp.example.com", loginUrl: "https://erp.example.com/login", username: "alice", password: "pw" });

const sessionPath = path.join(dir, "session.json");
const writeStaleSession = () =>
  fs.writeFileSync(sessionPath, JSON.stringify({ cookies: [{ name: "session", value: "stale", domain: "erp.example.com", path: "/" }] }));

const okFetch = async () => ({ ok: true, status: 200, headers: { getSetCookie: () => ["session=fresh; Path=/"], get: () => null } });
const badFetch = async () => ({ ok: false, status: 401, headers: { getSetCookie: () => [], get: () => null } });

// 1) happy path: stale session for a domain we have a credential for -> re-login ->
//    the session FILE is refreshed in place (so the executor re-run picks it up).
{
  writeStaleSession();
  const r = await handleWebSystemRelogin(
    { url: "https://erp.example.com/api/orders", sessionStatePath: sessionPath },
    { webCredentialStore: store, reloginDeps: { fetch: okFetch } },
  );
  assert.equal(r.ok, true, "re-login succeeded");
  assert.ok(r.cookiesUpdated >= 1, "session cookies refreshed");
  assert.equal(r.password, undefined, "the bridge response NEVER includes the password");
  const ss = JSON.parse(fs.readFileSync(sessionPath, "utf8"));
  assert.equal(ss.cookies.find((c) => c.name === "session").value, "fresh", "storageState file now has the fresh session cookie");
}

// 1b) LEARNING login: no session file exists yet -> the handler CREATES one (this
//     is what lets capture skip the manual browser when a credential is stored).
{
  const freshPath = path.join(dir, "fresh-session.json");
  const r = await handleWebSystemRelogin(
    { url: "https://erp.example.com/api/orders", sessionStatePath: freshPath },
    { webCredentialStore: store, reloginDeps: { fetch: okFetch } },
  );
  assert.equal(r.ok, true, "fresh learning login succeeds");
  assert.ok(fs.existsSync(freshPath), "a new session file is created when none existed");
  const ss = JSON.parse(fs.readFileSync(freshPath, "utf8"));
  assert.equal(ss.cookies.find((c) => c.name === "session").value, "fresh", "the created session file carries the login cookie");
}

// 2) no credential for the domain -> fail safe (caller falls back to relearn).
{
  const r = await handleWebSystemRelogin(
    { url: "https://unknown-system.com/x", sessionStatePath: sessionPath },
    { webCredentialStore: store, reloginDeps: { fetch: okFetch } },
  );
  assert.equal(r.ok, false);
  assert.equal(r.code, "NO_CREDENTIAL");
}

// 3) login itself fails -> fail safe, session file untouched.
{
  writeStaleSession();
  const r = await handleWebSystemRelogin(
    { url: "https://erp.example.com/api/orders", sessionStatePath: sessionPath },
    { webCredentialStore: store, reloginDeps: { fetch: badFetch } },
  );
  assert.equal(r.ok, false);
  assert.equal(r.code, "RELOGIN_FAILED");
  const ss = JSON.parse(fs.readFileSync(sessionPath, "utf8"));
  assert.equal(ss.cookies.find((c) => c.name === "session").value, "stale", "session file left untouched on failed login");
}

fs.rmSync(dir, { recursive: true, force: true });
console.log("connector-bridge-relogin: ok");
