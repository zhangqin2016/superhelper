#!/usr/bin/env node
/**
 * Learning auto-login from a stored credential (#1b, learning side): capture_session
 * should NOT open a manual browser when the user has saved a site login — it asks
 * the main-process bridge to log in and write the session. Here a LOCAL mock bridge
 * stands in for the main process; we assert capture returns mode:"credential" and
 * never reaches the (browser) fallback. The password never touches this script.
 */
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const capture = path.join(ROOT, "resources/skills-catalog/lily-web-system-learning/scripts/capture_session.cjs");

function startBridge(respond) {
  const server = http.createServer((req, res) => {
    if (req.method === "POST" && req.url === "/v1/web-system/relogin") {
      let body = "";
      req.on("data", (d) => { body += d; });
      req.on("end", () => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(respond(JSON.parse(body || "{}"))));
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port })));
}

function runCapture(port, out) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [capture, "--base-url", "https://erp.example.com", "--system-id", "mock", "--allow-domain", "example.com", "--out", out],
      { env: { ...process.env, LILY_CONNECTOR_BRIDGE_URL: `http://127.0.0.1:${port}`, LILY_CONNECTOR_BRIDGE_TOKEN: "t" } },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    child.on("error", reject);
    child.on("close", () => {
      try {
        resolve(JSON.parse(stdout));
      } catch {
        reject(new Error(`no JSON. stderr=${stderr} stdout=${stdout}`));
      }
    });
  });
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lily-capture-cred-"));
const out = path.join(dir, "session.json");

// Credential exists -> bridge logs in (cookiesUpdated > 0) -> capture skips the browser.
{
  const sentBody = [];
  const { server, port } = await startBridge((body) => {
    sentBody.push(body);
    return { ok: true, cookiesUpdated: 1 };
  });
  try {
    const result = await runCapture(port, out);
    assert.equal(result.ok, true, "capture succeeded");
    assert.equal(result.mode, "credential", "auto-logged-in via stored credential — no manual browser");
    assert.equal(result.sessionPath, out, "session path returned");
    // capture must send only the URL + session path to the bridge, never a password.
    assert.equal(sentBody[0].url, "https://erp.example.com", "bridge asked to log in for the site URL");
    assert.ok(!("password" in sentBody[0]) && !("username" in sentBody[0]), "capture never sends credentials to the bridge");
  } finally {
    server.close();
  }
}

fs.rmSync(dir, { recursive: true, force: true });
console.log("web-system-capture-credential: ok");
