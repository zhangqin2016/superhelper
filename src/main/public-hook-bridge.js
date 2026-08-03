"use strict";

const http = require("node:http");
const { createRuntimeIdentityRegistry } = require("./runtime-identity-registry");
const { runtimeIdentityProcessSecret, verifyRuntimeIdentity } = require("./runtime-identity");

const MAX_BODY_BYTES = 512 * 1024;
const BRIDGED_EVENTS = new Set([
  "tool.before", "tool.after", "tool.failed",
  "compaction.before",
]);

function json(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
  });
  res.end(body);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error("PUBLIC_HOOK_BRIDGE_BODY_TOO_LARGE"), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.once("error", reject);
    req.once("end", () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")); }
      catch { reject(Object.assign(new Error("PUBLIC_HOOK_BRIDGE_JSON_INVALID"), { status: 400 })); }
    });
  });
}

function createPublicHookBridge(options = {}) {
  const runtime = options.runtime;
  const registryPath = options.registryPath;
  if (!runtime?.run || !registryPath) throw new Error("PUBLIC_HOOK_BRIDGE_CONFIG_INVALID");
  const registry = createRuntimeIdentityRegistry({ filePath: registryPath });
  const secret = options.secret || runtimeIdentityProcessSecret();
  let server = null;
  let url = "";

  async function handle(req, res) {
    if (req.method !== "POST" || req.url !== "/v1/hooks/execute") return json(res, 404, { ok: false, error: "NOT_FOUND" });
    try {
      const token = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "").trim();
      const body = await readJson(req);
      const engineSessionId = String(body.engineSessionId || "").trim();
      const identity = verifyRuntimeIdentity(token, {
        secret,
        audience: "tool-broker",
        isRevoked: (candidate) => registry.isRevoked(candidate.nonce),
      });
      if (!engineSessionId || registry.resolve(engineSessionId) !== token) {
        return json(res, 403, { ok: false, error: "RUNTIME_IDENTITY_SCOPE_MISMATCH" });
      }
      const event = String(body.event || "");
      if (!BRIDGED_EVENTS.has(event)) return json(res, 400, { ok: false, error: "PUBLIC_HOOK_EVENT_INVALID" });
      const result = await runtime.run(event, {
        sessionId: identity.sessionId,
        turnId: identity.turnId,
        taskRunId: identity.taskRunId,
        agentId: identity.agentId,
        attemptId: identity.attemptId,
        engineSessionId,
        tool: String(body.tool || ""),
        args: body.args && typeof body.args === "object" ? body.args : {},
        output: body.output && typeof body.output === "object" ? body.output : {},
      }, { chain: Array.isArray(body.chain) ? body.chain : [] });
      return json(res, 200, { ok: true, ...result });
    } catch (error) {
      return json(res, Number(error?.status || 401), { ok: false, error: error?.code || error?.message || "PUBLIC_HOOK_BRIDGE_FAILED" });
    }
  }

  async function start() {
    if (server) return { url };
    server = http.createServer((req, res) => { void handle(req, res); });
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    server.unref?.();
    const address = server.address();
    url = `http://127.0.0.1:${address.port}`;
    return { url };
  }

  async function stop() {
    const current = server;
    server = null;
    url = "";
    if (!current) return;
    const closing = new Promise((resolve) => current.close(resolve));
    current.closeIdleConnections?.();
    current.closeAllConnections?.();
    await closing;
  }

  return Object.freeze({ start, stop, get url() { return url; } });
}

module.exports = { BRIDGED_EVENTS, createPublicHookBridge };
