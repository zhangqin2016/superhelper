"use strict";

/**
 * Shared OpenCode server — uses the official desktop client's SDK transport:
 * one `opencode serve` per compatible execution profile, the official SDK as
 * transport, one event stream demuxed by directory + sessionID, and per-directory
 * SDK clients (`createOpencodeClient({ baseUrl, directory })`, == official `sdkFor`).
 *
 * Multiple sessions across directories share a serve when their model/helper
 * configuration agrees. Different profiles coexist without interrupting work;
 * session permissions remain per-request and the directory is per-client.
 *
 * The SDK is ESM-only, so it's loaded via dynamic import() and cached.
 */
const { EventEmitter } = require("node:events");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { getLogger } = require("../logger");
const { killProcessTree } = require("../process-tree-kill");

const log = getLogger("opencode-shared-server");

let sdkModulePromise = null;
/** Load the ESM @opencode-ai/sdk v2 client once. */
function loadSdk() {
  if (!sdkModulePromise) sdkModulePromise = import("@opencode-ai/sdk/v2/client");
  return sdkModulePromise;
}

/** Parse the "listening on http://host:port" line opencode prints on stdout. */
function parseListeningPort(text) {
  const m = String(text).match(/listening on\s+https?:\/\/([^\s:]+):(\d{2,5})/i);
  return m ? { host: m[1], port: Number(m[2]) } : null;
}

class OpencodeSharedServer extends EventEmitter {
  /**
   * @param {{ serverCommand: string, cwd: string, dataDir: string,
   *   env?: Record<string,string>, configContent?: string }} opts
   */
  constructor(opts) {
    super();
    this.serverCommand = opts.serverCommand;
    this.cwd = opts.cwd; // serve's own root; per-session directory is set per client
    this.dataDir = opts.dataDir;
    this.env = processProfileEnv(opts.env);
    this.configContent = opts.configContent || "";

    this.process = null;
    this.host = "127.0.0.1";
    this.port = 0;
    this._starting = null;
    this._terminated = false;
    this._baseClient = null;
    /** @type {Map<string, any>} directory -> per-directory SDK client (== sdkFor) */
    this._clients = new Map();
    /** @type {Set<(directory:string, event:any)=>void>} */
    this._eventHandlers = new Set();
    this._sseRetries = 0;
    this._sseAbort = null;
    this._eventStreamReady = false;
    this._eventStreamReadyPromise = null;
    this._resolveEventStreamReady = null;
    this._rejectEventStreamReady = null;
    this._activeViews = 0;
    this._activeWork = 0;
    this._eventQueue = [];
    this._eventTimer = null;
    this._coalesced = new Map();
    this._deltaCoalesced = new Map();
    this._staleDeltas = new Set();
    this._lastFlushAt = 0;
    this._retireWhenIdle = false;
    this._eventStats = {
      received: 0,
      delivered: 0,
      coalesced: 0,
      droppedStaleDelta: 0,
      lastReceivedAt: 0,
      lastDeliveredAt: 0,
      byType: new Map(),
    };
    this._recentEvents = [];
  }

  get baseUrl() {
    return `http://${this.host}:${this.port}`;
  }

  retainView() {
    return this._retain("_activeViews");
  }

  retainWork() {
    return this._retain("_activeWork");
  }

  _retain(counter) {
    this[counter] += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this[counter] -= 1;
      if (this._retireWhenIdle && !this.hasActiveViews() && !this._activeWork) this.terminate();
    };
  }

  hasActiveViews() {
    return this._activeViews > 0;
  }

  retireWhenIdle() {
    this._retireWhenIdle = true;
    if (!this.hasActiveViews() && !this._activeWork) this.terminate();
  }

  /** Spawn the serve once; resolve when it reports its listening port. Idempotent. */
  ensureStarted({ timeoutMs = 20_000 } = {}) {
    if (this._baseClient) return Promise.resolve(this);
    if (this._starting) return this._starting;
    this._starting = new Promise((resolve, reject) => {
      try {
        if (this.dataDir && this.dataDir !== ":memory:") {
          fs.mkdirSync(path.dirname(this.dataDir), { recursive: true });
        }
      } catch (err) {
        reject(err);
        return;
      }
      const serveEnv = { ...process.env, ...this.env, OPENCODE_DB: this.dataDir };
      delete serveEnv.CLAUDE_CONFIG_DIR;
      if (this.configContent) {
        try {
          const identity = crypto.createHash("sha256").update(serveSignature(this)).digest("hex");
          const cfgPath = path.join(path.dirname(this.dataDir), `opencode-config-${identity}.json`);
          fs.writeFileSync(cfgPath, this.configContent, { mode: 0o600 });
          this._configPath = cfgPath;
          serveEnv.OPENCODE_CONFIG = cfgPath;
          delete serveEnv.OPENCODE_CONFIG_CONTENT;
        } catch (err) {
          reject(err);
          return;
        }
      }
      // --print-logs --log-level ERROR routes OpenCode's own error logs (incl.
      // the "failed ref=err_… error=… cause=…" line the HTTP error middleware
      // emits for 500s like the session.summarize failure) to STDERR at
      // error-level only (low noise). Combined with the un-truncated stderr
      // capture below, the real upstream cause lands in Lily's log instead of
      // being swallowed into an opaque "Unexpected server error" ref.
      const child = spawn(
        this.serverCommand,
        ["serve", "--hostname", this.host, "--port", "0", "--print-logs", "--log-level", "ERROR"],
        {
          cwd: this.cwd,
          env: serveEnv,
          stdio: ["ignore", "pipe", "pipe"],
          // POSIX: own process group so terminate() can reap the whole tool
          // tree via kill(-pid). Windows uses taskkill /T instead.
          detached: process.platform !== "win32",
          windowsHide: true,
        },
      );
      this.process = child;
      let settled = false;
      const settle = (fn) => {
        if (settled) return;
        settled = true;
        fn();
      };
      const timer = setTimeout(
        () => settle(() => reject(new Error("opencode serve did not report a listening port in time"))),
        timeoutMs,
      );
      let buf = "";
      const onStdout = (chunk) => {
        buf += chunk.toString();
        const hit = parseListeningPort(buf);
        if (!hit) return;
        this.host = hit.host;
        this.port = hit.port;
        child.stdout.off("data", onStdout);
        settle(async () => {
          clearTimeout(timer);
          try {
            const { createOpencodeClient } = await loadSdk();
            this._createOpencodeClient = createOpencodeClient;
            this._baseClient = createOpencodeClient({ baseUrl: this.baseUrl });
            this._startEventStream();
            await this._waitForEventStreamReady();
            log.info("shared opencode serve ready on %s (cwd %s)", this.baseUrl, this.cwd);
            resolve(this);
          } catch (err) {
            reject(err);
          }
        });
      };
      child.stdout.on("data", onStdout);
      child.stderr.on("data", (c) => {
        // Do NOT truncate: the serve only prints ERROR-level logs here (see the
        // --log-level ERROR flag), so volume is low and the full text carries the
        // real cause of failures like session.summarize 500s.
        const text = c.toString().trim();
        if (text) log.warn("serve stderr: %s", text.slice(0, 4000));
      });
      child.on("exit", (code) => {
        this._baseClient = null;
        this._clients.clear();
        this.process = null;
        this._starting = null;
        this._flushEvents();
        this.emit("exit", { code });
        this.terminate();
        settle(() => {
          clearTimeout(timer);
          reject(new Error(`opencode serve exited before listening (code ${code})`));
        });
      });
      child.on("error", (err) => {
        if (!this._terminated) this.emit("error", err);
        settle(() => {
          clearTimeout(timer);
          reject(err);
        });
      });
    });
    return this._starting;
  }

  /** Per-directory SDK client (cached) — the official `sdkFor(directory)`. */
  clientFor(directory) {
    const key = directory || this.cwd;
    let client = this._clients.get(key);
    if (!client) {
      client = this._createOpencodeClient({ baseUrl: this.baseUrl, directory: key });
      this._clients.set(key, client);
    }
    return client;
  }

  /** Register a demux handler. Receives (directory, event) for every server event;
   *  the caller filters by its own directory + sessionID. Returns an unsubscribe fn. */
  onEvent(handler) {
    this._eventHandlers.add(handler);
    return () => this._eventHandlers.delete(handler);
  }

  diagnostics() {
    return {
      baseUrl: this._baseClient ? this.baseUrl : "",
      activeViews: this._activeViews,
      activeWork: this._activeWork,
      queuedEvents: this._eventQueue.length,
      eventStats: {
        received: this._eventStats.received,
        delivered: this._eventStats.delivered,
        coalesced: this._eventStats.coalesced,
        droppedStaleDelta: this._eventStats.droppedStaleDelta,
        lastReceivedAt: this._eventStats.lastReceivedAt,
        lastDeliveredAt: this._eventStats.lastDeliveredAt,
        byType: Object.fromEntries(this._eventStats.byType.entries()),
      },
      recentEvents: [...this._recentEvents],
    };
  }

  _recordReceived(directory, event) {
    const type = String(event?.type || "");
    this._eventStats.received += 1;
    this._eventStats.lastReceivedAt = Date.now();
    this._eventStats.byType.set(type, (this._eventStats.byType.get(type) || 0) + 1);
    this._recentEvents.push({
      direction: "received",
      ts: this._eventStats.lastReceivedAt,
      directory: directory || "",
      type,
      sessionID: event?.properties?.sessionID || event?.properties?.part?.sessionID || event?.properties?.info?.sessionID || "",
      messageID: event?.properties?.messageID || event?.properties?.part?.messageID || event?.properties?.info?.id || "",
      partID: event?.properties?.partID || event?.properties?.part?.id || "",
    });
    if (this._recentEvents.length > 80) this._recentEvents.splice(0, this._recentEvents.length - 80);
  }

  _recordDelivered(directory, event) {
    this._eventStats.delivered += 1;
    this._eventStats.lastDeliveredAt = Date.now();
    this._recentEvents.push({
      direction: "delivered",
      ts: this._eventStats.lastDeliveredAt,
      directory: directory || "",
      type: String(event?.type || ""),
      sessionID: event?.properties?.sessionID || event?.properties?.part?.sessionID || event?.properties?.info?.sessionID || "",
      messageID: event?.properties?.messageID || event?.properties?.part?.messageID || event?.properties?.info?.id || "",
      partID: event?.properties?.partID || event?.properties?.part?.id || "",
    });
    if (this._recentEvents.length > 80) this._recentEvents.splice(0, this._recentEvents.length - 80);
  }

  _deltaKey(directory, messageID, partID) {
    return `${directory || "global"}:${messageID || ""}:${partID || ""}`;
  }

  _coalesceKey(directory, event) {
    if (event?.type === "session.status") {
      return `session.status:${directory || "global"}:${event.properties?.sessionID || ""}`;
    }
    if (event?.type === "lsp.updated") return `lsp.updated:${directory || "global"}`;
    if (event?.type === "message.part.updated") {
      const part = event.properties?.part || {};
      return `message.part.updated:${directory || "global"}:${part.messageID || ""}:${part.id || ""}`;
    }
    if (event?.type === "message.part.delta") {
      const p = event.properties || {};
      return `message.part.delta:${this._deltaKey(directory, p.messageID, p.partID)}:${p.field || ""}`;
    }
    return "";
  }

  _enqueueEvent(directory, event) {
    if (!event?.type || event.type === "sync") return;
    this._recordReceived(directory, event);
    const key = this._coalesceKey(directory, event);
    if (event.type === "message.part.delta" && key) {
      const existingIndex = this._deltaCoalesced.get(key);
      const existing = existingIndex === undefined ? null : this._eventQueue[existingIndex];
      if (existing && existing.event?.type === "message.part.delta") {
        existing.event = {
          ...existing.event,
          properties: {
            ...(existing.event.properties || {}),
            delta: String(existing.event.properties?.delta || "") + String(event.properties?.delta || ""),
          },
        };
        this._eventStats.coalesced += 1;
        this._scheduleEventFlush();
        return;
      }
      this._deltaCoalesced.set(key, this._eventQueue.length);
      this._eventQueue.push({ directory, event });
      this._scheduleEventFlush();
      return;
    }

    this._deltaCoalesced.clear();
    if (key) {
      const existingIndex = this._coalesced.get(key);
      if (existingIndex !== undefined) {
        this._eventQueue[existingIndex] = { directory, event };
        if (event.type === "message.part.updated") {
          const part = event.properties?.part || {};
          this._staleDeltas.add(this._deltaKey(directory, part.messageID, part.id));
        }
        this._eventStats.coalesced += 1;
        this._scheduleEventFlush();
        return;
      }
      this._coalesced.set(key, this._eventQueue.length);
    }
    this._eventQueue.push({ directory, event });
    this._scheduleEventFlush();
  }

  _startEventStream() {
    if (!this._eventStreamReadyPromise) {
      this._eventStreamReadyPromise = new Promise((resolve, reject) => {
        this._resolveEventStreamReady = resolve;
        this._rejectEventStreamReady = reject;
      });
      void this._subscribeEvents();
    }
    return this._eventStreamReadyPromise;
  }

  _markEventStreamReady() {
    if (this._eventStreamReady) return;
    this._eventStreamReady = true;
    try { this._resolveEventStreamReady?.(); } catch { /* best effort */ }
  }

  async _waitForEventStreamReady(timeoutMs = Number(process.env.LILY_OPENCODE_EVENT_READY_TIMEOUT_MS) || 5_000) {
    if (this._eventStreamReady) return true;
    if (!this._eventStreamReadyPromise) this._startEventStream();
    let timer = null;
    try {
      await Promise.race([
        this._eventStreamReadyPromise,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error("opencode event stream did not become ready in time")), timeoutMs);
          timer.unref?.();
        }),
      ]);
      return true;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  _scheduleEventFlush() {
    if (this._eventTimer) return;
    const elapsed = Date.now() - this._lastFlushAt;
    this._eventTimer = setTimeout(() => this._flushEvents(), Math.max(0, 16 - elapsed));
  }

  _flushEvents() {
    if (this._eventTimer) {
      clearTimeout(this._eventTimer);
      this._eventTimer = null;
    }
    if (!this._eventQueue.length) return;
    const events = this._eventQueue;
    const staleDeltas = new Set(this._staleDeltas);
    this._eventQueue = [];
    this._coalesced.clear();
    this._deltaCoalesced.clear();
    this._staleDeltas.clear();
    this._lastFlushAt = Date.now();

    for (const { directory, event } of events) {
      if (event?.type === "message.part.delta") {
        const p = event.properties || {};
        if (staleDeltas.has(this._deltaKey(directory, p.messageID, p.partID))) {
          this._eventStats.droppedStaleDelta += 1;
          continue;
        }
      }
      this._recordDelivered(directory, event);
      for (const handler of this._eventHandlers) {
        try {
          handler(directory, event);
        } catch (err) {
          log.warn("event handler threw: %s", err?.message || err);
        }
      }
    }
  }

  /** Consume the single global event stream and fan out to handlers. Mirrors the
   *  official `serverSDK.event.listen`: each event carries `name` (directory) and
   *  `details` (the event, whose properties include sessionID). Auto-reconnects. */
  async _subscribeEvents() {
    if (this._terminated || !this._baseClient) return;
    try {
      // Global SSE — every event across all directories, tagged with `name`
      // (directory) + `details`. Same stream the official client listens on.
      this._sseAbort = new AbortController();
      const result = await this._baseClient.global.event({ signal: this._sseAbort.signal });
      this._markEventStreamReady();
      this._sseRetries = 0;
      // Raw global-stream frame shape: { directory, project, payload:{ id, type,
      // properties:{ sessionID, info, ... } } }. Demux on `directory` + the event's
      // properties.sessionID; hand `payload` (the actual event) to listeners.
      for await (const ev of result.stream) {
        const directory = ev?.directory;
        const event = ev?.payload ?? ev;
        this._enqueueEvent(directory, event);
      }
    } catch (err) {
      if (this._terminated) return;
      log.warn("event stream error: %s", err?.message || err);
    }
    // Stream ended/failed — reconnect with backoff while the serve is alive.
    // Do NOT emit a fatal shared-server error for event-stream reconnect churn:
    // that broadcasts to every attached session and can fail unrelated active
    // turns. The official desktop client keeps retrying the global event stream;
    // actual process death is still reported by child exit/error and per-turn
    // health probes.
    if (this._terminated || !this._baseClient) return;
    this._sseRetries += 1;
    const delay = Math.min(5000, 250 * this._sseRetries);
    setTimeout(() => this._subscribeEvents(), delay);
  }

  terminate() {
    this._terminated = true;
    this._sseAbort?.abort();
    this._flushEvents();
    this._eventHandlers.clear();
    this._clients.clear();
    this._baseClient = null;
    const child = this.process;
    this.process = null;
    killProcessTree(child); // reap the serve + its tool children (unlock the dir)
    if (this._configPath) {
      try { fs.unlinkSync(this._configPath); } catch { /* best-effort credential cleanup */ }
      this._configPath = null;
    }
  }
}

// ---------------------------------------------------------------------------
// Share by complete execution profile. Different model/tool policies coexist
// while their sessions are attached; the most recent profile stays warm and
// older profiles retire after their last view detaches.
// ---------------------------------------------------------------------------
let _singleton = null;
const _profiles = new Map();

/** Signature of the serve-defining opts. If these change (the user switched
 *  model / gateway / skills, so providers + MCP differ), the running serve is
 *  stale and must be rebuilt — otherwise it keeps talking to the OLD gateway and
 *  every turn fails to reach the model. Env matters too: short-lived gateway
 *  tokens are injected via LILY_* env, not the config JSON. */
function processProfileEnv(env = {}) {
  // Legacy Claude guide directories are conversation-scoped, not OpenCode config.
  const profile = { ...env };
  delete profile.CLAUDE_CONFIG_DIR;
  return profile;
}

function envSignature(env = {}) {
  const keys = Object.keys(processProfileEnv(env)).sort();
  const stable = {};
  for (const key of keys) stable[key] = String(env[key] ?? "");
  return crypto.createHash("sha256").update(JSON.stringify(stable)).digest("hex");
}

function serveSignature(opts) {
  return JSON.stringify({
    cmd: opts.serverCommand || "",
    dataDir: opts.dataDir || "",
    cfg: opts.configContent || "",
    env: envSignature(opts.env || {}),
  });
}

/** Reuse a compatible serve without mutating another conversation's policy. */
function getSharedServer(opts) {
  const sig = serveSignature(opts);
  for (const [key, server] of _profiles) if (server._terminated) _profiles.delete(key);
  const existing = _profiles.get(sig);
  if (existing === _singleton) return existing;
  if (_singleton && !_singleton._terminated) {
    _singleton.retireWhenIdle();
  }
  _singleton = existing || new OpencodeSharedServer(opts);
  _singleton._retireWhenIdle = false;
  _singleton._sig = sig;
  _profiles.set(sig, _singleton);
  return _singleton;
}

/** Tear the shared serve down (app quit / hard reset). */
function resetSharedServer() {
  for (const server of _profiles.values()) {
    try {
      server.terminate();
    } catch {
      /* best effort */
    }
  }
  _profiles.clear();
  _singleton = null;
}

module.exports = { OpencodeSharedServer, getSharedServer, resetSharedServer, parseListeningPort, killProcessTree };
