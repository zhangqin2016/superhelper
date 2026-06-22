"use strict";

/**
 * Shared OpenCode server — mirrors the official desktop client's `serverSDK`:
 * ONE `opencode serve` for the whole app, the official `@opencode-ai/sdk` as the
 * transport, ONE event stream demuxed by directory + sessionID, and per-directory
 * SDK clients (`createOpencodeClient({ baseUrl, directory })`, == official `sdkFor`).
 *
 * Multiple Lily sessions — across multiple directories — all live on this one
 * serve (model/agent/permission are per-request; the directory is per-client).
 * This replaces the old one-serve-per-session model.
 *
 * The SDK is ESM-only, so it's loaded via dynamic import() and cached.
 */
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { getLogger } = require("../logger");

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
    this.env = opts.env || {};
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
  }

  get baseUrl() {
    return `http://${this.host}:${this.port}`;
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
      if (this.configContent) {
        try {
          const cfgPath = path.join(path.dirname(this.dataDir), "opencode-config.json");
          fs.writeFileSync(cfgPath, this.configContent);
          serveEnv.OPENCODE_CONFIG = cfgPath;
          delete serveEnv.OPENCODE_CONFIG_CONTENT;
        } catch (err) {
          reject(err);
          return;
        }
      }
      const child = spawn(this.serverCommand, ["serve", "--hostname", this.host, "--port", "0"], {
        cwd: this.cwd,
        env: serveEnv,
        stdio: ["ignore", "pipe", "pipe"],
      });
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
            this._subscribeEvents();
            log.info("shared opencode serve ready on %s (cwd %s)", this.baseUrl, this.cwd);
            resolve(this);
          } catch (err) {
            reject(err);
          }
        });
      };
      child.stdout.on("data", onStdout);
      child.stderr.on("data", (c) => log.warn("serve stderr: %s", c.toString().trim().slice(0, 200)));
      child.on("exit", (code) => {
        const wasReady = Boolean(this._baseClient);
        this._baseClient = null;
        this._clients.clear();
        this.process = null;
        this._starting = null;
        if (!this._terminated && wasReady) this.emit("exit", { code });
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

  /** Consume the single global event stream and fan out to handlers. Mirrors the
   *  official `serverSDK.event.listen`: each event carries `name` (directory) and
   *  `details` (the event, whose properties include sessionID). Auto-reconnects. */
  async _subscribeEvents() {
    if (this._terminated || !this._baseClient) return;
    try {
      // Global SSE — every event across all directories, tagged with `name`
      // (directory) + `details`. Same stream the official client listens on.
      const result = await this._baseClient.global.event();
      this._sseRetries = 0;
      // Raw global-stream frame shape: { directory, project, payload:{ id, type,
      // properties:{ sessionID, info, ... } } }. Demux on `directory` + the event's
      // properties.sessionID; hand `payload` (the actual event) to listeners.
      for await (const ev of result.stream) {
        const directory = ev?.directory;
        const event = ev?.payload ?? ev;
        for (const handler of this._eventHandlers) {
          try {
            handler(directory, event);
          } catch (err) {
            log.warn("event handler threw: %s", err?.message || err);
          }
        }
      }
    } catch (err) {
      if (this._terminated) return;
      log.warn("event stream error: %s", err?.message || err);
    }
    // Stream ended/failed — reconnect with backoff while the serve is alive.
    if (this._terminated || !this._baseClient) return;
    this._sseRetries += 1;
    if (this._sseRetries > 30) {
      this.emit("error", new Error("event stream reconnect gave up after 30 attempts"));
      return;
    }
    const delay = Math.min(5000, 250 * this._sseRetries);
    setTimeout(() => this._subscribeEvents(), delay);
  }

  terminate() {
    this._terminated = true;
    this._eventHandlers.clear();
    this._clients.clear();
    this._baseClient = null;
    const child = this.process;
    this.process = null;
    if (child) {
      try {
        child.kill("SIGTERM");
      } catch {
        /* already dead */
      }
    }
  }
}

// ---------------------------------------------------------------------------
// App-wide singleton — model A: ONE shared serve for the whole app, hosting
// every session across every directory (official desktop client topology).
// The FIRST caller's opts (serverCommand / env / config / dataDir) define the
// serve; later callers reuse it. Config is delivered per-directory via each
// directory's .opencode/, so the shared base config only needs the providers.
// ---------------------------------------------------------------------------
let _singleton = null;

/** Signature of the serve-defining opts. If these change (the user switched
 *  model / gateway / skills, so providers + MCP differ), the running serve is
 *  stale and must be rebuilt — otherwise it keeps talking to the OLD gateway and
 *  every turn fails to reach the model. (The old one-serve-per-session model got
 *  this for free; a frozen singleton does not.) */
function serveSignature(opts) {
  return JSON.stringify({
    cmd: opts.serverCommand || "",
    cfg: opts.configContent || "",
  });
}

/** Get the app's single shared serve, creating it on first use and REBUILDING it
 *  when the serve-defining config changes (so config edits take effect, matching
 *  the official client's live per-directory config resolution). */
function getSharedServer(opts) {
  const sig = serveSignature(opts);
  if (_singleton && !_singleton._terminated && _singleton._sig === sig) {
    return _singleton;
  }
  if (_singleton && !_singleton._terminated) {
    log.info("shared serve config changed — rebuilding");
    try {
      _singleton.terminate();
    } catch {
      /* best effort */
    }
  }
  _singleton = new OpencodeSharedServer(opts);
  _singleton._sig = sig;
  return _singleton;
}

/** Tear the shared serve down (app quit / hard reset). */
function resetSharedServer() {
  if (_singleton) {
    try {
      _singleton.terminate();
    } catch {
      /* best effort */
    }
    _singleton = null;
  }
}

module.exports = { OpencodeSharedServer, getSharedServer, resetSharedServer, parseListeningPort };
