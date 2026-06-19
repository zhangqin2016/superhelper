"use strict";

const crypto = require("node:crypto");
const http = require("node:http");
const { createMailAccountStore } = require("./mail-accounts");
const { runMailAction } = require("./mail-actions");

let bridge = null;

async function ensureConnectorBridgeStarted(options = {}) {
  if (bridge?.server?.listening) return bridge.publicState;
  const token = crypto.randomBytes(32).toString("base64url");
  const mailStore = options.mailStore || createMailAccountStore();
  const server = http.createServer((req, res) => handleRequest(req, res, { token, mailStore }));
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
    return sendJson(res, 404, { ok: false, error: "NOT_FOUND" });
  } catch (err) {
    return sendJson(res, 500, { ok: false, error: "BRIDGE_ERROR", message: err?.message || String(err) });
  }
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
};
