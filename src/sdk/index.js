"use strict";

const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const { spawn } = require("node:child_process");
const readline = require("node:readline");

const PROTOCOL_VERSION = 1;
const EXIT_CODES = Object.freeze({
  SUCCESS: 0,
  USAGE: 2,
  USER_INPUT_REQUIRED: 10,
  PERMISSION_DENIED: 11,
  CANCELLED: 12,
  RUNTIME_UNAVAILABLE: 20,
  TASK_FAILED: 30,
});

function codedError(code, message = code) {
  const error = new Error(`${code}: ${message}`);
  error.code = code;
  return error;
}

function normalizeRuntimeEvent(event, fallbackCursor = 0) {
  if (!event || typeof event !== "object" || Array.isArray(event) || !String(event.type || "").trim()) {
    throw codedError("LILY_SDK_EVENT_INVALID");
  }
  return {
    protocolVersion: PROTOCOL_VERSION,
    cursor: Number.isFinite(Number(event.cursor)) ? Number(event.cursor) : fallbackCursor,
    type: String(event.type),
    sessionId: String(event.sessionId || ""),
    turnId: String(event.turnId || ""),
    taskRunId: String(event.taskRunId || ""),
    ts: Number.isFinite(Number(event.ts)) ? Number(event.ts) : Date.now(),
    payload: event.payload && typeof event.payload === "object" ? event.payload : {},
  };
}

function encodeRuntimeEvent(event) {
  return `${JSON.stringify(normalizeRuntimeEvent(event, Number(event?.cursor || 0)))}\n`;
}

function decodeRuntimeEventLine(line) {
  let parsed;
  try {
    parsed = JSON.parse(String(line || "").trim());
  } catch {
    throw codedError("LILY_SDK_EVENT_INVALID");
  }
  return normalizeRuntimeEvent(parsed, Number(parsed?.cursor || 0));
}

function validateRunInput(input = {}) {
  const prompt = String(input.prompt || "").trim();
  if (!prompt && !input.command && !input.resume && !input.sessionId) throw codedError("LILY_SDK_PROMPT_REQUIRED");
  return {
    ...input,
    prompt,
    workspace: String(input.workspace || process.cwd()),
  };
}

function runtimeControlDiscoveryPath(options = {}) {
  return options.controlFile || process.env.LILY_RUNTIME_CONTROL_FILE
    || path.join(os.homedir(), ".lily", "runtime-control.json");
}

function loadRuntimeControl(options = {}) {
  try {
    const parsed = JSON.parse(fs.readFileSync(runtimeControlDiscoveryPath(options), "utf8"));
    if (parsed?.protocolVersion !== PROTOCOL_VERSION || !parsed.url || !parsed.token) return null;
    return { url: String(parsed.url).replace(/\/$/, ""), token: String(parsed.token) };
  } catch { return null; }
}

async function controlRequest(control, route, body = {}, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs || 35_000);
  try {
    const response = await fetch(`${control.url}${route}`, {
      method: route === "/v1/health" ? "GET" : "POST",
      headers: { authorization: `Bearer ${control.token}`, "content-type": "application/json" },
      ...(route === "/v1/health" ? {} : { body: JSON.stringify(body) }),
      signal: controller.signal,
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || result.ok === false) {
      const error = codedError(result.error || "LILY_RUNTIME_CONTROL_FAILED");
      error.status = response.status;
      throw error;
    }
    return result;
  } finally { clearTimeout(timeout); }
}

function createDesktopRuntimeTransport(options = {}) {
  const selected = new Set();
  async function control() {
    const discovered = loadRuntimeControl(options);
    if (!discovered) throw codedError("LILY_DESKTOP_RUNTIME_UNAVAILABLE");
    await controlRequest(discovered, "/v1/health", {}, { timeoutMs: 1_500 });
    return discovered;
  }
  return {
    async available() {
      try { await control(); return true; } catch { return false; }
    },
    async *run(rawInput) {
      const input = validateRunInput(rawInput);
      const activeControl = await control();
      const route = input.prompt || input.command ? "/v1/run" : "/v1/resume";
      const started = await controlRequest(activeControl, route, input);
      const sessionId = String(started.sessionId || input.sessionId || input.resume || "");
      const turnId = String(started.turnId || "");
      selected.add(sessionId);
      let cursor = Math.max(0, Number(input.afterCursor ?? started.cursor ?? 0));
      let idleResume = route === "/v1/resume" && started.snapshot?.phase === "idle";
      const timeout = Number(input.timeoutMs) > 0
        ? setTimeout(() => { void controlRequest(activeControl, "/v1/cancel", { sessionId }).catch(() => {}); }, Number(input.timeoutMs))
        : null;
      try {
        while (true) {
          const page = await controlRequest(activeControl, "/v1/events", {
            sessionId,
            afterSeq: cursor,
            waitMs: idleResume ? 1 : 30_000,
          });
          const events = Array.isArray(page.events) ? page.events : [];
          for (const event of events) {
            cursor = Math.max(cursor, Number(event.seq || event.cursor || 0));
            const normalized = normalizeRuntimeEvent({ ...event, cursor }, cursor);
            yield normalized;
            if (turnId && normalized.turnId === turnId && /^(turn\.(completed|failed|interrupted)|runtime\.failed)$/.test(normalized.type)) return;
          }
          if (idleResume) return;
        }
      } finally {
        if (timeout) clearTimeout(timeout);
        selected.delete(sessionId);
      }
    },
    async cancel(id) {
      const activeControl = await control();
      return controlRequest(activeControl, "/v1/cancel", { sessionId: String(id || "") });
    },
    async steer(id, text) {
      const activeControl = await control();
      return controlRequest(activeControl, "/v1/steer", { sessionId: String(id || ""), text });
    },
    async checkpoint(id) {
      const activeControl = await control();
      return controlRequest(activeControl, "/v1/checkpoint", { sessionId: String(id || "") });
    },
  };
}

function createAutoTransport(options = {}) {
  const desktop = createDesktopRuntimeTransport(options);
  const child = createChildProcessTransport(options);
  const selected = new Map();
  return {
    async *run(input) {
      const useDesktop = !input.allowedTools?.length && !input.maxTurns && await desktop.available();
      const transport = useDesktop ? desktop : child;
      const id = String(input.sessionId || input.resume || input.taskRunId || "");
      if (id) selected.set(id, transport);
      try { yield* transport.run(input); }
      finally { if (id) selected.delete(id); }
    },
    cancel(id) { return (selected.get(String(id || "")) || desktop).cancel(id); },
    steer(id, text) { return (selected.get(String(id || "")) || desktop).steer(id, text); },
    checkpoint(id) { return desktop.checkpoint(id); },
  };
}

function createChildProcessTransport(options = {}) {
  const command = options.command || process.execPath;
  const cliPath = options.cliPath || path.resolve(__dirname, "../../scripts/lily-headless.mjs");
  const active = new Map();

  return {
    async *run(rawInput) {
      const input = validateRunInput(rawInput);
      const args = [cliPath, "--stream-json", "--cwd", input.workspace];
      if (input.sessionId) args.push("--session", String(input.sessionId));
      if (input.resume) args.push("--resume", String(input.resume));
      if (input.fork) args.push("--fork");
      if (input.model) args.push("--model", String(input.model));
      if (input.command) args.push("--command", String(input.command));
      if (input.timeoutMs) args.push("--timeout", String(input.timeoutMs));
      if (input.maxTurns) args.push("--max-turns", String(input.maxTurns));
      if (input.allowedTools?.length) args.push("--allowed-tools", input.allowedTools.join(","));
      if (input.deniedTools?.length) args.push("--denied-tools", input.deniedTools.join(","));
      if (input.prompt) args.push(input.prompt);
      const child = spawn(command, args, {
        cwd: input.workspace,
        env: { ...process.env, ...(options.env || {}), ...(input.env || {}) },
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
      const exitPromise = new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("close", (code, signal) => resolve(signal ? EXIT_CODES.CANCELLED : Number(code ?? EXIT_CODES.TASK_FAILED)));
      });
      const runId = String(input.taskRunId || input.sessionId || child.pid);
      active.set(runId, child);
      let stderr = "";
      child.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-8_000); });
      let cursor = 0;
      try {
        const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
        for await (const line of lines) {
          if (!String(line).trim()) continue;
          const event = decodeRuntimeEventLine(line);
          cursor = Math.max(cursor + 1, Number(event.cursor || 0));
          yield { ...event, cursor };
        }
        const exitCode = await exitPromise;
        if (exitCode !== EXIT_CODES.SUCCESS) {
          const error = codedError("LILY_SDK_RUN_FAILED", stderr || `exit ${exitCode}`);
          error.exitCode = exitCode;
          throw error;
        }
      } finally {
        active.delete(runId);
      }
    },
    async cancel(id) {
      const child = active.get(String(id || ""));
      if (!child) return false;
      return child.kill("SIGINT");
    },
    async steer() { return false; },
    async checkpoint() { throw codedError("LILY_SDK_CHECKPOINT_REQUIRES_DESKTOP_RUNTIME"); },
  };
}

function createLilyClient(options = {}) {
  const transport = options.transport || createAutoTransport(options);
  if (!transport || typeof transport.run !== "function") throw codedError("LILY_SDK_TRANSPORT_INVALID");
  return Object.freeze({
    run(input) {
      const normalized = validateRunInput(input);
      const source = transport.run(normalized);
      return (async function* events() {
        let cursor = 0;
        for await (const event of source) {
          cursor = Math.max(cursor + 1, Number(event?.cursor || 0));
          yield normalizeRuntimeEvent(event, cursor);
        }
      })();
    },
    resume(input = {}) {
      if (!input.sessionId && !input.resume) throw codedError("LILY_SDK_SESSION_REQUIRED");
      return this.run({ ...input, resume: input.resume || input.sessionId });
    },
    cancel(id) {
      if (typeof transport.cancel !== "function") return Promise.resolve(false);
      return transport.cancel(id);
    },
    steer(id, text) {
      if (!String(text || "").trim()) throw codedError("LILY_SDK_STEER_TEXT_REQUIRED");
      if (typeof transport.steer !== "function") return Promise.resolve(false);
      return transport.steer(id, text);
    },
    checkpoint(id) {
      if (typeof transport.checkpoint !== "function") throw codedError("LILY_SDK_CHECKPOINT_UNAVAILABLE");
      return transport.checkpoint(id);
    },
  });
}

module.exports = {
  EXIT_CODES,
  PROTOCOL_VERSION,
  createChildProcessTransport,
  createDesktopRuntimeTransport,
  createLilyClient,
  decodeRuntimeEventLine,
  encodeRuntimeEvent,
  normalizeRuntimeEvent,
  runtimeControlDiscoveryPath,
};
