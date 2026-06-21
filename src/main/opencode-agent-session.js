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
 * It is deliberately SIMPLER than AgentSession: OpenCode emits explicit
 * step.ended / tool.success / permission events, so none of Claude CLI's
 * quiesce/idle/message-stop heuristics are needed. Turn completion is driven by
 * the normalizer's `turn_result` action (emitted only on a terminal,
 * non-tool-calls step), not by silence timers.
 *
 * Transport (HTTP/SSE + the serve process) is OpencodeServerManager; SSE -> the
 * shared action vocabulary is OpencodeEventAdapter. This class is the glue:
 * lifecycle + dispatch + the runtime-draft egress, mirroring AgentSession's
 * _handleLine tail exactly so the renderer is byte-for-byte engine-neutral.
 */

const { EventEmitter } = require("node:events");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");
const { OpencodeServerManager } = require("./runtime/opencode-server-manager");
const { OpencodeEventAdapter } = require("./runtime/adapters/opencode-cli-adapter");
const { truncateToolResultForUi, processEventFromClaudeEvent } = require("./cli-process-payload");
const { getLogger } = require("./logger");

const log = getLogger("opencode-agent-session");

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

class OpencodeAgentSession extends EventEmitter {
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
    this._adapter = new OpencodeEventAdapter();
    this.cwd = null;
    this.spawnOptions = null;
    this.agentResumeId = null;
    this.busy = false;
    this._turnSettled = true;
    this._starting = null;
    this._sawActivity = false;
    this.collectedOutput = "";
    /** Completion gate (Pillar 3-B) fires at most ONCE per turn — guards against loops. */
    this._gatedThisTurn = false;
    /** @type {Set<string>} pending permission request ids awaiting a host reply. */
    this._pendingPermissions = new Set();
    /** @type {Map<string, Array>} pending question id -> its questions (for answer mapping). */
    this._pendingQuestions = new Map();
    this._orchestrator = null;
    /** @type {ReturnType<typeof setTimeout> | null} */
    this._responseTimer = null;
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

  /** Per-session SQLite path — persistent (userData) so conversation history
   *  survives restarts; falls back to a temp dir when userData isn't bound. */
  _dataDir() {
    if (this.spawnOptions?.dataDir) return this.spawnOptions.dataDir;
    let base;
    try {
      base = require("./config").opencodeSessionDir(this.sessionId);
    } catch {
      base = path.join(os.tmpdir(), "lily-opencode", this.sessionId);
    }
    fs.mkdirSync(base, { recursive: true });
    return path.join(base, "opencode.db");
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
      server.on("error", (err) => log.warn("server error: %s", err?.message || String(err)));
      await server.start();
      const id = await server.createSession();
      server.subscribe();
      this._server = server;
      this.agentResumeId = id;
      this.emit("agent-resume-id", id);
      return server;
    })();
    this._starting.catch((err) => {
      this._starting = null;
      log.warn("opencode start failed: %s", err?.message || String(err));
      if (this.busy && !this._turnSettled) this._failTurn(this._sanitize(err?.message));
    });
    return this._starting;
  }

  isAlive() {
    // "Alive" includes the async startup window: the Claude runner spawns
    // synchronously, but OpenCode's `serve` comes up over HTTP, so ensureProcess
    // returns before the server is ready. Treating an in-flight start as alive
    // lets the orchestrator's spawn:true preflight pass (otherwise every send
    // fails "Unable to start the assistant process").
    return Boolean((this._server && this._server.process) || this._starting);
  }

  isBusy() {
    return this.busy;
  }

  // --- outbound ------------------------------------------------------------

  /** @param {{ text?: string, files?: Array<object> } | string} payload */
  sendUserMessage(payload) {
    if (this.busy) return false;
    const text = typeof payload === "string" ? payload : payload?.text;
    const files = typeof payload === "object" && payload?.files ? payload.files : [];
    if (!text && (!files || files.length === 0)) return false;

    this.busy = true;
    this._turnSettled = false;
    this._sawActivity = false;
    this._gatedThisTurn = false;
    this.collectedOutput = "";
    this._armResponseTimer();

    (async () => {
      try {
        const server = await this._ensureStarted();
        await server.sendPrompt({ text, files });
      } catch (err) {
        // The turn is driven by SSE (session.idle/events). If events already
        // arrived, a hiccup on the blocking message POST is NOT a turn failure —
        // let SSE finish. Only fail if nothing ever came through (prompt didn't land).
        if (this.busy && !this._turnSettled && !this._sawActivity) {
          this._failTurn(this._sanitize(err?.message));
        }
      }
    })();
    return true;
  }

  respondPermission(requestId, decision = {}) {
    if (!this._pendingPermissions.has(requestId)) return false;
    this._pendingPermissions.delete(requestId);
    const reply = decision.allow ? (decision.remember ? "always" : "once") : "reject";
    void this._server
      ?.respondPermission(requestId, { reply, message: decision.message })
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
    const questions = this._pendingQuestions.get(requestId);
    if (!questions) return false;
    this._pendingQuestions.delete(requestId);
    const answers = toOpencodeAnswers(response, questions);
    void this._server
      ?.respondQuestion(requestId, answers)
      .catch((err) => log.warn("question reply failed: %s", err?.message || String(err)));
    this._ingest([{ type: "user_question.resolved", payload: { requestId } }]);
    return true;
  }

  respondHook() { return false; }
  reloadSkills() { return false; }

  updateEnvironmentVariables() {
    // capability hotEnvUpdate=false: env is fixed at serve start.
    return true;
  }

  setPermissionMode(mode) {
    if (this.spawnOptions) this.spawnOptions.permissionMode = mode;
    // OpenCode bakes the permission ruleset into the config at serve start and
    // cannot hot-swap it. Report "not applied live" so the pool (applyPermissionMode)
    // terminates the idle runner; the next send then spawns fresh with the new mode
    // and resumes the same session id, so the permission change applies without
    // losing conversation context.
    return false;
  }

  interrupt() {
    this._clearPendingPermissions();
    if (this._server) void this._server.abort().catch(() => {});
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
    this._clearResponseTimer();
    this._clearPendingPermissions();
    if (this._server) {
      this._server.terminate();
      this._server = null;
    }
    this._starting = null;
    this.busy = false;
    this._turnSettled = true;
    this.cwd = null;
    this.spawnOptions = null;
  }

  // --- inbound: SSE event -> actions -> drafts -----------------------------

  _handleEvent(ev) {
    // Any event is a sign the stream is alive: reset the stall watchdog so a long
    // but active turn (extended thinking, a slow tool, a subagent) is never killed
    // mid-work. Only true silence — no events for the full window — trips the
    // stalled completion. (Before this, the timer was a hard cap on total turn
    // duration, so a >2min agentic turn reported "no final result" while running.)
    this._armResponseTimer();

    let normalized;
    try {
      normalized = this._adapter.normalizeEvent(ev);
    } catch (err) {
      log.warn("opencode adapter failed: %s", err?.message || String(err));
      return;
    }

    // Any meaningful action means the engine is actively handling our turn —
    // a later message-POST hiccup must not fail it (see sendUserMessage).
    if (normalized.actions.length) this._sawActivity = true;

    for (const action of normalized.actions) {
      this._handleAction(action);
    }

    // Mirror AgentSession._handleLine's draft egress so the renderer pipeline is
    // identical: relocate tool.done content -> result (truncated), append the
    // process.event timeline draft, then hand the batch to the orchestrator.
    const drafts = [...(normalized.runtimeEvents || [])];
    for (const draft of drafts) {
      if (draft.type !== "tool.done") continue;
      const raw = draft.payload?.content;
      if (typeof raw !== "string" || !raw) continue;
      draft.payload.result = truncateToolResultForUi(raw);
      delete draft.payload.content;
    }
    drafts.push({
      type: "process.event",
      payload: processEventFromClaudeEvent(ev, normalized.actions || []),
    });
    this._ingest(drafts);
  }

  _handleAction(action) {
    switch (action.kind) {
      case "assistant_text":
        this.collectedOutput += action.text || "";
        this._armResponseTimer();
        break;

      case "permission_check":
        // capability permissionAlwaysAsk: the server only asks once it has
        // already decided to; the host always surfaces the dialog.
        this._pendingPermissions.add(action.requestId);
        this._ingest([{
          type: "permission.requested",
          payload: {
            requestId: action.requestId,
            toolName: action.toolName,
            input: action.input || {},
            title: action.title || "",
            description: action.description || "",
            decisionReason: action.decisionReason || "",
            suggestions: action.suggestions || [],
            planPreview: "",
            planPreviewTruncated: false,
          },
        }]);
        break;

      case "ask_user_question": {
        const questions = (action.input && action.input.questions) || [];
        this._pendingQuestions.set(action.requestId, questions);
        this._ingest([{
          type: "user_question.requested",
          payload: { requestId: action.requestId, questions },
        }]);
        break;
      }

      case "turn_result": {
        const ev = action.event || {};
        this._completeTurn({
          code: ev.is_error ? 1 : 0,
          output: this.collectedOutput.trim(),
          interrupted: false,
        });
        break;
      }

      case "stream_message_delta":
        // Token usage from a step-finish — record it for cost/usage tracking.
        // (The usage.updated runtime draft for the renderer is produced
        // engine-agnostically by runtimeEventFromAction.)
        if (action.usage && typeof action.usage === "object") {
          try {
            require("./usage-reporter").recordModelUsage(this.sessionId, action.usage);
          } catch (err) {
            log.warn("usage record failed: %s", err?.message || String(err));
          }
        }
        break;

      case "runtime_error":
        this._failTurn(this._sanitize(action.event?.message) || "Engine error");
        break;

      default:
        // Streaming text/thinking/tool actions need no extra state here — their
        // runtime drafts already carry everything the renderer needs.
        break;
    }
  }

  // --- turn settlement -----------------------------------------------------

  _completeTurn(payload) {
    if (this._turnSettled) return;
    // Pillar 3-B completion gate: on a clean turn end, if the assistant claimed a
    // file deliverable that is actually missing/empty, inject ONE corrective
    // follow-up so the turn doesn't settle on a broken/hallucinated result. Fires
    // at most once per turn (_gatedThisTurn) so it can never loop, and only on a
    // success exit — never on errors/interrupts.
    if (
      !payload?.interrupted &&
      payload?.code === 0 &&
      !this._gatedThisTurn &&
      this._server &&
      process.env.LILY_DISABLE_COMPLETION_GATE !== "1"
    ) {
      const violation = detectIncompleteDeliverable(payload.output);
      if (violation) {
        this._gatedThisTurn = true;
        this._armResponseTimer();
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

  _settleTurn(payload) {
    if (this._turnSettled) return;
    this._clearResponseTimer();
    this._clearPendingPermissions();
    this._adapter.reset();
    this._turnSettled = true;
    this.busy = false;
    this._orchestrator?.notifyRunnerDone(this.sessionId, payload);
  }

  _failTurn(message) {
    if (this._turnSettled) return;
    this._clearResponseTimer();
    this._clearPendingPermissions();
    this._adapter.reset();
    this._turnSettled = true;
    this.busy = false;
    this._orchestrator?.notifyRunnerError(this.sessionId, message);
  }

  _onServerExit(code) {
    if (this.busy && !this._turnSettled) {
      this._failTurn(`The assistant engine stopped unexpectedly (code ${code}).`);
    }
    this._server = null;
    this._starting = null;
  }

  // --- helpers -------------------------------------------------------------

  _ingest(drafts) {
    if (!this._orchestrator || !Array.isArray(drafts) || drafts.length === 0) return;
    this._orchestrator.ingest(this.sessionId, drafts);
  }

  _clearPendingPermissions() {
    for (const requestId of this._pendingPermissions) {
      this._ingest([{ type: "permission.resolved", payload: { requestId, cancelled: true } }]);
    }
    this._pendingPermissions.clear();
    for (const requestId of this._pendingQuestions.keys()) {
      this._ingest([{ type: "user_question.resolved", payload: { requestId } }]);
    }
    this._pendingQuestions.clear();
  }

  _armResponseTimer() {
    this._clearResponseTimer();
    if (!this.busy || this._turnSettled) return;
    this._responseTimer = setTimeout(() => {
      if (!this.busy || this._turnSettled) return;
      log.warn("opencode turn timed out with no terminal event", { sessionId: this.sessionId });
      this._completeTurn({ code: 0, output: this.collectedOutput.trim(), stalled: true });
    }, OpencodeAgentSession.TURN_RESPONSE_TIMEOUT_MS);
  }

  _clearResponseTimer() {
    if (this._responseTimer) {
      clearTimeout(this._responseTimer);
      this._responseTimer = null;
    }
  }

  _sanitize(message) {
    return require("./agent-runner").sanitizeError(message);
  }
}

// Stall watchdog: how long with NO events at all before a turn is treated as
// stuck. It resets on every event (see _handleEvent), so this is a silence
// threshold, not a cap on turn length — it must outlast a single long, quiet
// tool (e.g. a multi-minute build/test). Override with LILY_OPENCODE_TURN_TIMEOUT_MS.
OpencodeAgentSession.TURN_RESPONSE_TIMEOUT_MS =
  Number(process.env.LILY_OPENCODE_TURN_TIMEOUT_MS) || 300_000;

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
