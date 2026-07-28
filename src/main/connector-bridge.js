"use strict";

const crypto = require("node:crypto");
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { createMailAccountStore } = require("./mail-accounts");
const { runMailAction } = require("./mail-actions");
const { WebCredentialStore } = require("./web-credential-store");
const { reloginViaApi, mergeCookiesIntoStorageState } = require("./web-system-relogin");

let bridge = null;

async function ensureConnectorBridgeStarted(options = {}) {
  if (bridge?.server?.listening) return bridge.publicState;
  const token = crypto.randomBytes(32).toString("base64url");
  const mailStore = options.mailStore || createMailAccountStore();
  const webCredentialStore = options.webCredentialStore || new WebCredentialStore();
  const scheduledTaskManager = options.scheduledTaskManager || null;
  const resolveActiveScope = options.resolveActiveScope || null;
  const server = http.createServer((req, res) =>
    handleRequest(req, res, { token, mailStore, webCredentialStore, scheduledTaskManager, resolveActiveScope }));
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  const publicState = {
    url: `http://127.0.0.1:${address.port}`,
    token,
    pid: process.pid,
    startedAt: new Date().toISOString(),
  };
  bridge = { server, publicState };
  return publicState;
}

function getConnectorBridgeEnvSync() {
  const state = bridge?.publicState;
  if (!state?.url || !state?.token || state.pid !== process.pid) return {};
  return {
    LILY_CONNECTOR_BRIDGE_URL: String(state.url),
    LILY_CONNECTOR_BRIDGE_TOKEN: String(state.token),
  };
}

function stopConnectorBridge() {
  const server = bridge?.server;
  bridge = null;
  if (server?.listening) server.close();
}

async function handleRequest(req, res, deps) {
  try {
    if (req.method !== "POST") return sendJson(res, 405, { ok: false, error: "METHOD_NOT_ALLOWED" });
    if (req.headers.authorization !== `Bearer ${deps.token}`) {
      return sendJson(res, 401, { ok: false, error: "UNAUTHORIZED" });
    }
    const url = new URL(req.url || "/", "http://127.0.0.1");
    const payload = await readJsonBody(req);
    if (url.pathname === "/v1/mail/accounts") {
      return sendJson(res, 200, { ok: true, accounts: deps.mailStore.listAccountsPublic() });
    }
    if (url.pathname === "/v1/mail/search") {
      return sendJson(res, 200, await runMailAction(deps.mailStore, "search", payload));
    }
    if (url.pathname === "/v1/mail/read") {
      return sendJson(res, 200, await runMailAction(deps.mailStore, "read", payload));
    }
    if (url.pathname === "/v1/mail/send") {
      return sendJson(res, 200, await runMailAction(deps.mailStore, "send", payload));
    }
    if (url.pathname === "/v1/mail/test") {
      return sendJson(res, 200, await runMailAction(deps.mailStore, "test", payload));
    }
    if (url.pathname === "/v1/web-system/relogin") {
      return sendJson(res, 200, await handleWebSystemRelogin(payload, deps));
    }
    return sendJson(res, 404, { ok: false, error: "NOT_FOUND" });
  } catch (err) {
    return sendJson(res, 500, { ok: false, error: "BRIDGE_ERROR", message: err?.message || String(err) });
  }
}

// Auto re-login for a stale web-system session (#1b). Runs in the MAIN process —
// the only place the vault password can be decrypted — so the child MCP/executor
// never sees it. Looks up the credential for the failed request URL, logs in, and
// merges the fresh session cookies into the storageState FILE the executor reads,
// so the caller can re-run. Returns only {ok, cookiesUpdated} — never the password.
// FAIL-SAFE: no credential / failed login => {ok:false} and the caller falls back
// to relearn (today's behavior). deps.fs / deps.reloginDeps are injectable for tests.
async function handleWebSystemRelogin(payload, deps) {
  const store = deps.webCredentialStore;
  const fsImpl = deps.fs || fs;
  const requestUrl = String(payload?.url || "");
  const sessionStatePath = String(payload?.sessionStatePath || "");
  if (!store) return { ok: false, code: "NO_STORE" };
  const cred = store.findCredentialForUrl(requestUrl);
  if (!cred || !cred.secretSet) return { ok: false, code: "NO_CREDENTIAL" };
  const full = store.getCredentialWithSecret(cred.domain);
  if (!full || !full.password) return { ok: false, code: "NO_SECRET" };
  const result = await reloginViaApi(full, { url: full.loginUrl, ...(payload.loginSpec || {}) }, deps.reloginDeps || {});
  if (!result.ok) return { ok: false, code: "RELOGIN_FAILED", status: result.status };
  let cookiesUpdated = 0;
  if (sessionStatePath) {
    // Re-login REFRESHES an existing session; learning login CREATES a fresh one
    // (file may not exist yet) — same endpoint serves both.
    let storageState = { cookies: [], origins: [] };
    try {
      if (fsImpl.existsSync(sessionStatePath)) {
        const parsed = JSON.parse(fsImpl.readFileSync(sessionStatePath, "utf8"));
        if (parsed && typeof parsed === "object") storageState = parsed;
      }
    } catch {
      storageState = { cookies: [], origins: [] };
    }
    cookiesUpdated = mergeCookiesIntoStorageState(storageState, result.cookies);
    try {
      fsImpl.mkdirSync(path.dirname(sessionStatePath), { recursive: true });
    } catch {
      /* dir already exists / non-fatal */
    }
    fsImpl.writeFileSync(sessionStatePath, JSON.stringify(storageState));
  }
  return { ok: true, cookiesUpdated };
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1_000_000) {
        reject(new Error("request body too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res, status, data) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data));
}

module.exports = {
  ensureConnectorBridgeStarted,
  getConnectorBridgeEnvSync,
  stopConnectorBridge,
  handleWebSystemRelogin,
};
