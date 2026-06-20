"use strict";

/**
 * OpenCode engine adapter: turns one OpenCode SSE event into normalized actions
 * + runtime-event drafts. The `normalizeEvent(ev) -> envelope` contract and the
 * action vocabulary are engine-neutral (shared via runtime-event-translator), so
 * the orchestration layer stays engine-agnostic. OpenCode is driven over HTTP +
 * SSE rather than stdin/stdout stream-json, but that transport lives in the
 * server manager, not here.
 */

const { normalizeOpencodeEvent } = require("./opencode-event-normalizer");
const {
  runtimeEventFromAction,
  isWarningAction,
} = require("./runtime-event-translator");

class OpencodeEventAdapter {
  constructor(options = {}) {
    this.name = "opencode";
    this.serverVersion = options.serverVersion || null;
    /** Cross-event state: tool-call de-dup (callID -> "started"|"done") and
     *  part type tracking (partID -> "text"|"reasoning"|...) so streamed deltas
     *  are classified by their owning part, not the (sometimes wrong) delta field. */
    this._state = { tools: new Map(), parts: new Map() };
    /**
     * Capability declaration consumed by the orchestration layer. The host MUST
     * honour these instead of assuming a stdin/stream-json CLI's semantics.
     */
    this.capabilities = Object.freeze({
      /**
       * OpenCode does NOT take stream-json on stdin. Messages are POSTed to the
       * server and the long-lived `opencode serve` process is reused across
       * turns — so the per-turn-respawn fallback must not kick in, but stdin
       * write paths must not be used either.
       */
      streamInput: false,
      /** Emits reasoning deltas -> assistant.thinking.delta. */
      emitsThinking: true,
      /** No update_environment_variables hot-swap; env is fixed at serve start. */
      hotEnvUpdate: false,
      /**
       * Permission decisions are made by the server's own ruleset; it only
       * emits `permission.v2.asked` once it has already decided to ask. The host
       * must therefore ALWAYS surface the dialog for a permission_check and must
       * NOT re-run Claude-style needsUserApproval policy.
       */
      permissionControl: true,
      permissionAlwaysAsk: true,
      /** Sessions are server-side persistent; "resume" = reuse the sessionID. */
      resume: true,
    });
  }

  /**
   * @param {Record<string, unknown>} ev A parsed OpenCode SSE event.
   * @returns {{ adapter: string, rawType: string, actions: Array, runtimeEvents: Array, warnings: Array, backgroundActivity: null }}
   */
  /** Drop per-turn state (call between turns). */
  reset() {
    this._state.tools.clear();
    this._state.parts.clear();
  }

  normalizeEvent(ev) {
    const actions = normalizeOpencodeEvent(ev, this._state);
    const runtimeEvents = actions
      .map((action) => {
        const draft = runtimeEventFromAction(action);
        if (draft) draft.source = this.name;
        return draft;
      })
      .filter(Boolean);
    const warnings = actions.filter(isWarningAction);
    return {
      adapter: this.name,
      rawType: typeof ev?.type === "string" ? ev.type : "",
      rawSubtype: "",
      actions,
      runtimeEvents,
      warnings,
      // OpenCode has no detached/background-shell heuristic equivalent yet; the
      // server reports completion explicitly via tool.success.
      backgroundActivity: null,
    };
  }
}

module.exports = { OpencodeEventAdapter };
