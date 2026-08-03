"use strict";

/**
 * Per-session VIEW over the app's single shared `opencode serve`.
 *
 * Architecture (matches the official desktop client): ONE serve hosts every
 * session across every directory. This class no longer spawns a process — it
 * acquires the shared serve (OpencodeSharedServer singleton) and scopes all of
 * its calls to this session's directory via the `X-OpenCode-Directory` header,
 * and to this session's id by filtering the shared event stream. It remains the
 * transport only; raw events are reduced by opencode-runtime-reducer in the
 * session runner. (Previously: one serve per session with an isolated
 * OPENCODE_DB — replaced because that didn't scale and diverged from upstream,
 * which is multi-session/multi-directory on a single serve.)
 *
 * All session/control calls go through the official SDK via opencode-sdk-session.
 * This class only owns session view lifecycle and global-event demux.
 */

const { EventEmitter } = require("node:events");
const { getLogger } = require("../logger");
const { getSharedServer } = require("./opencode-shared-server");
const { buildOpencodePromptBody, characterApplicationOf } = require("./opencode-message-parts");
const { createOpencodeSdkSession } = require("./opencode-sdk-session");
const { classifyOpencodeEventOwnership } = require("./opencode-event-ownership");

const log = getLogger("opencode-server");

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
    /** @type {Set<string>} messageIDs known to belong to this session — used to
     *  route session-less events (message.part.delta) on a shared serve. */
    this._ownedMessages = new Set();
    this._childSessionIDs = new Set();
    this._terminated = false;
    this._sdkSession = null;
    this._releaseSharedView = null;
    this.lastPromptText = "";
    this._routingStats = { delivered: 0, dropped: 0, byReason: new Map() };
    this._recentRouting = [];
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
    if (!this._releaseSharedView) this._releaseSharedView = shared.retainView();
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

    try {
      await shared.ensureStarted({ timeoutMs });
      this.host = shared.host;
      this.port = shared.port;
      this.process = shared.process; // for isAlive() liveness probes
      this._sdkSession = createOpencodeSdkSession(shared.clientFor(this.cwd), this.cwd);
      log.info("session bound to shared serve %s (dir %s)", this.baseUrl, this.cwd);
      return { host: this.host, port: this.port };
    } catch (err) {
      if (this._releaseSharedView) {
        try { this._releaseSharedView(); } catch { /* best effort */ }
        this._releaseSharedView = null;
      }
      throw err;
    }
  }

  /** Resume the prior session if its DB row survived (persistent OPENCODE_DB),
   *  else create a fresh one. Instance API: POST /session returns {id} at top level;
   *  GET /session/:id confirms an existing session. */
  async createSession() {
    if (!this._sdkSession) throw new Error("opencode SDK session is not ready");
    if (this.resumeSessionID) {
      try {
        const existing = await this._sdkSession.get(this.resumeSessionID);
        if (existing && existing.id) {
          this.sessionID = existing.id;
          this.wasResumed = true;
          return existing.id;
        }
      } catch {
        /* not found in this DB -> fall through to a fresh session */
      }
    }
    // Match the official desktop flow: create only the session row; choose
    // agent/model per promptAsync. OpenCode's session.create schema uses
    // model.id, while promptAsync uses model.modelID. Passing our prompt model
    // shape at create time breaks fresh sessions while resumed sessions work.
    const res = await this._sdkSession.create();
    const id = res?.id;
    if (!id) throw new Error("session create returned no id");
    this.sessionID = id;
    this.wasResumed = false;
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
      const ownership = classifyOpencodeEventOwnership({
        directory,
        cwd: this.cwd,
        event,
        sessionID: this.sessionID,
        ownedMessages: this._ownedMessages,
      });
      this._recordRoutingDecision(directory, event, ownership);
      if (ownership.rememberMessage) this._ownedMessages.add(ownership.rememberMessage);
      if (ownership.action === "drop" && ownership.reason === "different_session" && this._childSessionIDs.has(ownership.sid)) {
        this._recordRoutingDecision(directory, event, { ...ownership, action: "deliver", scope: "child_session", reason: "known_child_session" });
        this.emit("event", { ...event, __lilySubagentSessionID: ownership.sid });
        return;
      }
      if (ownership.action === "deliver") {
        this.emit("event", event);
      }
    });
  }

  allowChildSession(sessionID) {
    const id = String(sessionID || "").trim();
    if (!id || id === this.sessionID) return false;
    this._childSessionIDs.add(id);
    return true;
  }

  _recordRoutingDecision(directory, event, ownership) {
    const delivered = ownership?.action === "deliver";
    if (delivered) this._routingStats.delivered += 1;
    else this._routingStats.dropped += 1;
    const reason = ownership?.reason || "unknown";
    this._routingStats.byReason.set(reason, (this._routingStats.byReason.get(reason) || 0) + 1);
    this._recentRouting.push({
      ts: Date.now(),
      action: ownership?.action || "drop",
      scope: ownership?.scope || "",
      reason,
      directory: directory || "",
      type: String(event?.type || ""),
      sessionID: ownership?.sid || event?.properties?.sessionID || event?.properties?.part?.sessionID || event?.properties?.info?.sessionID || "",
      messageID: ownership?.mid || event?.properties?.messageID || event?.properties?.part?.messageID || event?.properties?.info?.id || "",
    });
    if (this._recentRouting.length > 120) this._recentRouting.splice(0, this._recentRouting.length - 120);
  }

  async sendPrompt({ text, files, guidance, allowImageFileParts, allowedFilePartMimes, characterContext, onCharacterApplication }) {
    if (!this.sessionID) throw new Error("no session");
    if (!this._sdkSession) throw new Error("opencode SDK session is not ready");
    // Non-image file-part support is opt-in per model (default: none). Resolve
    // from the active preset when the caller didn't pass it, fail-safe to [].
    let filePartMimes = Array.isArray(allowedFilePartMimes) ? allowedFilePartMimes : null;
    if (!filePartMimes) {
      try { filePartMimes = require("../model-presets").activePresetFilePartMimes(); }
      catch { filePartMimes = []; }
    }

    // Top-tier ingestion: a huge pasted message is a data dump, not a prompt.
    // Stage it to a workspace file and send a compact directive + preview so the
    // model RETRIEVES from it (lily_file_intelligence) instead of us dumping the
    // whole thing into the context window. Only bites above a high threshold
    // (normal messages untouched); fail-open leaves the text unchanged.
    let promptText = text;
    try {
      const { stageLargeInputText } = require("../large-input-staging");
      const staged = stageLargeInputText({
        text: promptText,
        cwd: this.cwd,
        grade: this.env?.LILY_MODEL_CAPABILITY_GRADE,
      });
      if (staged.staged && staged.text) promptText = staged.text;
    } catch {
      /* fail open — send the original text */
    }
    // prompt_async forks the turn in the BACKGROUND and returns 204 immediately;
    // the turn is driven entirely by SSE (session.idle -> turn_result, session.error
    // -> runtime_error). The old blocking /message held one request open for the
    // whole turn — fine for a per-session serve, but on the SHARED serve that
    // serialized turns (a long turn in one session blocked every other session's
    // prompt). Async returns at once, so sessions run truly concurrently.
    const body = buildOpencodePromptBody({
      text: promptText,
      files,
      guidance,
      agent: this.agent,
      model: this.model,
      maxSystemPromptChars: this.env?.LILY_OPENCODE_SYSTEM_PROMPT_MAX_CHARS,
      allowImageFileParts: allowImageFileParts === true,
      allowedFilePartMimes: filePartMimes,
      characterContext: characterContext || null,
      capabilityGrade: this.env?.LILY_MODEL_CAPABILITY_GRADE || "",
    });
    if (typeof onCharacterApplication === "function") {
      try {
        onCharacterApplication(characterApplicationOf(body));
      } catch {
        // Application telemetry is observational and cannot block dispatch.
      }
    }
    const textPart = body.parts.find((part) => part?.type === "text");
    this.lastPromptText = typeof textPart?.text === "string" ? textPart.text : "";
    return this._sdkSession.promptAsync(this.sessionID, body);
  }

  /**
   * @param {string} requestID
   * @param {{ reply: "once"|"always"|"reject", message?: string }} decision
   */
  async respondPermission(requestID, decision, opts = {}) {
    const sessionID = opts.sessionID || opts.sessionId || this.sessionID;
    if (!sessionID) throw new Error("no session");
    if (!this._sdkSession) throw new Error("opencode SDK session is not ready");
    return this._sdkSession.respondPermission(sessionID, requestID, decision);
  }

  /**
   * Answer a `question` tool prompt. Instance route: POST /question/:id/reply,
   * scoped by ?directory=. Body { answers: string[][] } (one array per question).
   * @param {string} requestID
   * @param {string[][]} answers
   */
  async respondQuestion(requestID, answers) {
    if (!this._sdkSession) throw new Error("opencode SDK session is not ready");
    return this._sdkSession.respondQuestion(requestID, answers);
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
    if (!this._sdkSession) throw new Error("opencode SDK session is not ready");
    return this._sdkSession.revert(this.sessionID, messageID);
  }

  /** Restore all previously reverted messages (undo a rewind). */
  async unrevert() {
    if (!this.sessionID) throw new Error("no session");
    if (!this._sdkSession) throw new Error("opencode SDK session is not ready");
    return this._sdkSession.unrevert(this.sessionID);
  }

  async fork(messageID) {
    if (!this.sessionID) throw new Error("no session");
    if (!messageID) throw new Error("fork needs a messageID");
    if (!this._sdkSession) throw new Error("opencode SDK session is not ready");
    return this._sdkSession.fork(this.sessionID, messageID);
  }

  /** Liveness probe — GET /global/health with a short timeout. True = the server
   *  answered healthy; false = dead, wedged, or unreachable. Used to distinguish a
   *  genuinely stuck server from a model that's just thinking quietly. */
  async checkHealth() {
    if (!this.baseUrl) return false;
    try {
      if (!this._sdkSession) return false;
      const res = await this._sdkSession.health();
      return Boolean(res && res.healthy);
    } catch {
      return false;
    }
  }

  async getSessionStatus() {
    if (!this.sessionID || !this._sdkSession?.status) return "unknown";
    try {
      const status = await this._sdkSession.status();
      const item = status?.[this.sessionID];
      if (!item) return "unknown";
      return item.type === "idle" ? "idle" : "busy";
    } catch (err) {
      log.warn("session status check failed (%s); status unknown", err?.message || err);
      return "unknown";
    }
  }

  async isSessionIdle() {
    return (await this.getSessionStatus()) === "idle";
  }

  async messages(opts = {}) {
    if (!this.sessionID) throw new Error("no session");
    if (!this._sdkSession?.messages) throw new Error("opencode SDK session is not ready");
    return this._sdkSession.messages(this.sessionID, opts);
  }

  async summarize(body = {}) {
    if (!this.sessionID) throw new Error("no session");
    if (!this._sdkSession?.summarize) throw new Error("opencode SDK session is not ready");
    return this._sdkSession.summarize(this.sessionID, body);
  }

  diagnostics() {
    return {
      sessionID: this.sessionID || "",
      cwd: this.cwd || "",
      baseUrl: this.baseUrl,
      routing: {
        delivered: this._routingStats.delivered,
        dropped: this._routingStats.dropped,
        byReason: Object.fromEntries(this._routingStats.byReason.entries()),
        recent: [...this._recentRouting],
      },
      childSessionIDs: [...this._childSessionIDs],
      shared: this._shared?.diagnostics?.() || null,
    };
  }

  /** Best-effort graceful abort; terminate() is the guaranteed stop. */
  async abort() {
    if (!this.sessionID) return false;
    try {
      if (!this._sdkSession) return false;
      await this._sdkSession.abort(this.sessionID);
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
    if (this._releaseSharedView) {
      try { this._releaseSharedView(); } catch { /* best effort */ }
      this._releaseSharedView = null;
    }
    this._shared = null;
    this._sdkSession = null;
    this._ownedMessages.clear();
    this.process = null;
  }
}

module.exports = {
  OpencodeServerManager,
};
