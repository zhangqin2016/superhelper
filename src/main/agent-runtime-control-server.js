"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { createRuntimeCheckpointForSession } = require("./ipc-agent-runtime");

const MAX_BODY_BYTES = 1024 * 1024;
const MAX_WAIT_MS = 30_000;

function discoveryPath() {
  return process.env.LILY_RUNTIME_CONTROL_FILE
    || path.join(os.homedir(), ".lily", "runtime-control.json");
}

function json(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
  });
  res.end(body);
}

function bodyJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error("REQUEST_TOO_LARGE"), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.once("error", reject);
    req.once("end", () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")); }
      catch { reject(Object.assign(new Error("INVALID_JSON"), { status: 400 })); }
    });
  });
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left || ""));
  const b = Buffer.from(String(right || ""));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function resolveSession(ctx, input = {}) {
  const requested = String(input.sessionId || input.resume || "").trim();
  if (requested) {
    const session = ctx.sessionManager.findById(requested);
    if (!session) throw Object.assign(new Error("SESSION_NOT_FOUND"), { status: 404 });
    return session;
  }
  const workspace = path.resolve(String(input.workspace || process.cwd()));
  let project = ctx.projectManager.projects.find((item) => path.resolve(item.path) === workspace);
  if (!project) project = ctx.projectManager.add(workspace);
  return ctx.sessionManager.create(project.id, String(input.title || "Lily CLI").slice(0, 80));
}

function waitForEvents(ctx, sessionId, afterSeq, waitMs) {
  const read = () => ctx.sessionManager.getRuntimeEvents(sessionId, { afterSeq, limit: 500 });
  const immediate = read();
  if (immediate.length || waitMs <= 0) return Promise.resolve(immediate);
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      unsubscribe();
      resolve(read());
    };
    const unsubscribe = ctx.eventBus.addObserver((observedSessionId) => {
      if (observedSessionId === sessionId) finish();
    });
    const timer = setTimeout(finish, Math.min(MAX_WAIT_MS, Math.max(1, waitMs)));
    if (read().length) finish();
  });
}

function createAgentRuntimeControlServer(ctx, options = {}) {
  const token = options.token || crypto.randomBytes(48).toString("base64url");
  const authorize = options.authorize || (() => require("./license-manager").requireValidLicenseFresh());
  const filePath = options.discoveryPath || discoveryPath();
  let server = null;
  let url = "";

  async function handle(req, res) {
    try {
      const requestUrl = new URL(req.url || "/", "http://127.0.0.1");
      if (!safeEqual(String(req.headers.authorization || "").replace(/^Bearer\s+/i, ""), token)) {
        return json(res, 401, { ok: false, error: "UNAUTHORIZED" });
      }
      if (req.method === "GET" && requestUrl.pathname === "/v1/health") {
        return json(res, 200, { ok: true, protocolVersion: 1 });
      }
      if (req.method !== "POST") return json(res, 404, { ok: false, error: "NOT_FOUND" });
      const body = await bodyJson(req);

      if (requestUrl.pathname === "/v1/run") {
        const licensed = await authorize();
        if (!licensed.ok) return json(res, 403, licensed);
        const prompt = String(body.prompt || "").trim();
        if (!prompt) return json(res, 400, { ok: false, error: "PROMPT_REQUIRED" });
        if (body.allowedTools?.length || body.maxTurns) {
          return json(res, 409, { ok: false, error: "DEDICATED_ENGINE_REQUIRED" });
        }
        const session = resolveSession(ctx, body);
        const beforeSeq = ctx.sessionManager._store().getLastRuntimeEventSeq(session.id);
        const result = await ctx.turnOrchestrator.sendUserMessage(session.id, prompt, [], {
          spawnEngine: true,
          permissionMode: body.permissionMode,
          disallowedTools: Array.isArray(body.deniedTools) ? body.deniedTools : [],
        });
        const state = ctx.turnOrchestrator._state(session.id);
        return json(res, result?.ok === false ? 409 : 200, {
          ...result,
          ok: result?.ok !== false,
          protocolVersion: 1,
          sessionId: session.id,
          turnId: result?.turnId || state.turnId || "",
          taskRunId: state.taskRun?.id || "",
          cursor: beforeSeq,
        });
      }
      if (requestUrl.pathname === "/v1/resume") {
        const session = resolveSession(ctx, body);
        const snapshot = ctx.turnOrchestrator.snapshot(session.id);
        return json(res, 200, { ok: true, sessionId: session.id, turnId: snapshot.turnId || "", taskRunId: snapshot.taskRun?.id || "", snapshot });
      }
      if (requestUrl.pathname === "/v1/events") {
        const session = resolveSession(ctx, body);
        const afterSeq = Math.max(0, Number(body.afterSeq || 0));
        const events = await waitForEvents(ctx, session.id, afterSeq, Number(body.waitMs || MAX_WAIT_MS));
        return json(res, 200, { ok: true, sessionId: session.id, events });
      }
      if (requestUrl.pathname === "/v1/cancel") {
        const session = resolveSession(ctx, body);
        return json(res, 200, await ctx.turnOrchestrator.interrupt(session.id));
      }
      if (requestUrl.pathname === "/v1/steer") {
        const session = resolveSession(ctx, body);
        const text = String(body.text || "").trim();
        if (!text) return json(res, 400, { ok: false, error: "STEER_TEXT_REQUIRED" });
        return json(res, 200, await ctx.turnOrchestrator.sendUserMessage(session.id, text, [], { mode: "steer" }));
      }
      if (requestUrl.pathname === "/v1/checkpoint") {
        const session = resolveSession(ctx, body);
        const checkpoint = await createRuntimeCheckpointForSession(ctx, session.id, body);
        return json(res, 200, { ok: true, checkpoint });
      }
      return json(res, 404, { ok: false, error: "NOT_FOUND" });
    } catch (error) {
      return json(res, Number(error?.status || 500), { ok: false, error: error?.code || error?.message || "RUNTIME_CONTROL_FAILED" });
    }
  }

  async function start() {
    if (server) return { url, token, discoveryPath: filePath };
    server = http.createServer((req, res) => { void handle(req, res); });
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    server.unref?.();
    const address = server.address();
    url = `http://127.0.0.1:${address.port}`;
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const temporary = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify({ protocolVersion: 1, url, token, pid: process.pid, updatedAt: Date.now() })}\n`, { mode: 0o600, flag: "wx" });
    fs.renameSync(temporary, filePath);
    try { fs.chmodSync(filePath, 0o600); } catch { /* Windows ACLs are inherited */ }
    return { url, token, discoveryPath: filePath };
  }

  async function stop() {
    const current = server;
    server = null;
    url = "";
    try {
      const discovered = JSON.parse(fs.readFileSync(filePath, "utf8"));
      if (Number(discovered.pid) === process.pid) fs.unlinkSync(filePath);
    } catch { /* already removed or replaced */ }
    if (!current) return;
    const closing = new Promise((resolve) => current.close(resolve));
    current.closeIdleConnections?.();
    current.closeAllConnections?.();
    await closing;
  }

  return Object.freeze({ start, stop, get url() { return url; } });
}

module.exports = { createAgentRuntimeControlServer, discoveryPath, waitForEvents };
