"use strict";

const {
  compactCommand,
  isShellTool,
  isDetachedShellInput,
} = require("./runtime/runtime-activity");

/**
 * Tracks tool leases for one AgentSession turn: which tool calls are still
 * outstanding (blocking turn completion), which are detached/background, and
 * the long-running-shell heartbeat notices. Owns the lease-domain turn state
 * that used to live as loose fields on AgentSession.
 *
 * Timers go through the shared TimerBank under the "lease:" namespace.
 */
class ToolLeaseTracker {
  /**
   * @param {object} deps
   * @param {import("./turn-timers").TimerBank} deps.timers
   * @param {(notice: object) => void} deps.emitNotice
   * @param {() => boolean} deps.isTurnLive busy && not settled
   * @param {() => { noticeMs: number, heartbeatMs: number }} deps.delays
   *   Read at arm time, not construction — timing config may change (tests
   *   shrink the AgentSession statics after instances exist).
   */
  constructor({ timers, emitNotice, isTurnLive, delays }) {
    this._timers = timers;
    this._emitNotice = emitNotice;
    this._isTurnLive = isTurnLive;
    this._delays = delays;
    /** @type {Map<string, { name: string, input: Record<string, unknown>, detached: boolean, startedAt: number }>} */
    this._leases = new Map();
    /** @type {Set<string>} — non-detached tool ids still awaiting tool_result */
    this._pendingIds = new Set();
    this._hadBlockingToolUse = false;
  }

  track(toolId, name, input = {}) {
    if (!toolId) return { detached: false, becameDetached: false };
    const prev = this._leases.get(toolId);
    const nextName = name || prev?.name || "unknown";
    const nextInput = input && Object.keys(input).length > 0 ? input : prev?.input || {};
    const detached = isDetachedShellInput(nextName, nextInput);
    const becameDetached = detached && !prev?.detached;

    this._leases.set(toolId, {
      name: nextName,
      input: nextInput,
      detached,
      startedAt: prev?.startedAt || Date.now(),
    });

    if (detached) this._pendingIds.delete(toolId);
    else {
      this._pendingIds.add(toolId);
      this._hadBlockingToolUse = true;
    }
    if (detached && becameDetached) {
      this._hadBlockingToolUse = [...this._leases.values()].some((entry) => !entry.detached);
    }

    if (detached) {
      this._timers.clear(`lease:${toolId}`);
    } else if (isShellTool(nextName) && !this._timers.has(`lease:${toolId}`)) {
      this._armNoticeTimer(toolId, this._delays().noticeMs);
    }
    return { detached, becameDetached };
  }

  updateInput(toolId, input = {}) {
    if (!toolId) return { detached: false, becameDetached: false };
    const prev = this._leases.get(toolId);
    if (!prev) return { detached: false, becameDetached: false };
    return this.track(toolId, prev.name, input);
  }

  finish(toolId) {
    let id = toolId;
    if (!id && this._pendingIds.size === 1) {
      id = [...this._pendingIds][0];
    }
    if (!id) return;
    this._pendingIds.delete(id);
    this._leases.delete(id);
    this._timers.clear(`lease:${id}`);
  }

  reset() {
    this._pendingIds.clear();
    this._leases.clear();
    this._hadBlockingToolUse = false;
    this._timers.clearPrefix("lease:");
  }

  get(toolId) {
    return this._leases.get(toolId);
  }

  pendingCount() {
    return this._pendingIds.size;
  }

  pendingIds() {
    return [...this._pendingIds];
  }

  hadBlockingToolUse() {
    return this._hadBlockingToolUse;
  }

  /** Emits the right "still working" notice for the watchdog heartbeat. */
  emitBlockingWorkHeartbeat(reason = "long-running") {
    const shellLease = [...this._leases.values()].find(
      (lease) => !lease.detached && isShellTool(lease.name),
    );
    if (shellLease) {
      this._emitNotice({
        code: "shellLongRunning",
        level: "progress",
        panel: true,
        replace: true,
        toolName: shellLease.name,
        detail: this._formatDetail(shellLease),
        reason,
      });
      return;
    }
    if (this._pendingIds.size > 0) {
      this._emitNotice({
        code: "taskProgress",
        level: "progress",
        panel: true,
        replace: true,
        detail: "Task is still running",
        reason,
      });
    }
  }

  _formatDetail(lease = {}) {
    const command = compactCommand(lease.input || {}).slice(0, 160);
    const elapsedMs = Math.max(0, Date.now() - Number(lease.startedAt || Date.now()));
    const minutes = Math.floor(elapsedMs / 60_000);
    const elapsed = minutes > 0 ? ` · running ${minutes}m` : "";
    return `${command || lease.name || "command"}${elapsed}`;
  }

  _armNoticeTimer(toolId, delayMs) {
    this._timers.arm(`lease:${toolId}`, delayMs, () => {
      if (!this._isTurnLive()) return;
      const lease = this._leases.get(toolId);
      if (!lease || lease.detached || !isShellTool(lease.name)) return;
      this._emitNotice({
        code: "shellLongRunning",
        level: "progress",
        panel: true,
        replace: true,
        toolName: lease.name,
        detail: this._formatDetail(lease),
      });
      this._armNoticeTimer(toolId, this._delays().heartbeatMs);
    });
  }
}

module.exports = { ToolLeaseTracker };
