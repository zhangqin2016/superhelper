"use strict";

/**
 * Owns ONE `opencode serve` child process and drives it over HTTP + SSE.
 *
 * Architecture: one server per app session (1:1 with the previous one-CLI-per-
 * session model), each with an isolated SQLite via OPENCODE_DB, so sessions stay
 * fully isolated (env, cwd, crash blast-radius, storage) — see the design notes
 * in the engine-swap plan. This class is the transport only; turning SSE events
 * into the host's action vocabulary is OpencodeEventAdapter's job.
 *
 * Wire contracts confirmed from vendored source (opencode/packages/server):
 *   POST /api/session                          { id?, agent?, model, location } -> { data:{ id } }
 *   POST /api/session/:id/prompt               { prompt:{ text, files? }, delivery?, resume? }
 *   POST /api/session/:id/permission/:rid/reply{ reply:"once"|"always"|"reject", message? } -> 204
 *   GET  /api/event                            SSE; scope via X-OpenCode-Directory header
 *   POST /session/:id/abort                    (legacy instance API) — best-effort; terminate() is the hard stop
 */

const { EventEmitter } = require("node:events");
const { spawn } = require("node:child_process");
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { getLogger } = require("../logger");

const log = getLogger("opencode-server");

// ---------------------------------------------------------------------------
// Pure helpers (exported for unit testing — no process/network side effects).
// ---------------------------------------------------------------------------

/**
 * Parse the "server listening on <host>:<port>" line OpenCode prints on stdout.
 * Tolerant of surrounding text and an optional http:// scheme.
 * @param {string} line
 * @returns {{ host: string, port: number } | null}
 */
function parseListeningAddress(line) {
  const text = String(line || "");
  const match = text.match(/listening on\s+(?:https?:\/\/)?([^\s:]+):(\d{2,5})/i);
  if (!match) return null;
  const port = Number(match[2]);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return null;
  return { host: match[1], port };
}

/**
 * Stateful SSE frame parser. Feed raw chunks; get back fully-received events,
 * each parsed from its `data:` payload. Handles multi-line data and partial
 * chunks split across reads.
 * @returns {{ feed: (chunk: string) => Array<Record<string, unknown>> }}
 */
function createSseFrameParser() {
  let buffer = "";
  return {
    feed(chunk) {
      buffer += String(chunk || "");
      const events = [];
      let sep;
      // SSE frames are separated by a blank line (\n\n).
      while ((sep = buffer.indexOf("\n\n")) !== -1) {
        const frame = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        const data = frame
          .split("\n")
          .filter((l) => l.startsWith("data:"))
          .map((l) => l.slice(5).trimStart())
          .join("\n");
        if (!data) continue;
        try {
          events.push(JSON.parse(data));
        } catch {
          log.warn("dropped unparseable SSE frame: %s", data.slice(0, 160));
        }
      }
      return events;
    },
  };
}

const FILE_MIME = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
  ".webp": "image/webp", ".bmp": "image/bmp", ".pdf": "application/pdf", ".txt": "text/plain",
  ".md": "text/markdown", ".json": "application/json", ".csv": "text/csv",
};

/**
 * Turn one Lily file ({path,name,isImage} from the composer, or {uri,mime})
 * into an OpenCode FilePart { type:"file", mime, filename, url }. Local files
 * become base64 `data:` URLs (universally accepted), so vision/document skills
 * receive the actual bytes. Returns null if unreadable.
 */
function fileToPart(f) {
  if (!f || typeof f !== "object") return null;
  if (f.uri && f.mime) {
    return { type: "file", url: f.uri, mime: f.mime, ...(f.name ? { filename: f.name } : {}) };
  }
  const filePath = f.path || f.filePath;
  if (!filePath || !fs.existsSync(filePath)) return null;
  const ext = path.extname(filePath).toLowerCase();
  const mime = f.mime || FILE_MIME[ext] || "application/octet-stream";
  try {
    const data = fs.readFileSync(filePath).toString("base64");
    return { type: "file", mime, filename: f.name || path.basename(filePath), url: `data:${mime};base64,${data}` };
  } catch {
    return null;
  }
}

/**
 * Body for the instance API `POST /session/:id/message` — the endpoint that
 * actually RUNS the agent loop (verified: the v2 `/api/.../prompt` only admits).
 * Mirrors what the SDK/`opencode run` send: { agent, model, parts }.
 * @param {{ text: string, agent?: string, model?: {providerID:string, modelID:string}|null, files?: Array<object> }} opts
 */
function buildInstanceMessageBody(opts = {}) {
  const parts = [];
  if (Array.isArray(opts.files)) {
    for (const f of opts.files) {
      const part = fileToPart(f);
      if (part) parts.push(part);
    }
  }
  parts.push({ type: "text", text: String(opts.text || "") });
  const body = { agent: opts.agent || "build", parts };
  if (opts.model && opts.model.providerID && opts.model.modelID) {
    body.model = { providerID: opts.model.providerID, modelID: opts.model.modelID };
  }
  return body;
}

// ---------------------------------------------------------------------------
// Server manager
// ---------------------------------------------------------------------------

class OpencodeServerManager extends EventEmitter {
  /**
   * @param {{
   *   serverCommand: string,   // path to the opencode binary
   *   cwd: string,             // session working directory (== location.directory)
   *   dataDir: string,         // isolated OPENCODE_DB sqlite file path
   *   env?: Record<string,string>,
   *   model?: {providerID:string, modelID:string}|null,
   *   agent?: string|null,
   * }} opts
   */
  constructor(opts) {
    super();
    this.serverCommand = opts.serverCommand;
    this.cwd = opts.cwd;
    this.dataDir = opts.dataDir;
    this.env = opts.env || {};
    this.model = opts.model || null;
    this.agent = opts.agent || null;
    this.resumeSessionID = opts.resumeSessionID || null;
    /** Full OpenCode config JSON (written to a file, passed via OPENCODE_CONFIG —
     *  a file, not the env var, so a large config w/ inline agent prompts fits). */
    this.configContent = opts.configContent || "";

    /** @type {import('child_process').ChildProcess | null} */
    this.process = null;
    this.host = "127.0.0.1";
    this.port = 0;
    this.sessionID = null;
    this._sse = null;
    this._stdoutBuf = "";
    this._terminated = false;
  }

  get baseUrl() {
    return `http://${this.host}:${this.port}`;
  }

  /** Spawn `opencode serve` and resolve once it reports its listening port. */
  start({ timeoutMs = 20_000 } = {}) {
    return new Promise((resolve, reject) => {
      // OPENCODE_DB needs its parent dir to exist or serve dies "unable to open
      // database file"; the manager owns the data path so it owns creating it.
      try {
        if (this.dataDir && this.dataDir !== ":memory:") {
          fs.mkdirSync(path.dirname(this.dataDir), { recursive: true });
        }
      } catch (err) {
        reject(err);
        return;
      }
      // Write the (potentially large) config to a file and point OPENCODE_CONFIG
      // at it — a file has no size limit, unlike the OPENCODE_CONFIG_CONTENT env var.
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
      const args = ["serve", "--hostname", this.host, "--port", "0"];
      const child = spawn(this.serverCommand, args, {
        cwd: this.cwd,
        env: serveEnv,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
      this.process = child;

      // Settle the start() promise exactly once (ready / timeout / early death),
      // and stop parsing stdout for the listening line — but DO NOT detach the
      // exit/error handlers: they must persist for the process's whole life so a
      // crash AFTER the server is ready is still detected. (Previously they were
      // removed on ready, so a post-ready crash went unnoticed — this.process
      // stayed set, isAlive() lied, and the turn hung until the silence watchdog.)
      let startSettled = false;
      let timer = null;
      const settleStart = (fn) => {
        if (startSettled) return;
        startSettled = true;
        if (timer) clearTimeout(timer);
        child.stdout.off("data", onStdout);
        fn();
      };

      const onStdout = (chunk) => {
        this._stdoutBuf += chunk.toString();
        const lines = this._stdoutBuf.split("\n");
        this._stdoutBuf = lines.pop() || "";
        for (const line of lines) {
          const addr = parseListeningAddress(line);
          if (addr) {
            this.host = addr.host === "0.0.0.0" ? "127.0.0.1" : addr.host;
            this.port = addr.port;
            log.info("opencode serve ready on %s", this.baseUrl);
            settleStart(() => resolve({ host: this.host, port: this.port }));
            return;
          }
        }
      };
      const onStderr = (chunk) => log.warn("serve stderr: %s", chunk.toString().trim().slice(0, 200));

      timer = setTimeout(
        () => settleStart(() => reject(new Error("opencode serve did not report a listening port in time"))),
        timeoutMs,
      );

      child.stdout.on("data", onStdout);
      child.stderr.on("data", onStderr);
      // Persistent — fire for the whole process lifetime, not just startup.
      child.on("exit", (code) => {
        this.process = null;
        if (!this._terminated) this.emit("exit", { code });
        settleStart(() => reject(new Error(`opencode serve exited before listening (code ${code})`)));
      });
      child.on("error", (err) => {
        if (!this._terminated) this.emit("error", err);
        settleStart(() => reject(err));
      });
    });
  }

  /** Minimal promise wrapper over node:http for JSON request/response.
   *  timeoutMs: 0 disables the timeout — REQUIRED for the message POST, which
   *  blocks until the whole turn completes (can be minutes for long/reasoning
   *  turns); a short timeout there aborts a healthy turn as "connection interrupted". */
  _request(method, path, body, extraHeaders = {}, timeoutMs = 60_000) {
    return new Promise((resolve, reject) => {
      const payload = body == null ? null : Buffer.from(JSON.stringify(body));
      const req = http.request(
        `${this.baseUrl}${path}`,
        {
          method,
          headers: {
            accept: "application/json",
            ...(payload ? { "content-type": "application/json", "content-length": payload.length } : {}),
            ...extraHeaders,
          },
        },
        (res) => {
          let data = "";
          res.on("data", (c) => (data += c));
          res.on("end", () => {
            const status = res.statusCode || 0;
            if (status < 200 || status >= 300) {
              reject(new Error(`${method} ${path} -> ${status}: ${data.slice(0, 200)}`));
              return;
            }
            if (!data) return resolve(null);
            try {
              resolve(JSON.parse(data));
            } catch {
              resolve(null);
            }
          });
        },
      );
      req.on("error", reject);
      // Short timeout only for quick control calls; the message POST passes 0
      // (no timeout) because it stays open for the entire turn.
      if (timeoutMs > 0) {
        req.setTimeout(timeoutMs, () => req.destroy(new Error(`${method} ${path} timed out`)));
      }
      if (payload) req.write(payload);
      req.end();
    });
  }

  /** Resume the prior session if its DB row survived (persistent OPENCODE_DB),
   *  else create a fresh one. Instance API: POST /session returns {id} at top level;
   *  GET /session/:id confirms an existing session. */
  async createSession() {
    if (this.resumeSessionID) {
      try {
        const existing = await this._request("GET", `/session/${this.resumeSessionID}`);
        if (existing && existing.id) {
          this.sessionID = existing.id;
          return existing.id;
        }
      } catch {
        /* not found in this DB -> fall through to a fresh session */
      }
    }
    const res = await this._request("POST", "/session", {});
    const id = res?.id;
    if (!id) throw new Error("session create returned no id");
    this.sessionID = id;
    return id;
  }

  /** Open the SSE stream and emit one "event" per parsed server event. The
   *  instance event stream is live (not replayed); if it drops while the server
   *  is still up we auto-reconnect with backoff so long sessions stay subscribed. */
  subscribe() {
    if (this._sse) return;
    const parser = createSseFrameParser();
    const reconnect = () => {
      this._sse = null;
      if (this._terminated || !this.process) return;
      this._sseRetries = (this._sseRetries || 0) + 1;
      if (this._sseRetries > 30) {
        this.emit("error", new Error("SSE reconnect gave up after 30 attempts"));
        return;
      }
      const delay = Math.min(5000, 250 * this._sseRetries);
      this._sseTimer = setTimeout(() => this.subscribe(), delay);
    };
    const req = http.request(
      `${this.baseUrl}/event`,
      { method: "GET", headers: { accept: "text/event-stream" } },
      (res) => {
        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) this._sseRetries = 0;
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          for (const ev of parser.feed(chunk)) this.emit("event", ev);
        });
        res.on("end", reconnect);
        res.on("close", reconnect);
      },
    );
    req.on("error", () => reconnect());
    req.end();
    this._sse = req;
  }

  async sendPrompt({ text, files }) {
    if (!this.sessionID) throw new Error("no session");
    return this._request(
      "POST",
      `/session/${this.sessionID}/message`,
      buildInstanceMessageBody({ text, files, agent: this.agent, model: this.model }),
      {},
      0, // no timeout — this request blocks for the whole turn (can be minutes)
    );
  }

  /**
   * @param {string} requestID
   * @param {{ reply: "once"|"always"|"reject", message?: string }} decision
   */
  async respondPermission(requestID, decision) {
    if (!this.sessionID) throw new Error("no session");
    return this._request(
      "POST",
      `/session/${this.sessionID}/permissions/${requestID}`,
      { response: decision.reply, ...(decision.message ? { message: decision.message } : {}) },
    );
  }

  /**
   * Answer a `question` tool prompt. Instance route: POST /question/:id/reply,
   * scoped by ?directory=. Body { answers: string[][] } (one array per question).
   * @param {string} requestID
   * @param {string[][]} answers
   */
  async respondQuestion(requestID, answers) {
    const q = this.cwd ? `?directory=${encodeURIComponent(this.cwd)}` : "";
    return this._request("POST", `/question/${requestID}/reply${q}`, { answers });
  }

  /**
   * Rewind the session to a message: the engine rolls its file snapshots back to
   * that point and marks every message from it onward as reverted (dropped from
   * model context, restorable via unrevert). Reverting to an assistant message
   * undoes its whole exchange (the engine anchors to the preceding user message).
   * @param {string} messageID engine message id (msg_…)
   */
  async revert(messageID) {
    if (!this.sessionID) throw new Error("no session");
    if (!messageID) throw new Error("revert needs a messageID");
    return this._request("POST", `/session/${this.sessionID}/revert`, { messageID });
  }

  /** Restore all previously reverted messages (undo a rewind). */
  async unrevert() {
    if (!this.sessionID) throw new Error("no session");
    return this._request("POST", `/session/${this.sessionID}/unrevert`, {});
  }

  /** Best-effort graceful abort; terminate() is the guaranteed stop. */
  async abort() {
    if (!this.sessionID) return false;
    try {
      await this._request("POST", `/session/${this.sessionID}/abort`, null);
      return true;
    } catch (err) {
      log.warn("graceful abort failed (%s); caller should terminate", err.message);
      return false;
    }
  }

  terminate() {
    this._terminated = true;
    if (this._sseTimer) {
      clearTimeout(this._sseTimer);
      this._sseTimer = null;
    }
    if (this._sse) {
      try { this._sse.destroy(); } catch { /* already closed */ }
      this._sse = null;
    }
    if (this.process) {
      try { this.process.kill("SIGTERM"); } catch { /* already dead */ }
      this.process = null;
    }
  }
}

module.exports = {
  OpencodeServerManager,
  parseListeningAddress,
  createSseFrameParser,
  buildInstanceMessageBody,
};
