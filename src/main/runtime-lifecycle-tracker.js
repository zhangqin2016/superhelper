"use strict";

function compactValue(value) {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (!value || typeof value !== "object") return "";
  for (const key of ["message", "summary", "detail", "title", "name", "status", "currentStep", "current_step", "step"]) {
    const text = compactValue(value[key]);
    if (text) return text;
  }
  return "";
}

function activityKey(activity = {}) {
  if (activity.id) return String(activity.id);
  const type = String(activity.type || "");
  const subtype = String(activity.subtype || "");
  if (subtype.startsWith("task_")) return "task:default";
  if (type === "hook" && subtype.startsWith("task_")) return "task:default";
  if (subtype.includes("subagent")) return "subagent:default";
  if (subtype === "status") return "status:default";
  return `${type || "runtime"}:${subtype || "activity"}`;
}

function isCompletion(activity = {}) {
  const subtype = String(activity.subtype || "").toLowerCase();
  return Boolean(activity.short) ||
    subtype.endsWith("_complete") ||
    subtype.endsWith("_completed") ||
    subtype.endsWith("_failed") ||
    subtype === "task_completed" ||
    subtype === "task_failed" ||
    subtype === "subagent_stop" ||
    subtype === "hook_task_completed" ||
    subtype === "hook_subagent_stop";
}

class RuntimeLifecycleTracker {
  constructor({ timers, emitNotice, isTurnLive, heartbeatMs }) {
    this._timers = timers;
    this._emitNotice = emitNotice;
    this._isTurnLive = isTurnLive;
    this._heartbeatMs = heartbeatMs;
    this._leases = new Map();
  }

  reset() {
    this._leases.clear();
    this._timers.clearPrefix("runtimeLifecycle:");
  }

  pendingCount() {
    return this._leases.size;
  }

  pendingKeys() {
    return [...this._leases.keys()];
  }

  ingestActivity(activity = {}) {
    if (!activity || typeof activity !== "object") return { changed: false, active: false };
    if (isCompletion(activity)) {
      const changed = this._finish(activity);
      return { changed, active: false };
    }
    return this._startOrUpdate(activity);
  }

  completeAll() {
    const had = this._leases.size > 0;
    this.reset();
    return had;
  }

  ingestHook(action = {}) {
    switch (action.kind) {
      case "hook_task_created":
        return this.ingestActivity({
          type: "hook",
          subtype: "task_created",
          id: action.hookEvent?.task_id || action.hookEvent?.taskId || "",
          detail: compactValue(action.hookEvent),
        });
      case "hook_task_completed":
        return this.ingestActivity({
          type: "hook",
          subtype: "task_completed",
          id: action.hookEvent?.task_id || action.hookEvent?.taskId || "",
        });
      case "hook_subagent_start":
        return this.ingestActivity({
          type: "hook",
          subtype: "subagent_start",
          id: action.hookEvent?.subagent_id || action.hookEvent?.subagentId || "",
          detail: compactValue(action.hookEvent),
        });
      case "hook_subagent_stop":
        return this.ingestActivity({
          type: "hook",
          subtype: "subagent_stop",
          id: action.hookEvent?.subagent_id || action.hookEvent?.subagentId || "",
        });
      default:
        return { changed: false, active: this.pendingCount() > 0 };
    }
  }

  emitHeartbeat(reason = "runtime-active") {
    const lease = this._firstLease();
    if (!lease) return;
    this._emitNotice({
      code: "taskProgress",
      level: "progress",
      panel: true,
      replace: true,
      detail: this._formatDetail(lease),
      reason,
    });
  }

  _startOrUpdate(activity = {}) {
    const key = activityKey(activity);
    const previous = this._leases.get(key);
    const now = Date.now();
    const detail = compactValue(activity.detail || activity.message || activity.status || activity);
    this._leases.set(key, {
      key,
      type: String(activity.type || ""),
      subtype: String(activity.subtype || ""),
      detail: detail || previous?.detail || "",
      startedAt: previous?.startedAt || now,
      updatedAt: now,
    });
    this._armHeartbeat();
    return { changed: true, active: true };
  }

  _finish(activity = {}) {
    const key = activityKey(activity);
    let changed = this._leases.delete(key);
    if (!changed && key !== "task:default") changed = this._leases.delete("task:default");
    if (!changed && key !== "subagent:default") changed = this._leases.delete("subagent:default");
    if (isCompletion(activity) && key !== "status:default") {
      changed = this._leases.delete("status:default") || changed;
    }
    if (this._leases.size === 0) this._timers.clear("runtimeLifecycle:heartbeat");
    return changed;
  }

  _firstLease() {
    return this._leases.values().next().value || null;
  }

  _formatDetail(lease = {}) {
    const elapsedMs = Math.max(0, Date.now() - Number(lease.startedAt || Date.now()));
    const minutes = Math.floor(elapsedMs / 60_000);
    const elapsed = minutes > 0 ? ` · running ${minutes}m` : "";
    return `${lease.detail || lease.subtype || "Task is still running"}${elapsed}`;
  }

  _armHeartbeat() {
    if (this._timers.has("runtimeLifecycle:heartbeat")) return;
    this._timers.arm("runtimeLifecycle:heartbeat", this._heartbeatMs(), () => {
      if (!this._isTurnLive() || this._leases.size === 0) return;
      this.emitHeartbeat("runtime-heartbeat");
      this._armHeartbeat();
    });
  }
}

module.exports = { RuntimeLifecycleTracker };
