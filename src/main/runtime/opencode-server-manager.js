"use strict";

/**
 * Per-session VIEW over the app's single shared `opencode serve`.
 *
 * Architecture (matches the official desktop client): ONE serve hosts every
 * session across every directory. This class no longer spawns a process — it
 * acquires the shared serve (OpencodeSharedServer singleton) and scopes all of
 * its calls to this session's directory via the `X-OpenCode-Directory` header,
 * and to this session's id by filtering the shared event stream. It remains the
 * transport only; turning events into the host's action vocabulary is
 * OpencodeEventAdapter's job. (Previously: one serve per session with an
 * isolated OPENCODE_DB — replaced because that didn't scale and diverged from
 * upstream, which is multi-session/multi-directory on a single serve.)
 *
 * Wire contracts confirmed from vendored source (opencode/packages/server):
 *   POST /session                              {} -> { id, directory, ... }   (honors X-OpenCode-Directory)
 *   POST /session/:id/message                  { agent, model?, parts } — runs the turn
 *   POST /session/:id/permissions/:rid         { response:"once"|"always"|"reject", message? }
 *   shared global event stream                 demuxed by directory + sessionID
 *   POST /session/:id/abort                    best-effort; terminate() just detaches this view
 */

const { EventEmitter } = require("node:events");
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { getLogger } = require("../logger");
const { getSharedServer } = require("./opencode-shared-server");

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
  // Lily's AGENT.md guidance (identity + rules + enabled skills), injected once
  // on the session's first message as the leading instruction part — per-session
  // by construction, so a single shared serve needs no per-session agent config.
  const guidance = typeof opts.guidance === "string" ? opts.guidance.trim() : "";
  if (guidance) parts.push({ type: "text", text: guidance });
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
    /** @type {OpencodeSharedServer|null} the shared serve this session is bound to */
    this._shared = null;
    /** @type {(()=>void)|null} unsubscribe from the shared event stream */
    this._unsub = null;
    this._terminated = false;
  }

  get baseUrl() {
    if (this._shared) return this._shared.baseUrl;
    return `http://${this.host}:${this.port}`;
  }

  /** Acquire the app's shared serve (start it on first use) instead of spawning
   *  a per-session process. The first caller's opts define the serve; this
   *  session is scoped onto it purely by its `cwd` (the X-OpenCode-Directory
   *  header on every request) + its own sessionID. Mirrors the official desktop
   *  client: one serve, many directories, many sessions. */
  async start({ timeoutMs = 20_000 } = {}) {
    const shared = getSharedServer({
      serverCommand: this.serverCommand,
      cwd: this.cwd, // serve root for the first caller; per-session dir is per-request
      dataDir: this.dataDir,
      env: this.env,
      configContent: this.configContent,
    });
    this._shared = shared;

    // A crash of the shared serve is a crash for every session on it: re-emit
    // "exit"/"error" so each session's existing crash handling still fires.
    this._onSharedExit = ({ code }) => {
      this.process = null;
      if (!this._terminated) this.emit("exit", { code });
    };
    this._onSharedError = (err) => {
      if (!this._terminated) this.emit("error", err);
    };
    shared.on("exit", this._onSharedExit);
    shared.on("error", this._onSharedError);

    await shared.ensureStarted({ timeoutMs });
    this.host = shared.host;
    this.port = shared.port;
    this.process = shared.process; // for isAlive() liveness probes
    log.info("session bound to shared serve %s (dir %s)", this.baseUrl, this.cwd);
    return { host: this.host, port: this.port };
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
            // Scope every instance-API call to THIS session's directory on the
            // shared serve (verified: /session, /session/:id/* honor this header).
            ...(this.cwd ? { "X-OpenCode-Directory": this.cwd } : {}),
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
          this.wasResumed = true; // history already holds the skill guidance
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
    this.wasResumed = false; // fresh session — guidance must be injected once
    return id;
  }

  /** Attach to the shared serve's single event stream and re-emit only the
   *  events for THIS session — events tagged with our directory and either no
   *  sessionID (directory-level) or our own sessionID. The shared server owns
   *  the one SSE connection + its reconnect; we just demux. */
  subscribe() {
    if (this._unsub || !this._shared) return;
    this._unsub = this._shared.onEvent((directory, event) => {
      if (this._terminated) return;
      if (directory && this.cwd && directory !== this.cwd) return;
      // A directory can host multiple sessions now — never cross-feed events.
      const sid = event?.properties?.sessionID || event?.properties?.info?.sessionID;
      if (sid && this.sessionID && sid !== this.sessionID) return;
      this.emit("event", event);
    });
  }

  async sendPrompt({ text, files, guidance }) {
    if (!this.sessionID) throw new Error("no session");
    return this._request(
      "POST",
      `/session/${this.sessionID}/message`,
      buildInstanceMessageBody({ text, files, guidance, agent: this.agent, model: this.model }),
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

  /** Liveness probe — GET /global/health with a short timeout. True = the server
   *  answered healthy; false = dead, wedged, or unreachable. Used to distinguish a
   *  genuinely stuck server from a model that's just thinking quietly. */
  async checkHealth() {
    if (!this.baseUrl) return false;
    try {
      const res = await this._request("GET", "/global/health", null, {}, 5_000);
      return Boolean(res && res.healthy);
    } catch {
      return false;
    }
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

  /** Detach this session from the shared serve. Does NOT kill the serve — other
   *  sessions are still on it (the shared server is torn down on app quit via
   *  resetSharedServer). The opencode session row persists in the shared DB for
   *  resume. Best-effort abort happens via abort() before this. */
  terminate() {
    this._terminated = true;
    if (this._unsub) {
      try { this._unsub(); } catch { /* already gone */ }
      this._unsub = null;
    }
    if (this._shared) {
      try {
        if (this._onSharedExit) this._shared.off("exit", this._onSharedExit);
        if (this._onSharedError) this._shared.off("error", this._onSharedError);
      } catch { /* best effort */ }
    }
    this._shared = null;
    this.process = null;
  }
}

module.exports = {
  OpencodeServerManager,
  parseListeningAddress,
  createSseFrameParser,
  buildInstanceMessageBody,
};
