"use strict";

/**
 * OpenCode-engine session runner. Drop-in peer of AgentSession (agent-session.js)
 * for the OpenCode engine: same orchestrator integration contract —
 *   orchestrator.ingest(sessionId, drafts)         // streaming
 *   orchestrator.notifyRunnerDone(sessionId, p)    // turn finished
 *   orchestrator.notifyRunnerError(sessionId, msg) // turn failed
 *   bindOrchestrator(orchestrator)
 * and the same public methods turn-orchestrator / session-runner-pool call.
 *
 * Transport (HTTP/SSE + the serve process) is OpencodeServerManager. Raw
 * OpenCode events are reduced directly into Lily runtime drafts by
 * opencode-runtime-reducer; there is no Claude-style stream-json/action adapter
 * in this path.
 */

const { EventEmitter } = require("node:events");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");
const { OpencodeServerManager } = require("./runtime/opencode-server-manager");
const {
  createOpencodeRuntimeState,
  reduceOpencodeRuntimeEvent,
  resetOpencodeRuntimeState,
} = require("./runtime/opencode-runtime-reducer");
const { decidePermission } = require("./runtime/opencode-permission-policy");
const { truncateToolResultForUi } = require("./cli-process-payload");
const { buildToolPreviewLabel } = require("./tool-preview-label.cjs");
const { getLogger } = require("./logger");

const log = getLogger("opencode-agent-session");
const TRANSIENT_ERROR_RE = /unreachable|interrupted|socket|fetch|connection|network|ECONN|ETIMEDOUT|ENOTFOUND|timeout|temporarily unavailable|unexpected response/i;
const REPLAY_SAFE_TOOL_NAMES = new Set(["read", "glob", "grep", "list", "ls", "find", "search"]);
const DOCUMENT_RECOVERY_EXTENSIONS = new Set([
  ".pdf",
  ".doc",
  ".docx",
  ".xls",
  ".xlsx",
  ".ppt",
  ".pptx",
  ".odt",
  ".ods",
  ".odp",
  ".rtf",
]);
const TOOL_PROGRESS_STALE_MS = 10_000;
const TODO_COMPLETION_GATE_MAX_ATTEMPTS = 3;

function formatDuration(ms) {
  const total = Math.max(0, Math.floor(Number(ms || 0) / 1000));
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  if (minutes < 60) return seconds ? `${minutes}m ${seconds}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rem = minutes % 60;
  return rem ? `${hours}h ${rem}m` : `${hours}h`;
}

function compactProgressText(value = "", limit = 96) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (!text) return "";
  if (text.length <= limit) return text;
  return `${text.slice(0, Math.max(0, limit - 1))}…`;
}

function formatBytes(bytes) {
  const n = Number(bytes || 0);
  if (!Number.isFinite(n) || n < 0) return "unknown";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function fileFallbackLine(file = {}, index = 0) {
  const filePath = file.path || file.filePath || "";
  const name = file.name || (filePath ? path.basename(filePath) : `attachment-${index + 1}`);
  let stat = null;
  if (filePath) {
    try {
      stat = fs.statSync(filePath);
    } catch {
      stat = null;
    }
  }
  const size = Number.isFinite(Number(file.size))
    ? Number(file.size)
    : stat?.isFile?.()
      ? stat.size
      : null;
  return [
    `- ${name}`,
    filePath ? `  source path: ${filePath}` : "  source path: unavailable",
    file.type ? `  type: ${file.type}` : "",
    typeof file.isImage === "boolean" ? `  image: ${file.isImage ? "yes" : "no"}` : "",
    Number.isFinite(size) ? `  size: ${formatBytes(size)}` : "",
    filePath ? `  readable now: ${stat?.isFile?.() ? "yes" : "no"}` : "",
  ].filter(Boolean).join("\n");
}

function buildAttachmentFallbackManifest(files = [], reason = "") {
  const list = (Array.isArray(files) ? files : []).filter(Boolean);
  if (!list.length) return "";
  const shown = list.slice(0, 20).map((file, index) => fileFallbackLine(file, index));
  const omitted = list.length > shown.length ? `\n\n${list.length - shown.length} more attachment(s) omitted from this manifest.` : "";
  return [
    "[Attachment fallback manifest]",
    "The model file-upload request failed before the assistant could start. Continue the task inside Lily/CLI using these local source paths and available tools instead of failing the turn.",
    "Do not ask the user to re-upload unless a source path is missing or unreadable.",
    reason ? `Failure reason: ${reason}` : "",
    "",
    "Attached files:",
    shown.join("\n"),
    omitted,
  ].filter(Boolean).join("\n");
}

function buildAttachmentFallbackPromptPayload(payload = {}, reason = "") {
  const files = Array.isArray(payload.files) ? payload.files : [];
  if (!files.length || payload.attachmentFallback) return payload;
  const manifest = buildAttachmentFallbackManifest(files, reason);
  if (!manifest) return payload;
  return {
    ...payload,
    text: [String(payload.text || ""), manifest].filter(Boolean).join("\n\n"),
    files: [],
    attachmentFallback: true,
  };
}

function isDocumentRecoveryAttachment(file = {}) {
  const filePath = file.path || file.filePath || "";
  const ext = path.extname(filePath).toLowerCase() || path.extname(file.name || file.filename || "").toLowerCase();
  if (DOCUMENT_RECOVERY_EXTENSIONS.has(ext)) return true;
  const type = String(file.type || file.mime || file.mimeType || file.mediaType || "").toLowerCase();
  return /pdf|document|officedocument|msword|word|spreadsheet|excel|powerpoint|presentation/.test(type);
}

function shouldIsolateAttachmentFallback(payload = {}) {
  const files = Array.isArray(payload.files) ? payload.files : [];
  return files.some(isDocumentRecoveryAttachment);
}

function errorCauseFromEffect(effect = {}, message = "") {
  const raw = effect.cause || effect.error;
  if (raw instanceof Error) return raw;
  const err = new Error(message || "Engine error");
  if (raw && typeof raw === "object") {
    err.details = raw;
    if (raw.code) err.code = raw.code;
  }
  return err;
}

function failureCauseText(cause) {
  if (!cause) return "";
  if (typeof cause === "string") return cause;
  if (cause instanceof Error) return cause.message || "";
  if (typeof cause.message === "string") return cause.message;
  if (typeof cause.data?.message === "string") return cause.data.message;
  if (typeof cause.cause?.message === "string") return cause.cause.message;
  return "";
}

function transientClassificationText(message, cause) {
  return failureCauseText(cause) || String(message || "");
}

function isRecoverableModelConnectionFailure(classified, raw = "") {
  if (classified?.retryable === false) return false;
  if (classified && [
    "MODEL_CONNECTION_FAILED",
    "ENGINE_UNAVAILABLE",
    "MODEL_OVERLOADED",
    "RESPONSE_ERROR",
    "RATE_LIMITED",
  ].includes(classified.code)) {
    return true;
  }
  return !classified && TRANSIENT_ERROR_RE.test(String(raw || ""));
}

function rawToolFromEvent(ev = {}) {
  const p = ev.properties || {};
  if (ev.type === "message.part.updated") {
    const part = p.part || {};
    if (part.type !== "tool") return null;
    const state = part.state || {};
    const id = String(part.callID || part.id || "");
    if (!id) return null;
    return {
      id,
      name: part.tool || "unknown",
      input: state.input && typeof state.input === "object" ? state.input : {},
      title: state.title || part.title || "",
      status: state.status || "",
    };
  }
  if (String(ev.type || "").startsWith("session.next.tool.")) {
    const id = String(p.callID || p.id || "");
    if (!id) return null;
    let status = "running";
    if (ev.type === "session.next.tool.success") status = "completed";
    else if (ev.type === "session.next.tool.failed") status = "error";
    return {
      id,
      name: p.tool || p.name || "unknown",
      input: p.input && typeof p.input === "object" ? p.input : {},
      title: p.title || p.metadata?.title || "",
      status,
    };
  }
  return null;
}

// Deliverable extensions worth gating on — things the user asked to be produced.
const DELIVERABLE_EXT = "docx|xlsx|pptx|pdf|png|jpe?g|gif|webp|svg|mp3|wav|mp4|webm|html|csv|zip";
// Absolute paths only (POSIX /… or Windows X:\…) ending in a deliverable ext, so
// we never misread a relative mention or a bare filename in prose.
const DELIVERABLE_PATH_RE = new RegExp(
  String.raw`(?:^|[\s"'` + "`" + String.raw`(>])((?:/|[A-Za-z]:\\)[^\s"'` + "`" + String.raw`)<>|]+\.(?:${DELIVERABLE_EXT}))`,
  "gi",
);

/**
 * High-precision, fail-open check for a turn that claims a file deliverable which
 * is actually missing or empty. Returns { path, reason } for the first violation,
 * or null. Conservative by design: only absolute paths with a deliverable
 * extension, and only flagged when the file is genuinely absent or zero-byte.
 * @param {string} output assistant's final text for the turn
 */
function detectIncompleteDeliverable(output) {
  const text = String(output || "");
  if (!text) return null;
  const seen = new Set();
  for (const m of text.matchAll(DELIVERABLE_PATH_RE)) {
    const p = m[1];
    if (seen.has(p)) continue;
    seen.add(p);
    if (seen.size > 12) break; // bound the work
    try {
      if (!fs.existsSync(p)) return { path: p, reason: "does not exist" };
      if (fs.statSync(p).size === 0) return { path: p, reason: "is empty" };
    } catch {
      /* fail open — unreadable path is not a confident violation */
    }
  }
  return null;
}

function normalizeTodoStatus(status) {
  const value = String(status || "").trim().toLowerCase();
  if (value === "completed" || value === "done") return "completed";
  if (value === "in_progress" || value === "in-progress" || value === "running" || value === "active") return "in_progress";
  return "pending";
}

function todoTitle(todo = {}, index = 0) {
  return String(todo.content || todo.activeForm || todo.title || todo.text || `Todo ${index + 1}`)
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 180);
}

function nativeTodoSnapshot(todos = []) {
  const normalized = (Array.isArray(todos) ? todos : [])
    .map((todo, index) => ({
      title: todoTitle(todo, index),
      status: normalizeTodoStatus(todo?.status),
    }))
    .filter((todo) => todo.title);
  const unfinished = normalized.filter((todo) => todo.status !== "completed");
  return {
    total: normalized.length,
    completed: normalized.length - unfinished.length,
    unfinished,
  };
}

function buildTodoContinuationPrompt(snapshot = {}, attempt = 1, maxAttempts = TODO_COMPLETION_GATE_MAX_ATTEMPTS) {
  const unfinished = Array.isArray(snapshot.unfinished) ? snapshot.unfinished : [];
  const listed = unfinished.slice(0, 12).map((todo, index) => (
    `${index + 1}. [${todo.status || "pending"}] ${todo.title}`
  ));
  if (unfinished.length > listed.length) listed.push(`...and ${unfinished.length - listed.length} more`);
  return [
    "Task continuity check: the native todo list still has unfinished todo items.",
    `Progress: ${snapshot.completed || 0}/${snapshot.total || 0} completed. Continue from the current unfinished item and do not stop after a partial todo update.`,
    "Use tools as needed. When the requested work is genuinely complete, update every todo item to completed, then provide the final answer.",
    `Continuation attempt: ${attempt}/${maxAttempts}.`,
    "Unfinished todo items:",
    ...listed,
  ].join("\n");
}

function messageTextFromOpenCodeItem(item = {}) {
  return (Array.isArray(item?.parts) ? item.parts : [])
    .filter((part) => part?.type === "text" && !part.ignored && typeof part.text === "string")
    .map((part) => part.text)
    .join("")
    .trim();
}

function messageCreatedMs(info = {}) {
  const created = Number(info.time?.created || info.created || 0);
  return Number.isFinite(created) && created > 0 ? created : null;
}

function messageCompletedMs(info = {}) {
  const completed = Number(info.time?.completed || info.completed || 0);
  return Number.isFinite(completed) && completed > 0 ? completed : null;
}

function isReplaySafeToolName(name) {
  const value = String(name || "").trim().toLowerCase();
  if (!value) return false;
  if (REPLAY_SAFE_TOOL_NAMES.has(value)) return true;
  return [...REPLAY_SAFE_TOOL_NAMES].some((safe) => value === `tool.${safe}` || value.endsWith(`.${safe}`));
}

function isTurnOwnedEngineEvent(ev) {
  const type = String(ev?.type || "");
  const props = ev?.properties || {};
  if (type.startsWith("message.")) return true;
  if (type.startsWith("permission.") || type.startsWith("question.")) return true;
  if (type.startsWith("session.")) {
    return Boolean(props.sessionID || props.sessionId || props.info?.id || props.session?.id);
  }
  return false;
}

class OpencodeAgentSession extends EventEmitter {
  static INTERRUPT_ABORT_TIMEOUT_MS = 5_000;

  /**
   * @param {string} sessionId App session id (not the OpenCode server session id).
   * @param {{ createServer?: (opts: object) => OpencodeServerManager }} [deps] Injectable for tests.
   */
  constructor(sessionId, deps = {}) {
    super();
    this.sessionId = sessionId;
    this._createServer = deps.createServer || ((opts) => new OpencodeServerManager(opts));
    /** @type {OpencodeServerManager | null} */
    this._server = null;
    this._eventState = createOpencodeRuntimeState();
    this._subagentEventStates = new Map();
    this._knownSubagentSessionIDs = new Set();
    this.cwd = null;
    this.spawnOptions = null;
    this.agentResumeId = null;
    this.busy = false;
    this._abortSettling = false;
    this._turnSettled = true;
    this._starting = null;
    this._sawActivity = false;
    this._sawEngineEvent = false;
    this._sawToolActivity = false;
    this._sawUnsafeToolActivity = false;
    this._toolReplaySafe = new Map();
    this._activeTools = new Map();
    this._lastGenericToolProgressNotice = "";
    this.collectedOutput = "";
    /** Completion gate (Pillar 3-B) fires at most ONCE per turn — guards against loops. */
    this._gatedThisTurn = false;
    this._latestTodos = [];
    this._latestTodosSignature = "";
    this._todoCompletionGateAttempts = 0;
    /** @type {Map<string, { rawRequestId: string, sessionID: string }>} pending permission request ids awaiting a host reply. */
    this._pendingPermissions = new Map();
    /** @type {Map<string, { questions: Array, rawRequestId: string, sessionID: string }>} pending question id -> its questions (for answer mapping). */
    this._pendingQuestions = new Map();
    this._orchestrator = null;
    /** @type {ReturnType<typeof setTimeout> | null} */
    this._responseTimer = null;
    /** Wall-clock turn cap. Unlike _responseTimer (a no-progress timer that
     *  re-arms on every event), this is armed ONCE per turn and fires regardless
     *  of activity — the backstop for an actively-runaway turn (deep/wide subagent
     *  work) that never goes idle. @type {ReturnType<typeof setTimeout> | null} */
    this._turnWatchdogTimer = null;
    /** @type {ReturnType<typeof setTimeout> | null} */
    this._progressNoticeTimer = null;
    /** @type {ReturnType<typeof setTimeout> | null} */
    this._idleSettleTimer = null;
    /** @type {ReturnType<typeof setTimeout> | null} */
    this._idleProbeTimer = null;
    this._pendingCompletePayload = null;
    /** @type {ReturnType<typeof setTimeout> | null} */
    this._dispatchFailureTimer = null;
    /** @type {ReturnType<typeof setTimeout> | null} */
    this._promptAcceptanceTimer = null;
    this._pendingDispatchFailure = null;
    this._pendingPromptPayload = null;
    this._activeTaskContract = null;
    this._dispatchRetryCount = 0;
    this._transientReplayCount = 0;
    this._engineSessionWasResumed = false;
    /** @type {ReturnType<typeof setTimeout> | null} */
    this._transientFailureTimer = null;
    this._pendingTransientFailure = null;
    this._turnStartedAt = 0;
    this._abortSettling = false;
  }

  bindOrchestrator(orchestrator) {
    this._orchestrator = orchestrator;
  }

  // --- lifecycle -----------------------------------------------------------

  /**
   * @param {string} cwd
   * @param {{ agentCommand: string, permissionMode?: string, model?: {providerID:string, modelID:string}|null, agent?: string|null, configDir?: string, dataDir?: string }} options
   */
  ensureProcess(cwd, options, callOpts = {}) {
    if (!cwd || !options?.agentCommand) throw new Error("RUNNER_MISSING_ARGS");
    if (!fs.existsSync(cwd)) throw new Error(`Working directory not found: ${cwd}`);
    // A prior OpenCode session id (from sessionManager) lets us resume the model's
    // conversation across app restarts against the persistent per-session DB.
    if (options.resumeSessionId && !this.agentResumeId) {
      this.agentResumeId = options.resumeSessionId;
    }
    this.cwd = cwd;
    this.spawnOptions = options;
    if (callOpts.lazy) return;
    void this._ensureStarted();
  }

  /** App-level SQLite path for the shared OpenCode serve. OpenCode session rows
   *  are already keyed by their `ses_...` id; using a per-Lily-session DB with a
   *  shared serve made multi-session resume depend on whichever session started
   *  the serve first. */
  _dataDir() {
    if (this.spawnOptions?.dataDir) return this.spawnOptions.dataDir;
    try {
      return require("./config").opencodeDbPath();
    } catch {
      return path.join(os.tmpdir(), "lily-opencode", "opencode.db");
    }
  }

  /** Idempotently start the serve process, create a session, and subscribe.
   *  The server is REUSED across turns — that's what threads the conversation
   *  (every turn POSTs to the same session id, so OpenCode keeps full context).
   *  Do NOT restart it just because the config string changed: AGENT.md varies
   *  per turn (workspace digest, learned context), so a config-diff restart fired
   *  every turn and broke continuity ("every question treated as new"). A genuine
   *  permission-mode change applies via applyPermissionMode terminating the idle
   *  runner, after which this spawns fresh and resumes the same session id. */
  _ensureStarted() {
    if (this._server && this._server.sessionID) return Promise.resolve(this._server);
    if (this._starting) return this._starting;
    this._starting = (async () => {
      const server = this._createServer({
        serverCommand: this.spawnOptions.agentCommand,
        cwd: this.cwd,
        dataDir: this._dataDir(),
        env: this.spawnOptions.env || {},
        model: this.spawnOptions.model || null,
        agent: this.spawnOptions.agent || null,
        resumeSessionID: this.agentResumeId || null,
        configContent: this.spawnOptions.opencodeConfig || "",
      });
      server.on("event", (ev) => this._handleEvent(ev));
      server.on("exit", ({ code }) => this._onServerExit(code));
      server.on("error", (err) => this._onServerError(err));
      await server.start();
      const id = await server.createSession();
      server.subscribe();
      this._server = server;
      this._engineSessionWasResumed = Boolean(server.wasResumed);
      // Guidance is delivered with each prompt, not only with fresh sessions:
      // OpenCode resume history may predate the current Lily rules/skill set, and
      // session-level skill toggles can change between turns.
      this._guidancePending = Boolean(this.spawnOptions?.guidance);
      this.agentResumeId = id;
      this.emit("agent-resume-id", id);
      // Started — clear the "starting" flag so isAlive() keys on the live process,
      // not a resolved start promise that never gets reset (which would mask a
      // later crash and report a dead engine as alive).
      this._starting = null;
      return server;
    })();
    this._starting.catch((err) => {
      this._starting = null;
      log.warn("opencode start failed: %s", err?.message || String(err));
      if (this.busy && !this._turnSettled) this._failTurn(this._sanitize(err?.message), err);
    });
    return this._starting;
  }

  isAlive() {
    // "Alive" includes the async startup window: the Claude runner spawns
    // synchronously, but OpenCode's `serve` comes up over HTTP, so ensureProcess
    // returns before the server is ready. Treating an in-flight start as alive
    // lets the orchestrator's spawn:true preflight pass (otherwise every send
    // fails "Unable to start the assistant process").
    const p = this._server && this._server.process;
    // Verify the child is actually running — not just that a (possibly dead)
    // process object lingers. A crashed serve leaves the object set with a
    // non-null exitCode; without this check isAlive() reported it as alive.
    const running = Boolean(p && p.exitCode == null && p.signalCode == null && !p.killed);
    return running || Boolean(this._starting);
  }

  isBusy() {
    return this.busy || this._abortSettling;
  }

  diagnostics() {
    return {
      sessionId: this.sessionId,
      cwd: this.cwd || "",
      alive: this.isAlive(),
      busy: this.busy,
      abortSettling: this._abortSettling,
      turnSettled: this._turnSettled,
      sawActivity: this._sawActivity,
      collectedOutputLength: this.collectedOutput.length,
      pendingPermissions: this._pendingPermissions.size,
      pendingQuestions: this._pendingQuestions.size,
      pendingComplete: Boolean(this._pendingCompletePayload),
      timers: {
        response: Boolean(this._responseTimer),
        progressNotice: Boolean(this._progressNoticeTimer),
        idleSettle: Boolean(this._idleSettleTimer),
        idleProbe: Boolean(this._idleProbeTimer),
        promptAcceptance: Boolean(this._promptAcceptanceTimer),
        health: Boolean(this._healthTimer),
      },
      server: this._server?.diagnostics?.() || null,
    };
  }

  // --- outbound ------------------------------------------------------------

  /** @param {{ text?: string, files?: Array<object> } | string} payload */
  sendUserMessage(payload) {
    if (this.isBusy()) return false;
    const text = typeof payload === "string" ? payload : payload?.text;
    const files = typeof payload === "object" && payload?.files ? payload.files : [];
    if (!text && (!files || files.length === 0)) return false;

    this.busy = true;
    this._turnSettled = false;
    this._sawActivity = false;
    this._sawEngineEvent = false;
    this._sawToolActivity = false;
    this._sawUnsafeToolActivity = false;
    this._toolReplaySafe.clear();
    this._activeTools.clear();
    this._lastGenericToolProgressNotice = "";
    this._gatedThisTurn = false;
    this._latestTodos = [];
    this._latestTodosSignature = "";
    this._todoCompletionGateAttempts = 0;
    this._dispatchRetryCount = 0;
    this._transientReplayCount = 0;
    this._engineSessionWasResumed = Boolean(this._server?.wasResumed || this._engineSessionWasResumed);
    this.collectedOutput = "";
    this._turnStartedAt = Date.now();
    this._pendingTransientFailure = null;
    this._activeTaskContract = typeof payload === "object" ? payload?.taskContract || null : null;
    this._clearTransientFailureTimer();
    this._clearIdleProbeTimer();
    // First engine message id of this turn — the rewind anchor. Reverting to it
    // undoes the whole exchange (the engine anchors back to the preceding user msg).
    this._turnEngineMessageId = null;
    this._armResponseTimer();
    this._armProgressNoticeTimer();
    this._armHealthProbe();
    this._armTurnWatchdog();

    (async () => {
      try {
        const server = await this._ensureStarted();
        // Refresh the cross-session memory the compaction plugin injects, keyed by
        // the engine session id (now that the server is started). Snapshotting at
        // turn start means a mid-turn compaction sees the latest durable facts.
        this._refreshCompactionMemory(server);
        // Skill guidance rides every user turn as hidden engine context. This
        // keeps resumed/migrated sessions and skill changes aligned with Lily's
        // current rules instead of relying on stale OpenCode history.
        const guidance = this.spawnOptions?.guidance || "";
        this._pendingPromptPayload = { text, files, guidance };
        await server.sendPrompt(this._pendingPromptPayload);
        this._armPromptAcceptanceCheck();
      } catch (err) {
        // The turn is driven by SSE (session.idle/events). If events already
        // arrived, a hiccup on the blocking message POST is NOT a turn failure —
        // let SSE finish. promptAsync can surface a transport error after OpenCode
        // already accepted the turn, so give the event stream a short proof window
        // before declaring the prompt lost.
        log.warn("opencode prompt dispatch failed: %s", err?.message || String(err));
        if (this.busy && !this._turnSettled && !this._sawActivity && !this._sawEngineEvent) {
          this._scheduleDispatchFailure(err);
        }
      }
    })();
    return true;
  }

  /** Steer ("插话"): inject a message into the RUNNING turn instead of aborting or
   *  queuing for after. The engine appends the user message and the in-flight prompt
   *  loop picks it up at its next step (verified against OpenCode's SessionPrompt
   *  loop, which re-reads the latest messages each iteration). Deliberately does NOT
   *  reset turn state — the active turn keeps owning the SSE/lifecycle. Returns false
   *  when not steerable so the caller degrades to queue (never worse than today).
   *  @param {{ text?: string, files?: Array<object> } | string} payload */
  async steer(payload) {
    if (!this.busy || this._turnSettled) return false;
    const text = typeof payload === "string" ? payload : payload?.text;
    const files = typeof payload === "object" && payload?.files ? payload.files : [];
    if (!text && (!files || files.length === 0)) return false;
    try {
      const server = this._server || (await this._ensureStarted());
      if (!server) return false;
      const guidance = this.spawnOptions?.guidance || "";
      await server.sendPrompt({ text, files, guidance });
      // A steer IS progress: keep the no-progress watchdog from killing the turn.
      this._sawActivity = true;
      this._armResponseTimer();
      this._armProgressNoticeTimer();
      return true;
    } catch (err) {
      log.warn("opencode steer dispatch failed: %s", err?.message || String(err));
      return false;
    }
  }

  /** Host-side auto-decision for a gated tool (no user dialog). reply is the
   *  engine response: "once" (allow this call) or "reject" (deny). The serve
   *  asked; the session's mode answered. */
  _autoRespondPermission(requestId, reply) {
    void this._server
      ?.respondPermission(requestId, { reply })
      .catch((err) => log.warn("auto permission reply failed: %s", err?.message || String(err)));
  }

  respondPermission(requestId, decision = {}) {
    const pending = this._pendingPermissions.get(requestId);
    if (!pending) return false;
    this._pendingPermissions.delete(requestId);
    const reply = decision.allow ? (decision.remember ? "always" : "once") : "reject";
    void this._server
      ?.respondPermission(pending.rawRequestId || requestId, { reply, message: decision.message }, { sessionID: pending.sessionID })
      .catch((err) => log.warn("permission reply failed: %s", err?.message || String(err)));
    this._ingest([{ type: "permission.resolved", payload: { requestId, cancelled: false } }]);
    return true;
  }

  // OpenCode has no Claude-style hooks; user questions use the `question` tool
  // (wired in a later slice). Keep the surface so the orchestrator calls no-op.
  /**
   * Answer a `question` tool prompt. `response` is the host shape
   * { answers, response? }; we coerce it to OpenCode's string[][] (one array of
   * selected labels per question, in order).
   */
  respondUserQuestion(requestId, response = {}) {
    const pending = this._pendingQuestions.get(requestId);
    if (!pending) return false;
    this._pendingQuestions.delete(requestId);
    const answers = toOpencodeAnswers(response, pending.questions || []);
    void this._server
      ?.respondQuestion(pending.rawRequestId || requestId, answers, { sessionID: pending.sessionID })
      .catch((err) => log.warn("question reply failed: %s", err?.message || String(err)));
    this._ingest([{ type: "user_question.resolved", payload: { requestId } }]);
    return true;
  }

  respondHook() { return false; }
  reloadSkills() { return false; }

  // Write Lily's curated navigation memory to the file the compaction plugin reads
  // (resources/opencode-plugins/compaction-memory.js), keyed by the engine session
  // id. Fail-safe: any error just means the plugin finds nothing and the engine
  // compacts as usual — never breaks a turn.
  _refreshCompactionMemory(server) {
    try {
      const engineSessionId = server?.sessionID || this._server?.sessionID || "";
      if (!engineSessionId) return;
      const { userDataPath } = require("./config");
      const { COMPACTION_MEMORY_DIRNAME, writeCompactionMemoryFile } = require("./compaction-memory-export");
      const summary = require("./session-memory").readSessionSummary(this.sessionId);
      if (!summary) return;
      writeCompactionMemoryFile(userDataPath(COMPACTION_MEMORY_DIRNAME), engineSessionId, summary);
    } catch (err) {
      log.warn("compaction memory refresh failed: %s", err?.message || String(err));
    }
  }

  async compactContext(body = {}) {
    if (this.isBusy() || !this._server?.summarize) return false;
    try {
      await this._server.summarize(body);
      try {
        require("./session-memory").markSessionCompacted(this.sessionId, {
          runtime: "opencode",
          mode: "native",
          reason: body.reason || "",
        });
      } catch (err) {
        log.warn("session compaction memory update failed: %s", err?.message || String(err));
      }
      return true;
    } catch (err) {
      const errorMessage = err?.message || String(err);
      const providerID = body?.providerID || "";
      const modelID = body?.modelID || "";
      const reason = body?.reason || "";
      log.warn(
        `opencode context compaction failed: session=${this.sessionId} cwd=${this.cwd || ""} provider=${providerID || "-"} model=${modelID || "-"} reason=${reason || "-"} error=${errorMessage}`,
      );
      try {
        require("./session-memory").markSessionCompactionFailed(this.sessionId, {
          runtime: "opencode",
          mode: "native",
          reason,
          providerID,
          modelID,
          code: err?.name || "",
          error: errorMessage,
        });
      } catch (memoryErr) {
        log.warn(`session compaction failure memory update failed: ${memoryErr?.message || String(memoryErr)}`);
      }
      return false;
    }
  }

  updateEnvironmentVariables() {
    // OpenCode reads provider/model/search config when the shared serve starts.
    // Report "not applied" so callers rebuild idle runners instead of pretending
    // a model/API change reached an already-running serve.
    return false;
  }

  setPermissionMode(mode) {
    if (this.spawnOptions) this.spawnOptions.permissionMode = mode;
    // Permission is now enforced host-side (decidePermission reads permissionMode
    // live on each gated tool call), so a mode change applies IMMEDIATELY — no
    // serve restart, no session-resume dance. Report applied-live.
    return true;
  }

  interrupt() {
    this._clearPendingPermissions();
    if (this._server && !this._abortSettling) {
      const server = this._server;
      this._abortSettling = true;
      void this._abortWithTimeout(server)
        .catch((err) => log.warn("opencode abort failed: %s", err?.message || String(err)))
        .finally(() => {
          this._abortSettling = false;
        });
    }
    if (this.busy && !this._turnSettled) {
      // interrupt() is only ever called for a user-initiated stop, so mark it as
      // such: the orchestrator distinguishes a user interrupt (turn.interrupted)
      // from an engine-side abort (turn.failed) by interruptedByUser. Without this
      // flag a user stop was misclassified as completed/failed.
      this._completeTurn({
        code: null,
        output: this.collectedOutput.trim(),
        interrupted: true,
        interruptedByUser: true,
      });
    }
  }

  terminate() {
    this._clearIdleSettleTimer();
    this._clearIdleProbeTimer();
    this._pendingCompletePayload = null;
    this._clearDispatchFailureTimer();
    this._clearPromptAcceptanceCheck();
    this._clearTransientFailureTimer();
    this._clearResponseTimer();
    this._clearProgressNoticeTimer();
    this._clearHealthProbe();
    this._clearTurnWatchdog();
    this._clearPendingPermissions();
    if (this._server) {
      this._server.terminate();
      this._server = null;
    }
    this._starting = null;
    this.busy = false;
    this._abortSettling = false;
    this._turnSettled = true;
    this.cwd = null;
    this.spawnOptions = null;
    this._pendingPromptPayload = null;
    this._activeTaskContract = null;
    this._dispatchRetryCount = 0;
    this._transientReplayCount = 0;
    this._pendingTransientFailure = null;
    this._turnStartedAt = 0;
    this._sawToolActivity = false;
    this._sawUnsafeToolActivity = false;
    this._toolReplaySafe.clear();
    this._activeTools.clear();
    this._lastGenericToolProgressNotice = "";
  }

  async _abortWithTimeout(server) {
    let timer = null;
    try {
      await Promise.race([
        server.abort(),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error("abort timed out")), OpencodeAgentSession.INTERRUPT_ABORT_TIMEOUT_MS);
          timer.unref?.();
        }),
      ]);
    } catch (err) {
      try { server.terminate?.(); } catch { /* best effort */ }
      if (this._server === server) {
        this._server = null;
        this._starting = null;
      }
      throw err;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  // --- inbound: OpenCode event -> runtime drafts + host effects ------------

  _handleEvent(ev) {
    if (!this.busy || this._turnSettled) return;
    const childSessionID = ev?.__lilySubagentSessionID || "";
    if (childSessionID) {
      this._handleSubagentEvent(childSessionID, ev);
      return;
    }
    if (isTurnOwnedEngineEvent(ev)) {
      this._sawEngineEvent = true;
      this._clearDispatchFailureTimer();
      this._clearPromptAcceptanceCheck();
    }

    // Capture the turn's first engine message id (rewind anchor) before normalize.
    if (!this._turnEngineMessageId) {
      const mid = ev?.properties?.messageID || ev?.properties?.part?.messageID || ev?.properties?.info?.id;
      if (typeof mid === "string" && mid.startsWith("msg_")) this._turnEngineMessageId = mid;
    }

    this._noteRawToolActivity(ev);

    let reduced;
    try {
      reduced = reduceOpencodeRuntimeEvent(ev, this._eventState);
    } catch (err) {
      log.warn("opencode event reducer failed: %s", err?.message || String(err));
      return;
    }

    // Meaningful reducer progress = the engine is making forward movement (text,
    // thinking, a tool call/update/result, permission/question, completion, or
    // usage). Reset the no-progress watchdog only on these — NOT on
    // every event. Busy/heartbeat events carry no actions, so a turn that just
    // pings "busy" without doing anything still times out, while a genuinely long
    // task that keeps progressing (an hour of converting files, etc.) resets the
    // watchdog on each step and runs to completion.
    if (reduced.progress) {
      this._sawActivity = true;
      this._clearDispatchFailureTimer();
      this._clearPromptAcceptanceCheck();
      this._clearTransientFailureTimer();
      this._armResponseTimer();
      this._armProgressNoticeTimer();
      this._armIdleProbe();
    }

    for (const effect of reduced.effects || []) {
      this._handleEffect(effect, { sessionID: this._server?.sessionID || "" });
    }

    // Keep the renderer contract stable: relocate tool.done content -> result
    // (truncated), append the process.event timeline draft, then hand the batch
    // to the orchestrator.
    const drafts = [...(reduced.drafts || [])];
    this._registerSubagentsFromDrafts(drafts);
    for (const draft of drafts) {
      if (draft.type === "todo.updated") {
        this._rememberLatestTodos(draft.payload?.todos);
      }
      if (String(draft.type || "").startsWith("tool.")) this._noteToolActivity(draft);
      if (draft.type !== "tool.done") continue;
      const raw = draft.payload?.content;
      if (typeof raw !== "string" || !raw) continue;
      draft.payload.result = truncateToolResultForUi(raw);
      delete draft.payload.content;
    }
    if (reduced.processEvent) drafts.push(reduced.processEvent);
    this._ingest(drafts);
  }

  _rememberLatestTodos(todos) {
    const next = Array.isArray(todos) ? todos : [];
    let signature = "";
    try {
      signature = JSON.stringify(next.map((todo, index) => ({
        title: todoTitle(todo, index),
        status: normalizeTodoStatus(todo?.status),
      })));
    } catch {
      signature = "";
    }
    if (signature !== this._latestTodosSignature) {
      this._latestTodosSignature = signature;
      this._todoCompletionGateAttempts = 0;
    }
    this._latestTodos = next;
  }

  _noteToolActivity(draft = {}) {
    this._sawToolActivity = true;
    const payload = draft.payload || {};
    const id = String(payload.id || "");
    if (draft.type === "tool.started") {
      this._startOrTouchActiveTool({
        id,
        name: payload.name,
        input: payload.input,
        title: payload.title,
      });
      const safe = isReplaySafeToolName(payload.name);
      if (id) this._toolReplaySafe.set(id, safe);
      if (!safe) this._sawUnsafeToolActivity = true;
      return;
    }
    if (draft.type === "tool.done") {
      if (id) this._activeTools.delete(id);
      const safe = id && this._toolReplaySafe.has(id)
        ? this._toolReplaySafe.get(id)
        : isReplaySafeToolName(payload.name);
      if (!safe) this._sawUnsafeToolActivity = true;
    }
  }

  _noteRawToolActivity(ev = {}) {
    const tool = rawToolFromEvent(ev);
    if (!tool?.id) return;
    const status = String(tool.status || "");
    if (status === "completed" || status === "error" || status === "failed" || status === "done") {
      this._activeTools.delete(tool.id);
      return;
    }
    if (status === "running" || status === "pending" || status === "") {
      this._startOrTouchActiveTool(tool);
    }
  }

  _startOrTouchActiveTool(tool = {}) {
    const id = String(tool.id || "");
    if (!id) return;
    const now = Date.now();
    const existing = this._activeTools.get(id) || {};
    this._activeTools.set(id, {
      ...existing,
      id,
      name: tool.name || existing.name || "Tool",
      input: tool.input && typeof tool.input === "object" && Object.keys(tool.input).length
        ? tool.input
        : (existing.input || {}),
      title: tool.title || existing.title || "",
      startedAt: existing.startedAt || now,
      lastActivityAt: now,
    });
  }

  _registerSubagentsFromDrafts(drafts = []) {
    for (const draft of drafts) {
      if (!String(draft?.type || "").startsWith("tool.")) continue;
      const payload = draft.payload || {};
      if (String(payload.name || "").toLowerCase() !== "task" && draft.type !== "tool.done") continue;
      const meta = payload.metadata || {};
      const child = meta.sessionId || meta.sessionID;
      if (!child) continue;
      this._knownSubagentSessionIDs.add(String(child));
      this._server?.allowChildSession?.(child);
    }
  }

  _subagentState(sessionID) {
    const id = String(sessionID || "");
    if (!this._subagentEventStates.has(id)) this._subagentEventStates.set(id, createOpencodeRuntimeState());
    return this._subagentEventStates.get(id);
  }

  _resetSubagentRuntimeStates() {
    this._subagentEventStates.clear();
    this._knownSubagentSessionIDs.clear();
  }

  _handleSubagentEvent(sessionID, ev) {
    if (sessionID) this._knownSubagentSessionIDs.add(String(sessionID));
    let reduced;
    try {
      reduced = reduceOpencodeRuntimeEvent(ev, this._subagentState(sessionID));
    } catch (err) {
      log.warn("opencode subagent reducer failed: %s", err?.message || String(err));
      return;
    }
    if (reduced.progress) {
      this._sawActivity = true;
      this._armResponseTimer();
      this._armProgressNoticeTimer();
      this._armIdleProbe();
    }
    const events = [];
    for (const effect of reduced.effects || []) {
      const mapped = this._handleSubagentEffect(sessionID, effect);
      if (mapped) events.push(mapped);
    }
    for (const draft of reduced.drafts || []) {
      const mapped = this._mapSubagentDraft(sessionID, draft);
      if (mapped) {
        events.push(mapped);
        if (mapped.kind === "permission" && mapped.status === "resolved" && mapped.requestId) {
          this._ingest([{ type: "permission.resolved", payload: { requestId: mapped.requestId } }]);
        } else if (mapped.kind === "question" && mapped.status === "resolved" && mapped.requestId) {
          this._ingest([{ type: "user_question.resolved", payload: { requestId: mapped.requestId } }]);
        }
      }
    }
    if (!events.length) return;
    this._ingest([{ type: "subagent.event", payload: { sessionId: sessionID, events } }]);
  }

  _mapSubagentDraft(sessionID, draft) {
    const payload = draft?.payload || {};
    const ts = Date.now();
    switch (draft?.type) {
      case "tool.started":
        return {
          kind: "tool",
          id: payload.id || "",
          name: payload.name || "unknown",
          status: "running",
          input: payload.input || {},
          metadata: payload.metadata || {},
          title: payload.title || "",
          ts,
        };
      case "tool.done":
        return {
          kind: "tool",
          id: payload.id || "",
          status: payload.isError ? "failed" : (payload.status || "done"),
          result: payload.result ?? payload.content ?? null,
          metadata: payload.metadata || {},
          title: payload.title || "",
          ts,
        };
      case "assistant.delta":
        return { kind: "text", text: payload.text || "", ts };
      case "assistant.thinking.delta":
        return { kind: "thinking", text: payload.text || "", ts };
      case "usage.updated":
        return { kind: "usage", usage: payload.usage || {}, ts };
      case "permission.resolved":
        return {
          kind: "permission",
          status: "resolved",
          requestId: payload.requestId ? this._childRequestId(sessionID, payload.requestId) : "",
          rawRequestId: payload.requestId || "",
          ts,
        };
      case "user_question.resolved":
        return {
          kind: "question",
          status: "resolved",
          requestId: payload.requestId ? this._childRequestId(sessionID, payload.requestId) : "",
          rawRequestId: payload.requestId || "",
          ts,
        };
      default:
        return null;
    }
  }

  _childRequestId(sessionID, rawRequestId) {
    const safeSession = String(sessionID || "").replace(/[^a-zA-Z0-9_.:-]/g, "_");
    const safeRequest = String(rawRequestId || "").replace(/[^a-zA-Z0-9_.:-]/g, "_");
    return `subagent:${safeSession}:${safeRequest}`;
  }

  _handleSubagentEffect(sessionID, effect) {
    if (!effect || !sessionID) return null;
    const rawRequestId = effect.requestId || "";
    const requestId = rawRequestId ? this._childRequestId(sessionID, rawRequestId) : "";
    if (effect.kind === "permission") {
      const mode = this.spawnOptions?.permissionMode || "ask";
      const verdict = decidePermission(mode, effect.toolName, effect.input || {}, {
        cwd: this.cwd,
        taskContract: this._activeTaskContract,
      });
      if (verdict === "allow") {
        void this._server
          ?.respondPermission(rawRequestId, { reply: "once" }, { sessionID })
          .catch((err) => log.warn("subagent auto permission reply failed: %s", err?.message || String(err)));
        return { kind: "permission", status: "auto_allowed", requestId, rawRequestId, toolName: effect.toolName || "", ts: Date.now() };
      }
      if (verdict === "deny") {
        void this._server
          ?.respondPermission(rawRequestId, { reply: "reject" }, { sessionID })
          .catch((err) => log.warn("subagent auto permission reply failed: %s", err?.message || String(err)));
        return { kind: "permission", status: "auto_denied", requestId, rawRequestId, toolName: effect.toolName || "", ts: Date.now() };
      }
      this._pendingPermissions.set(requestId, { rawRequestId, sessionID });
      this._ingest([{
        type: "permission.requested",
        payload: {
          requestId,
          toolName: effect.toolName,
          input: effect.input || {},
          title: effect.title || "",
          description: effect.description || "",
          decisionReason: effect.decisionReason || "",
          suggestions: effect.suggestions || [],
          planPreview: "",
          planPreviewTruncated: false,
          subagent: { sessionId: sessionID, rawRequestId },
        },
      }]);
      return { kind: "permission", status: "requested", requestId, rawRequestId, toolName: effect.toolName || "", ts: Date.now() };
    }
    if (effect.kind === "question") {
      const questions = effect.questions || [];
      this._pendingQuestions.set(requestId, { questions, rawRequestId, sessionID });
      this._ingest([{
        type: "user_question.requested",
        payload: {
          requestId,
          questions,
          subagent: { sessionId: sessionID, rawRequestId },
        },
      }]);
      return { kind: "question", status: "requested", requestId, rawRequestId, ts: Date.now() };
    }
    return null;
  }

  _handleEffect(effect, opts = {}) {
    switch (effect.kind) {
      case "assistant_text":
        this.collectedOutput += effect.text || "";
        this._armResponseTimer();
        break;

      case "permission": {
        // The shared serve asks for every mutation; the session's MODE is
        // enforced HERE (host-side), mirroring the official client. Auto-allow /
        // auto-deny without bothering the user; only "ask" surfaces the dialog.
        const mode = this.spawnOptions?.permissionMode || "ask";
        const verdict = decidePermission(mode, effect.toolName, effect.input || {}, {
          cwd: this.cwd,
          taskContract: this._activeTaskContract,
        });
        if (verdict === "allow") {
          this._autoRespondPermission(effect.requestId, "once");
          break;
        }
        if (verdict === "deny") {
          this._autoRespondPermission(effect.requestId, "reject");
          break;
        }
        this._pendingPermissions.set(effect.requestId, {
          rawRequestId: effect.requestId,
          sessionID: opts.sessionID || this._server?.sessionID || "",
        });
        this._ingest([{
          type: "permission.requested",
          payload: {
            requestId: effect.requestId,
            toolName: effect.toolName,
            input: effect.input || {},
            title: effect.title || "",
            description: effect.description || "",
            decisionReason: effect.decisionReason || "",
            suggestions: effect.suggestions || [],
            planPreview: "",
            planPreviewTruncated: false,
          },
        }]);
        break;
      }

      case "question": {
        const questions = effect.questions || [];
        this._pendingQuestions.set(effect.requestId, {
          questions,
          rawRequestId: effect.requestId,
          sessionID: opts.sessionID || this._server?.sessionID || "",
        });
        this._ingest([{
          type: "user_question.requested",
          payload: { requestId: effect.requestId, questions },
        }]);
        break;
      }

      case "complete": {
        this._scheduleCompleteTurn({
          code: effect.code || 0,
          output: this.collectedOutput.trim(),
          interrupted: false,
        });
        break;
      }

      case "usage":
        // Token usage from a step-finish — record it for cost/usage tracking;
        // the reducer already produced usage.updated for the renderer.
        if (effect.usage && typeof effect.usage === "object") {
          try {
            require("./usage-reporter").recordModelUsage(this.sessionId, effect.usage);
          } catch (err) {
            log.warn("usage record failed: %s", err?.message || String(err));
          }
        }
        break;

      case "context_compacted":
        try {
          require("./session-memory").markSessionCompacted(this.sessionId, {
            runtime: "opencode",
            mode: "native",
            reason: effect.reason || "runtime_event",
            engineSessionId: effect.sessionID || "",
            summaryMessageId: effect.messageID || "",
          });
        } catch (err) {
          log.warn("session compaction memory update failed: %s", err?.message || String(err));
        }
        break;

      case "error": {
        const rawMessage = typeof effect.message === "string" && effect.message ? effect.message : "Engine error";
        const displayMessage = this._sanitize(rawMessage) || "Engine error";
        this._failTurn(
          displayMessage,
          errorCauseFromEffect(effect, rawMessage),
        );
        break;
      }

      default:
        // Thinking/tool/unknown effects need no host-side state here; their
        // runtime drafts already carry everything the renderer needs.
        break;
    }
  }

  // --- turn settlement -----------------------------------------------------

  _scheduleCompleteTurn(payload) {
    if (this._turnSettled) return;
    this._pendingCompletePayload = payload;
    this._clearIdleSettleTimer();
    this._clearIdleProbeTimer();
    this._idleSettleTimer = setTimeout(() => {
      this._idleSettleTimer = null;
      void this._confirmIdleAndComplete();
    }, OpencodeAgentSession.IDLE_SETTLE_MS);
    this._idleSettleTimer.unref?.();
  }

  async _confirmIdleAndComplete() {
    const next = this._pendingCompletePayload;
    if (!next || this._turnSettled) return;
    let idle = true;
    try {
      idle = this._server?.isSessionIdle ? await this._server.isSessionIdle() : true;
    } catch (err) {
      log.warn("opencode idle confirmation failed: %s", err?.message || String(err));
      idle = true;
    }
    if (!this._pendingCompletePayload || this._turnSettled) return;
    if (!idle) {
      this._scheduleCompleteTurn(next);
      return;
    }
    this._pendingCompletePayload = null;
    const synced = await this._syncFinalOutputFromOfficialHistory({
      ...next,
      output: this.collectedOutput.trim(),
    });
    this._completeTurn(synced);
  }

  _clearIdleSettleTimer() {
    if (this._idleSettleTimer) {
      clearTimeout(this._idleSettleTimer);
      this._idleSettleTimer = null;
    }
  }

  _armIdleProbe() {
    this._clearIdleProbeTimer();
    if (!this.busy || this._turnSettled || this._pendingCompletePayload) return;
    if (!this._sawActivity) return;
    this._idleProbeTimer = setTimeout(() => {
      this._idleProbeTimer = null;
      void this._probeOfficialIdleAndComplete();
    }, OpencodeAgentSession.IDLE_STATUS_PROBE_MS);
    this._idleProbeTimer.unref?.();
  }

  _clearIdleProbeTimer() {
    if (this._idleProbeTimer) {
      clearTimeout(this._idleProbeTimer);
      this._idleProbeTimer = null;
    }
  }

  async _probeOfficialIdleAndComplete() {
    if (!this.busy || this._turnSettled || this._pendingCompletePayload) return;
    if (this._pendingPermissions.size || this._pendingQuestions.size) {
      this._armIdleProbe();
      return;
    }
    let idle = false;
    try {
      idle = this._server?.isSessionIdle ? await this._server.isSessionIdle() : false;
    } catch (err) {
      log.warn("opencode idle probe failed: %s", err?.message || String(err));
      this._armIdleProbe();
      return;
    }
    if (!this.busy || this._turnSettled || this._pendingCompletePayload) return;
    if (!idle) {
      this._armIdleProbe();
      return;
    }
    // The SSE stream is a live feed, but official session status/history is the
    // source of truth. If `session.idle` was dropped during reconnect or could
    // not be safely routed, a quiet idle status after real progress must still
    // settle the turn instead of waiting for the long no-progress watchdog.
    this._scheduleCompleteTurn({
      code: 0,
      output: this.collectedOutput.trim(),
      interrupted: false,
      completedByIdleProbe: true,
    });
  }

  _scheduleDispatchFailure(cause) {
    this._pendingDispatchFailure = cause;
    this._clearDispatchFailureTimer(false);
    this._dispatchFailureTimer = setTimeout(() => {
      this._dispatchFailureTimer = null;
      void this._confirmDispatchFailure();
    }, OpencodeAgentSession.DISPATCH_FAILURE_GRACE_MS);
    this._dispatchFailureTimer.unref?.();
  }

  async _confirmDispatchFailure() {
    const pending = this._pendingDispatchFailure;
    if (!this.busy || this._turnSettled || this._sawActivity || this._sawEngineEvent) {
      this._pendingDispatchFailure = null;
      return;
    }

    // promptAsync is fire-and-forget. A transport error can mean either "the
    // request did not arrive" or "the client lost the response after OpenCode
    // accepted it". Ask OpenCode before showing a model failure; if the session
    // is busy, the turn landed and SSE/health timers own the outcome.
    try {
      if (this._server?.isSessionIdle && !(await this._server.isSessionIdle())) {
        this._pendingDispatchFailure = null;
        return;
      }
    } catch {
      // If status itself is unavailable, fall through to the bounded retry.
    }

    if (this._dispatchRetryCount < 1 && this._server && this._pendingPromptPayload) {
      this._dispatchRetryCount += 1;
      const retryPayload = buildAttachmentFallbackPromptPayload(
        this._pendingPromptPayload,
        this._sanitize(pending?.message || ""),
      );
      this._pendingPromptPayload = retryPayload;
      try {
        await this._server.sendPrompt(retryPayload);
        this._pendingDispatchFailure = null;
        this._armPromptAcceptanceCheck();
        return;
      } catch (err) {
        this._pendingDispatchFailure = err;
        this._scheduleDispatchFailure(err);
        return;
      }
    }

    this._pendingDispatchFailure = null;
    if (this.busy && !this._turnSettled && !this._sawActivity) {
      this._failTurn(this._sanitize(pending?.message), pending);
    }
  }

  _clearDispatchFailureTimer(clearPending = true) {
    if (this._dispatchFailureTimer) {
      clearTimeout(this._dispatchFailureTimer);
      this._dispatchFailureTimer = null;
    }
    if (clearPending) this._pendingDispatchFailure = null;
  }

  _armPromptAcceptanceCheck() {
    this._clearPromptAcceptanceCheck();
    if (!this.busy || this._turnSettled || this._sawActivity || this._sawEngineEvent) return;
    this._promptAcceptanceTimer = setTimeout(() => {
      this._promptAcceptanceTimer = null;
      void this._confirmPromptAccepted();
    }, OpencodeAgentSession.DISPATCH_FAILURE_GRACE_MS);
    this._promptAcceptanceTimer.unref?.();
  }

  _clearPromptAcceptanceCheck() {
    if (this._promptAcceptanceTimer) {
      clearTimeout(this._promptAcceptanceTimer);
      this._promptAcceptanceTimer = null;
    }
  }

  async _confirmPromptAccepted() {
    if (!this.busy || this._turnSettled || this._sawActivity || this._sawEngineEvent) return;

    let idle = true;
    try {
      idle = this._server?.isSessionIdle ? await this._server.isSessionIdle() : true;
    } catch (err) {
      log.warn("opencode prompt acceptance status read failed: %s", err?.message || String(err));
      idle = true;
    }
    if (!this.busy || this._turnSettled || this._sawActivity || this._sawEngineEvent) return;
    if (!idle) return;

    const recovered = await this._recoverCompletedAssistantFromHistory({ requireCurrentPrompt: true }).catch((err) => {
      log.warn("opencode prompt acceptance history read failed: %s", err?.message || String(err));
      return null;
    });
    if (!this.busy || this._turnSettled || this._sawActivity || this._sawEngineEvent) return;
    if (recovered?.output) {
      this._completeTurn({
        code: 0,
        output: recovered.output,
        interrupted: false,
        engineMessageId: recovered.engineMessageId,
        recoveredFromPromptAcceptance: true,
      });
      return;
    }

    if (this._dispatchRetryCount < 1 && this._server && this._pendingPromptPayload) {
      this._dispatchRetryCount += 1;
      const retryPayload = buildAttachmentFallbackPromptPayload(
        this._pendingPromptPayload,
        "prompt accepted but no session activity",
      );
      this._pendingPromptPayload = retryPayload;
      try {
        await this._server.sendPrompt(retryPayload);
        this._armPromptAcceptanceCheck();
      } catch (err) {
        this._scheduleDispatchFailure(err);
      }
      return;
    }

    this._failTurn(
      "The assistant engine accepted the message but did not start the turn. Please retry.",
      new Error("prompt accepted but no session activity"),
      { force: true },
    );
  }

  _scheduleTransientFailureRecovery(message, cause) {
    const startedAt = this._pendingTransientFailure?.startedAt || Date.now();
    this._pendingTransientFailure = {
      message,
      cause,
      startedAt,
    };
    this._clearTransientFailureTimer(false);
    this._clearDispatchFailureTimer();
    this._transientFailureTimer = setTimeout(() => {
      this._transientFailureTimer = null;
      void this._recoverOrContinueAfterTransientFailure();
    }, OpencodeAgentSession.TRANSIENT_FAILURE_RECOVERY_POLL_MS);
    this._transientFailureTimer.unref?.();
  }

  _clearTransientFailureTimer(clearPending = true) {
    if (this._transientFailureTimer) {
      clearTimeout(this._transientFailureTimer);
      this._transientFailureTimer = null;
    }
    if (clearPending) this._pendingTransientFailure = null;
  }

  async _recoverOrContinueAfterTransientFailure() {
    const pending = this._pendingTransientFailure;
    if (!pending || !this.busy || this._turnSettled) {
      this._pendingTransientFailure = null;
      return;
    }

    const recovered = await this._recoverCompletedAssistantFromHistory({ requireCurrentPrompt: !this._sawActivity }).catch((err) => {
      log.warn("opencode transient recovery history read failed: %s", err?.message || String(err));
      return null;
    });
    if (!this.busy || this._turnSettled) return;
    if (recovered?.output) {
      this._pendingTransientFailure = null;
      this._completeTurn({
        code: 0,
        output: recovered.output,
        interrupted: false,
        engineMessageId: recovered.engineMessageId,
      });
      return;
    }

    let idle = false;
    try {
      idle = this._server?.isSessionIdle ? await this._server.isSessionIdle() : false;
    } catch (err) {
      log.warn("opencode transient recovery status read failed: %s", err?.message || String(err));
    }
    if (!this.busy || this._turnSettled) return;
    if (idle && this.collectedOutput.trim()) {
      this._pendingTransientFailure = null;
      this._completeTurn({ code: 0, output: this.collectedOutput.trim(), interrupted: false });
      return;
    }
    if (idle && await this._replayTransientPromptIfSafe(pending)) {
      return;
    }

    const elapsed = Date.now() - pending.startedAt;
    if (elapsed < OpencodeAgentSession.TRANSIENT_FAILURE_RECOVERY_MS) {
      this._scheduleTransientFailureRecovery(pending.message, pending.cause);
      return;
    }

    this._pendingTransientFailure = null;
    this._failTurn(pending.message, pending.cause, { force: true });
  }

  async _replayTransientPromptIfSafe(pending) {
    if (!this._pendingPromptPayload || !this._server) return false;
    if (this._transientReplayCount >= 1) return false;
    if (this._sawUnsafeToolActivity || this.collectedOutput.trim()) return false;
    if (this._pendingPermissions.size || this._pendingQuestions.size) return false;

    const raw = transientClassificationText(pending?.message, pending?.cause);
    const classified = require("./agent-runner").classifyAssistantError(raw);
    if (!isRecoverableModelConnectionFailure(classified, raw)) return false;

    this._transientReplayCount += 1;
    this._pendingTransientFailure = null;
    this._clearTransientFailureTimer(false);
    resetOpencodeRuntimeState(this._eventState);
    this._resetSubagentRuntimeStates();
    this.collectedOutput = "";
    this._turnStartedAt = Date.now();
    this._sawActivity = false;
    this._sawEngineEvent = false;
    this._sawToolActivity = false;
    this._sawUnsafeToolActivity = false;
    this._toolReplaySafe.clear();
    try {
      const originalPayload = this._pendingPromptPayload;
      const retryPayload = buildAttachmentFallbackPromptPayload(
        originalPayload,
        this._sanitize(raw || "transient model transport failure"),
      );
      this._pendingPromptPayload = retryPayload;
      const isolateDocumentAttachment =
        retryPayload.attachmentFallback && shouldIsolateAttachmentFallback(originalPayload);
      const isolateLegacyResume =
        !retryPayload.attachmentFallback && this._engineSessionWasResumed && isRecoverableModelConnectionFailure(classified, raw);
      if (isolateDocumentAttachment || isolateLegacyResume) {
        await this._restartEngineSessionForSafeReplay(raw || "transient model transport failure");
      }
      const server = await this._ensureStarted();
      await server.sendPrompt(retryPayload);
      this._armResponseTimer();
      this._armProgressNoticeTimer();
      this._armHealthProbe();
      this._armPromptAcceptanceCheck();
      return true;
    } catch (err) {
      this._pendingTransientFailure = {
        message: this._sanitize(err?.message || err),
        cause: err,
        startedAt: Date.now(),
      };
      this._scheduleTransientFailureRecovery(this._pendingTransientFailure.message, err);
      return true;
    }
  }

  async _restartEngineSessionForSafeReplay(reason = "") {
    const server = this._server;
    if (server) {
      log.warn("isolating safe replay in a fresh OpenCode session: %s", this._sanitize(reason || "transient replay failure"));
      try {
        await this._abortWithTimeout(server);
      } catch (err) {
        log.warn("opencode safe replay abort failed: %s", err?.message || String(err));
      }
      try {
        server.terminate?.();
      } catch {
        // best effort
      }
      if (this._server === server) this._server = null;
    }
    this._starting = null;
    this.agentResumeId = null;
    return this._ensureStarted();
  }

  async _recoverCompletedAssistantFromHistory(opts = {}) {
    return this._latestAssistantFromOfficialHistory(opts);
  }

  async _latestAssistantFromOfficialHistory(opts = {}) {
    if (!this._server?.messages || !this._turnStartedAt) return null;
    const raw = await this._server.messages({ limit: 16 });
    const items = Array.isArray(raw?.data) ? raw.data : Array.isArray(raw) ? raw : [];
    const requireCurrentPrompt = Boolean(opts.requireCurrentPrompt);
    let currentUser = null;
    if (requireCurrentPrompt) {
      const expectedText = String(this._pendingPromptPayload?.text || "").trim();
      const minPromptCreatedAt = this._turnStartedAt - 2_000;
      for (const item of items) {
        const info = item?.info || {};
        if (info.role !== "user") continue;
        const createdAt = messageCreatedMs(info);
        if (!createdAt || createdAt < minPromptCreatedAt) continue;
        const text = messageTextFromOpenCodeItem(item);
        if (expectedText && text !== expectedText) continue;
        const rank = createdAt;
        if (!currentUser || rank >= currentUser.rank) {
          currentUser = {
            id: typeof info.id === "string" ? info.id : null,
            createdAt,
            rank,
          };
        }
      }
      if (!currentUser) return null;
    }

    const minCreatedAt = requireCurrentPrompt ? currentUser.createdAt : this._turnStartedAt - 10_000;
    let best = null;
    for (const item of items) {
      const info = item?.info || {};
      if (info.role !== "assistant") continue;
      const createdAt = messageCreatedMs(info);
      if (createdAt && createdAt < minCreatedAt) continue;
      const { assistantTextFromOpenCodeMessageItem } = require("./runtime/opencode-conversation-adapter");
      const output = assistantTextFromOpenCodeMessageItem(item);
      if (!output) continue;
      const completedAt = messageCompletedMs(info);
      const rank = completedAt || createdAt || 0;
      if (requireCurrentPrompt && rank < currentUser.rank) continue;
      if (!best || rank >= best.rank) {
        best = {
          output,
          engineMessageId: typeof info.id === "string" ? info.id : null,
          completed: Boolean(completedAt),
          completedAt,
          createdAt,
          rank,
        };
      }
    }
    return best ? {
      output: best.output,
      engineMessageId: best.engineMessageId,
      completed: best.completed,
      completedAt: best.completedAt,
      createdAt: best.createdAt,
    } : null;
  }

  _withTimeout(promise, timeoutMs, fallback = null) {
    let timer = null;
    return Promise.race([
      promise,
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(fallback), timeoutMs);
        timer.unref?.();
      }),
    ]).finally(() => {
      if (timer) clearTimeout(timer);
    });
  }

  async _recoverStalledFinalFromOfficialState() {
    const latest = await this._withTimeout(
      this._latestAssistantFromOfficialHistory({ requireCurrentPrompt: !this._sawActivity }),
      OpencodeAgentSession.STALLED_HISTORY_SYNC_MS,
      null,
    );
    const output = String(latest?.output || "").trim();
    if (!output) return null;
    if (latest.completed) return latest;

    // Some OpenCode versions may not stamp completed time on the message item
    // immediately. If the authoritative session status is already idle, the
    // latest assistant text is still a better final source than Lily's live
    // buffer.
    let idle = false;
    try {
      idle = await this._withTimeout(
        Promise.resolve(this._server?.isSessionIdle ? this._server.isSessionIdle() : false),
        OpencodeAgentSession.STALLED_HISTORY_SYNC_MS,
        false,
      );
    } catch {
      idle = false;
    }
    return idle ? latest : null;
  }

  async _syncFinalOutputFromOfficialHistory(payload) {
    const current = String(payload?.output || "").trim();
    let latest = null;
    try {
      latest = await this._latestAssistantFromOfficialHistory();
    } catch (err) {
      log.warn("opencode final history sync failed: %s", err?.message || String(err));
      return payload;
    }
    const official = String(latest?.output || "").trim();
    if (!official) return payload;
    if (official !== current) {
      let missing = "";
      if (official.startsWith(current)) missing = official.slice(current.length);
      else if (!current) missing = official;
      if (missing) {
        this.collectedOutput = official;
        this._ingest([{ type: "assistant.delta", payload: { text: missing } }]);
      }
    }
    return {
      ...payload,
      output: official || current,
      engineMessageId: latest?.engineMessageId || payload?.engineMessageId || null,
      resultFromOfficialHistory: official !== current,
    };
  }

  _completeTurn(payload) {
    if (this._turnSettled) return;
    if (this._continueUnfinishedTodosBeforeCompletion(payload)) return;
    // Pillar 3-B completion gate: on a clean turn end, if the assistant claimed a
    // file deliverable that is actually missing/empty, inject ONE corrective
    // follow-up so the turn doesn't settle on a broken/hallucinated result. Fires
    // at most once per turn (_gatedThisTurn) so it can never loop, and only on a
    // success exit — never on errors/interrupts.
    if (
      !payload?.interrupted &&
      !payload?.stalled &&
      payload?.code === 0 &&
      !this._gatedThisTurn &&
      this._server &&
      process.env.LILY_DISABLE_COMPLETION_GATE !== "1"
    ) {
      const violation = detectIncompleteDeliverable(payload.output);
      if (violation) {
        this._gatedThisTurn = true;
        this._armResponseTimer();
        this._armProgressNoticeTimer();
        const note =
          `Completion check: you indicated the deliverable "${violation.path}" ` +
          `but it ${violation.reason}. Actually produce a valid file at that path ` +
          `(or correct your statement if no file was meant), then confirm. Do not claim done until it is real.`;
        (async () => {
          try {
            await this._server.sendPrompt({ text: note, files: [] });
          } catch (err) {
            // If the corrective prompt can't land, settle on the original result
            // rather than hang the turn.
            log.warn("completion gate follow-up failed: %s", err?.message || String(err));
            if (this.busy && !this._turnSettled) this._settleTurn(payload);
          }
        })();
        return; // keep the turn open for the corrective round
      }
    }
    this._settleTurn(payload);
  }

  _continueUnfinishedTodosBeforeCompletion(payload) {
    if (
      payload?.interrupted ||
      payload?.stalled ||
      payload?.code !== 0 ||
      !this._server ||
      this._pendingPermissions.size ||
      this._pendingQuestions.size ||
      process.env.LILY_DISABLE_TODO_COMPLETION_GATE === "1"
    ) {
      return false;
    }
    const snapshot = nativeTodoSnapshot(this._latestTodos);
    if (!snapshot.total || !snapshot.unfinished.length) return false;
    const maxAttempts = TODO_COMPLETION_GATE_MAX_ATTEMPTS;
    if (this._todoCompletionGateAttempts >= maxAttempts) {
      log.warn("unfinished todo completion gate reached max attempts", {
        sessionId: this.sessionId,
        unfinished: snapshot.unfinished.length,
        total: snapshot.total,
        attempts: this._todoCompletionGateAttempts,
      });
      this._settleTurn({
        ...payload,
        stalled: true,
        output: String(payload?.output || this.collectedOutput || "").trim(),
      });
      return true;
    }
    this._todoCompletionGateAttempts += 1;
    this._armResponseTimer();
    this._armProgressNoticeTimer();
    const note = buildTodoContinuationPrompt(snapshot, this._todoCompletionGateAttempts, maxAttempts);
    (async () => {
      try {
        await this._server.sendPrompt({ text: note, files: [] });
      } catch (err) {
        log.warn("unfinished todo continuation failed: %s", err?.message || String(err));
        if (this.busy && !this._turnSettled) this._settleTurn(payload);
      }
    })();
    return true;
  }

  _settleTurn(payload) {
    if (this._turnSettled) return;
    this._clearIdleSettleTimer();
    this._clearIdleProbeTimer();
    this._pendingCompletePayload = null;
    this._clearDispatchFailureTimer();
    this._clearPromptAcceptanceCheck();
    this._clearTransientFailureTimer();
    this._clearResponseTimer();
    this._clearProgressNoticeTimer();
    this._clearHealthProbe();
    this._clearTurnWatchdog();
    this._clearPendingPermissions();
    resetOpencodeRuntimeState(this._eventState);
    this._resetSubagentRuntimeStates();
    this._turnSettled = true;
    this.busy = false;
    this._pendingPromptPayload = null;
    this._activeTaskContract = null;
    this._sawEngineEvent = false;
    this._sawToolActivity = false;
    this._sawUnsafeToolActivity = false;
    this._toolReplaySafe.clear();
    this._activeTools.clear();
    this._lastGenericToolProgressNotice = "";
    this._transientReplayCount = 0;
    this._turnStartedAt = 0;
    this._latestTodos = [];
    this._latestTodosSignature = "";
    this._todoCompletionGateAttempts = 0;
    // Carry the turn's rewind anchor (engine message id) so the orchestrator can
    // record it on the turn — that's what session:rewind reverts to later.
    if (payload && typeof payload === "object" && this._turnEngineMessageId && !payload.engineMessageId) {
      payload.engineMessageId = this._turnEngineMessageId;
    }
    this._orchestrator?.notifyRunnerDone(this.sessionId, payload);
  }

  /** Rewind the engine session to a turn's anchor message (files + dropped
   *  context). Ensures the server is up/resumed first so a cold session can be
   *  rewound. Refuses while a turn is in flight. */
  async revert(engineMessageId) {
    if (!engineMessageId || this.busy) return false;
    const server = await this._ensureStarted();
    await server.revert(engineMessageId);
    return true;
  }

  /** Undo the last rewind (restore reverted messages + files). */
  async unrevert() {
    if (this.busy) return false;
    const server = await this._ensureStarted();
    await server.unrevert();
    return true;
  }

  async getConversationPage(opts = {}) {
    const server = await this._ensureStarted();
    const raw = await server.messages({
      limit: Number.isInteger(opts.limit) ? opts.limit : 50,
      before: opts.before || undefined,
    });
    const items = Array.isArray(raw?.data) ? raw.data : Array.isArray(raw) ? raw : [];
    const cursor = raw?.response?.headers?.get?.("x-next-cursor") || raw?.cursor || raw?.next || null;
    const { adaptOpencodeMessagesPage } = require("./runtime/opencode-conversation-adapter");
    return adaptOpencodeMessagesPage({
      items,
      sessionId: this.sessionId,
      cursor,
      complete: !cursor,
      before: opts.before || null,
    });
  }

  _failTurn(message, cause = null, opts = {}) {
    if (this._turnSettled) return false;
    if (!opts.force && this._shouldDeferTransientFailure(message, cause)) {
      this._scheduleTransientFailureRecovery(message, cause);
      return true;
    }
    if (cause) log.warn("opencode turn failed: %s", cause?.message || String(cause));
    this._clearIdleSettleTimer();
    this._clearIdleProbeTimer();
    this._pendingCompletePayload = null;
    this._clearDispatchFailureTimer();
    this._clearPromptAcceptanceCheck();
    this._clearTransientFailureTimer();
    this._clearResponseTimer();
    this._clearProgressNoticeTimer();
    this._clearHealthProbe();
    this._clearTurnWatchdog();
    this._clearPendingPermissions();
    resetOpencodeRuntimeState(this._eventState);
    this._resetSubagentRuntimeStates();
    this._turnSettled = true;
    this.busy = false;
    this._pendingPromptPayload = null;
    this._activeTaskContract = null;
    this._sawEngineEvent = false;
    this._sawToolActivity = false;
    this._sawUnsafeToolActivity = false;
    this._toolReplaySafe.clear();
    this._activeTools.clear();
    this._lastGenericToolProgressNotice = "";
    this._transientReplayCount = 0;
    this._turnStartedAt = 0;
    this._latestTodos = [];
    this._latestTodosSignature = "";
    this._todoCompletionGateAttempts = 0;
    this._orchestrator?.notifyRunnerError(this.sessionId, message);
    return false;
  }

  _shouldDeferTransientFailure(message, cause) {
    if (!this.busy || this._turnSettled || !this._server) return false;
    if (!this._sawEngineEvent || this.collectedOutput.trim()) return false;
    if (!cause) return false;
    const raw = transientClassificationText(message, cause);
    const classified = require("./agent-runner").classifyAssistantError(raw);
    return isRecoverableModelConnectionFailure(classified, raw);
  }

  _onServerExit(code) {
    if (this.busy && !this._turnSettled) {
      this._failTurn(`The assistant engine stopped unexpectedly (code ${code}).`);
    }
    this._server = null;
    this._starting = null;
  }

  /** The engine became unreachable (SSE gave up after retries, or a spawn error).
   *  Treat it as down: fail any in-flight turn so it can't hang, and drop the
   *  server so the next send spawns fresh and resumes the same session id. */
  _onServerError(err) {
    log.warn("server error: %s", err?.message || String(err));
    if (this.busy && !this._turnSettled) {
      const deferred = this._failTurn("The assistant engine became unreachable. Please retry.", err);
      if (deferred) return;
    }
    try { this._server?.terminate?.(); } catch { /* best effort */ }
    this._server = null;
    this._starting = null;
  }

  // --- helpers -------------------------------------------------------------

  _ingest(drafts) {
    if (!this._orchestrator || !Array.isArray(drafts) || drafts.length === 0) return;
    this._orchestrator.ingest(this.sessionId, drafts);
  }

  _clearPendingPermissions() {
    for (const requestId of this._pendingPermissions.keys()) {
      this._ingest([{ type: "permission.resolved", payload: { requestId, cancelled: true } }]);
    }
    this._pendingPermissions.clear();
    for (const requestId of this._pendingQuestions.keys()) {
      this._ingest([{ type: "user_question.resolved", payload: { requestId } }]);
    }
    this._pendingQuestions.clear();
  }

  // No-progress watchdog: re-armed on each progress action (see _handleEvent), so
  // it only fires after a full window with NO forward movement — a stuck/silent
  // turn — never during a long task that keeps progressing.
  _armResponseTimer() {
    this._clearResponseTimer();
    if (!this.busy || this._turnSettled) return;
    this._responseTimer = setTimeout(() => {
      this._forceEndTurn("no progress for the no-progress window");
    }, OpencodeAgentSession.TURN_RESPONSE_TIMEOUT_MS);
  }

  _clearResponseTimer() {
    if (this._responseTimer) {
      clearTimeout(this._responseTimer);
      this._responseTimer = null;
    }
  }

  // Armed once at turn start; NOT re-armed on activity. Force-ends a turn that
  // has run past the hard wall-clock budget even while still producing events
  // (runaway deep/wide subagent work). _forceEndTurn recovers any official output
  // and aborts the serve turn — graceful, not a crash.
  _armTurnWatchdog() {
    this._clearTurnWatchdog();
    if (!this.busy || this._turnSettled) return;
    const cap = OpencodeAgentSession.TURN_WATCHDOG_MS;
    if (!(cap > 0)) return; // 0 / unset disables the hard cap
    this._turnWatchdogTimer = setTimeout(() => {
      this._forceEndTurn("turn exceeded the maximum time budget");
    }, cap);
  }

  _clearTurnWatchdog() {
    if (this._turnWatchdogTimer) {
      clearTimeout(this._turnWatchdogTimer);
      this._turnWatchdogTimer = null;
    }
  }

  // Visible no-progress heartbeat: this is UX feedback only. It does not settle
  // or abort the turn; the generous no-progress watchdog remains responsible for
  // stopping genuinely stuck runs.
  _armProgressNoticeTimer() {
    this._clearProgressNoticeTimer();
    if (!this.busy || this._turnSettled) return;
    this._progressNoticeTimer = setTimeout(() => {
      this._emitLongWaitNotice();
    }, OpencodeAgentSession.PROGRESS_NOTICE_MS);
    this._progressNoticeTimer.unref?.();
  }

  _clearProgressNoticeTimer() {
    if (this._progressNoticeTimer) {
      clearTimeout(this._progressNoticeTimer);
      this._progressNoticeTimer = null;
    }
  }

  _emitLongWaitNotice() {
    this._progressNoticeTimer = null;
    if (!this.busy || this._turnSettled) return;
    if (this._knownSubagentSessionIDs.size > 0) return;
    if (this._emitGenericToolProgressNotice()) {
      this._armProgressNoticeTimer();
      return;
    }
    this._ingest([{
      type: "engine.notice",
      payload: {
        notice: {
          code: "longWait",
          level: "progress",
          panel: true,
          replace: true,
          replacesCode: "longWait",
        },
      },
    }]);
  }

  _genericToolProgressDetail() {
    const running = [...this._activeTools.values()].filter((tool) => tool?.id);
    if (!running.length) return "";
    running.sort((a, b) => (b.lastActivityAt || 0) - (a.lastActivityAt || 0));
    const now = Date.now();
    const tool = running[0];
    const label = compactProgressText(tool.title || buildToolPreviewLabel(tool) || tool.name || "Tool");
    const elapsed = formatDuration(now - (tool.startedAt || now));
    const idle = Math.max(0, now - (tool.lastActivityAt || tool.startedAt || now));
    const activity = idle >= TOOL_PROGRESS_STALE_MS
      ? `最近活动 ${formatDuration(idle)} 前`
      : "仍有活动";
    if (running.length > 1) {
      return `${running.length} 个工具运行中 · 当前：${label} · 已运行 ${elapsed} · ${activity}`;
    }
    return `${label} 正在运行 · 已运行 ${elapsed} · ${activity}`;
  }

  _emitGenericToolProgressNotice() {
    const detail = this._genericToolProgressDetail();
    if (!detail) return false;
    if (detail === this._lastGenericToolProgressNotice) return true;
    this._lastGenericToolProgressNotice = detail;
    this._ingest([{
      type: "engine.notice",
      payload: {
        notice: {
          code: "toolProgress",
          level: "progress",
          panel: true,
          replace: true,
          replacesCode: "genericToolProgress",
          detail,
        },
      },
    }]);
    return true;
  }

  /** Give up on a stuck turn: abort the engine (so it isn't left working/looping
   *  orphaned) then settle, so the UI can't sit in "正在处理" forever. */
  _forceEndTurn(reason) {
    if (!this.busy || this._turnSettled) return;
    log.warn("opencode turn force-ended: %s", reason, { sessionId: this.sessionId });
    void (async () => {
      const recovered = await this._recoverStalledFinalFromOfficialState().catch((err) => {
        log.warn("opencode stalled history sync failed: %s", err?.message || String(err));
        return null;
      });
      if (!this.busy || this._turnSettled) return;
      if (recovered?.output) {
        this._completeTurn({
          code: 0,
          output: recovered.output,
          interrupted: false,
          engineMessageId: recovered.engineMessageId || null,
          resultFromOfficialHistory: true,
          recoveredFromStall: true,
        });
        return;
      }
      try { void this._server?.abort?.().catch(() => {}); } catch { /* best effort */ }
      this._completeTurn({ code: 0, output: this.collectedOutput.trim(), stalled: true });
    })();
  }

  /** Active liveness probe during a turn. The silence watchdog can't tell a wedged
   *  server from a model thinking quietly; this polls /global/health and fails the
   *  turn fast ONLY when health actually fails N times in a row — so a slow-but-
   *  healthy turn is never killed, but a dead/wedged engine is caught in ~90s
   *  instead of the 300s silence timeout. */
  _armHealthProbe() {
    this._clearHealthProbe();
    this._healthFails = 0;
    const tick = async () => {
      this._healthTimer = null;
      if (!this.busy || this._turnSettled || !this._server) return;
      const ok = await this._server.checkHealth().catch(() => false);
      if (!this.busy || this._turnSettled || !this._server) return;
      if (ok) {
        this._healthFails = 0;
      } else if (++this._healthFails >= OpencodeAgentSession.HEALTH_MAX_FAILS) {
        log.warn("opencode health probe failed %d× — engine wedged/unreachable", this._healthFails, {
          sessionId: this.sessionId,
        });
        this._onServerError(new Error("engine health check failed (wedged or unreachable)"));
        return;
      }
      this._healthTimer = setTimeout(tick, OpencodeAgentSession.HEALTH_PROBE_MS);
      this._healthTimer.unref?.();
    };
    this._healthTimer = setTimeout(tick, OpencodeAgentSession.HEALTH_PROBE_MS);
    this._healthTimer.unref?.();
  }

  _clearHealthProbe() {
    if (this._healthTimer) {
      clearTimeout(this._healthTimer);
      this._healthTimer = null;
    }
    this._healthFails = 0;
  }

  _sanitize(message) {
    return require("./agent-runner").sanitizeError(message);
  }
}

// Stall watchdog: how long with NO events at all before a turn is treated as
// stuck. It resets on every event (see _handleEvent), so this is a silence
// threshold, not a cap on turn length — it must outlast a single long, quiet
// tool (e.g. a multi-minute build/test). Override with LILY_OPENCODE_TURN_TIMEOUT_MS.
// No-PROGRESS window: how long with no meaningful action (text/thinking/tool
// activity) before a turn is treated as stuck and force-ended. It resets on every
// progress action — NOT on heartbeats — so a long task that keeps making progress
// (e.g. an hour of file conversion) runs to completion, while a turn that's only
// pinging "busy" with nothing happening is caught. Generous so a single slow step
// isn't killed; the engine's own per-tool timeout bounds a truly silent command.
OpencodeAgentSession.TURN_RESPONSE_TIMEOUT_MS =
  Number(process.env.LILY_OPENCODE_TURN_TIMEOUT_MS) || 600_000;
// Shorter visible no-progress window. This only feeds the live process panel so
// users can see the engine is still alive while OpenCode is quiet.
OpencodeAgentSession.PROGRESS_NOTICE_MS =
  Number(process.env.LILY_OPENCODE_PROGRESS_NOTICE_MS) || 45_000;
// HARD wall-clock turn cap (distinct from the no-progress window above). Unlike
// that window, this does NOT reset on activity — it bounds total turn time so an
// actively-runaway turn (deep/wide subagent work that keeps emitting events) can't
// run unbounded. Deliberately GENEROUS so it does not clip a legitimately long but
// progressing turn (big build, hour-scale conversion); the step budget + depth cap
// are the primary runaway bounds, this is the final time backstop. _forceEndTurn
// recovers any official output. Override / disable (0) with LILY_OPENCODE_TURN_MAX_MS.
OpencodeAgentSession.TURN_WATCHDOG_MS =
  process.env.LILY_OPENCODE_TURN_MAX_MS !== undefined
    ? Number(process.env.LILY_OPENCODE_TURN_MAX_MS) || 0
    : 60 * 60_000;
// Bounded official-history sync before declaring a no-progress turn stalled.
// This mirrors the official app's source-of-truth model without letting the
// watchdog itself hang on an unhealthy server.
OpencodeAgentSession.STALLED_HISTORY_SYNC_MS =
  Number(process.env.LILY_OPENCODE_STALLED_HISTORY_SYNC_MS) || 2_500;
// Mirrors OpenCode's own "confirm idle after events have drained" behavior:
// do not finalize on the same tick as session.idle, because late text deltas can
// still be queued behind it in the shared event stream.
OpencodeAgentSession.IDLE_SETTLE_MS =
  Number(process.env.LILY_OPENCODE_IDLE_SETTLE_MS) || 750;
// Recovery path for a missed/unroutable session.idle event. After meaningful
// progress, poll the authoritative OpenCode session status; if it is idle, sync
// the final answer from official history and settle. This is deliberately
// separate from the reducer: session.status alone remains a snapshot, but the
// runner can use it as a source-of-truth confirmation after real turn activity.
OpencodeAgentSession.IDLE_STATUS_PROBE_MS =
  Number(process.env.LILY_OPENCODE_IDLE_STATUS_PROBE_MS) || 2_500;
// promptAsync is fire-and-forget: a transport-level failure can be reported
// after OpenCode already accepted the turn. Wait briefly for SSE activity before
// telling the user the model connection failed.
OpencodeAgentSession.DISPATCH_FAILURE_GRACE_MS =
  Number(process.env.LILY_OPENCODE_DISPATCH_FAILURE_GRACE_MS) || 12_000;
// If a transient transport/server error arrives after the turn is already proven
// to have reached OpenCode, do not fail the UI immediately. The official session
// state/history is authoritative; poll briefly and either recover the completed
// assistant message or keep waiting for live events.
OpencodeAgentSession.TRANSIENT_FAILURE_RECOVERY_POLL_MS =
  Number(process.env.LILY_OPENCODE_TRANSIENT_RECOVERY_POLL_MS) || 2_000;
OpencodeAgentSession.TRANSIENT_FAILURE_RECOVERY_MS =
  Number(process.env.LILY_OPENCODE_TRANSIENT_RECOVERY_MS) || 120_000;
// Active health probe during a turn: poll every PROBE_MS, declare the engine dead
// only after MAX_FAILS consecutive failures (so a slow-but-healthy turn survives).
OpencodeAgentSession.HEALTH_PROBE_MS = Number(process.env.LILY_OPENCODE_HEALTH_PROBE_MS) || 30_000;
OpencodeAgentSession.HEALTH_MAX_FAILS = Number(process.env.LILY_OPENCODE_HEALTH_MAX_FAILS) || 3;

/**
 * Coerce the host's question response ({ answers, response? }) into OpenCode's
 * string[][] — one array of selected option labels per question, in order.
 * @param {{ answers?: unknown, response?: string }} response
 * @param {Array<{header?:string, question?:string}>} questions
 */
function toOpencodeAnswers(response, questions) {
  const ans = response && response.answers;
  return (questions || []).map((q, i) => {
    let v;
    if (Array.isArray(ans)) v = ans[i];
    else if (ans && typeof ans === "object") v = ans[q.header] ?? ans[q.question] ?? ans[i];
    if (v == null && response && response.response) v = response.response;
    if (Array.isArray(v)) return v.map(String);
    if (v == null || v === "") return [];
    return [String(v)];
  });
}

module.exports = { OpencodeAgentSession, detectIncompleteDeliverable };
