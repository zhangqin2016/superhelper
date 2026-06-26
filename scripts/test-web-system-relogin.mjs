#!/usr/bin/env node
/**
 * Main-process auto re-login core (#1b slice 3), against a LOCAL mock /login server.
 *
 * WHY it matters: when a learned session expires and there's no refresh endpoint,
 * the host re-logs-in with the vault password (in-process, never handing the
 * password to the headless executor), captures the rotated cookie, and refreshes
 * the storageState so the automation self-heals. Must fail safe (bad creds / net
 * error => ok:false, caller falls back to relearn).
 */
import assert from "node:assert/strict";
import http from "node:http";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { reloginViaApi, mergeCookiesIntoStorageState, buildLoginBody } = require("../src/main/web-system-relogin.js");

function startServer() {
  const server = http.createServer((req, res) => {
    if (req.method === "POST" && req.url === "/login") {
      let raw = "";
      req.on("data", (d) => { raw += d; });
      req.on("end", () => {
        let data = {};
        try {
          data = JSON.parse(raw);
        } catch {
          data = Object.fromEntries(new URLSearchParams(raw));
        }
        if (data.username === "alice" && data.password === "pw") {
          res.setHeader("Set-Cookie", "session=fresh; Path=/");
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
        } else {
          res.writeHead(401, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "bad credentials" }));
        }
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port })));
}

const { server, port } = await startServer();
const base = `http://127.0.0.1:${port}`;
try {
  // correct credentials -> session cookie returned
  {
    const r = await reloginViaApi({ username: "alice", password: "pw", loginUrl: `${base}/login` });
    assert.equal(r.ok, true, "login succeeds with correct credentials");
    assert.ok(r.cookies.some((c) => c.name === "session" && c.value === "fresh"), "fresh session cookie captured from Set-Cookie");
    assert.equal(r.cookies[0].domain, "127.0.0.1", "cookie domain derived from the login URL host");

    // merge refreshes a stale storageState cookie
    const ss = { cookies: [{ name: "session", value: "stale", domain: "127.0.0.1", path: "/" }] };
    mergeCookiesIntoStorageState(ss, r.cookies);
    assert.equal(ss.cookies.find((c) => c.name === "session").value, "fresh", "storageState session cookie refreshed in place");
  }

  // wrong password -> fail safe (no fake success)
  {
    const r = await reloginViaApi({ username: "alice", password: "WRONG", loginUrl: `${base}/login` });
    assert.equal(r.ok, false, "wrong credentials do not fake success");
    assert.equal(r.status, 401);
    assert.deepEqual(r.cookies, [], "no cookies on failed login");
  }

  // missing password -> no request attempted
  {
    const r = await reloginViaApi({ username: "alice", loginUrl: `${base}/login` });
    assert.equal(r.ok, false, "missing password -> no login attempt");
    assert.equal(r.status, 0);
  }

  // fail-safe: a network error degrades to ok:false (caller falls back to relearn)
  {
    const r = await reloginViaApi(
      { username: "a", password: "b", loginUrl: `${base}/login` },
      {},
      { fetch: () => { throw new Error("network down"); } },
    );
    assert.equal(r.ok, false, "network error is caught, never thrown");
  }

  // body builders (json default + form), with custom field names
  {
    const json = buildLoginBody({ usernameField: "user", passwordField: "pass" }, "alice", "pw");
    assert.ok(json.contentType.includes("json"));
    assert.deepEqual(JSON.parse(json.body), { user: "alice", pass: "pw" }, "json body uses the configured field names");
    const form = buildLoginBody({ contentType: "form", extraFields: { tenant: "acme" } }, "alice", "pw");
    assert.ok(form.contentType.includes("urlencoded"));
    assert.match(form.body, /username=alice/);
    assert.match(form.body, /tenant=acme/, "extra learned fields are included");
  }

  console.log("web-system-relogin: ok");
} finally {
  server.close();
}
