"use strict";

const { createRuntimeEvent, isTerminalEvent } = require("./runtime-event-schema");

const POST_TERMINAL_ALLOWED = new Set([
  "queue.updated",
  "user.committed",
  "turn.started",
  "engine.notice",
  "engine.warning",
  "engine.stderr",
  "context.compactionDecision",
  "memory.proposal",
  "resume.updated",
  "resume.invalid",
  "prompt_suggestions.updated",
]);

class RuntimeEventBus {
  constructor(mainWindowProvider, options = {}) {
    this._mainWindowProvider = mainWindowProvider;
    this._persistEvents = typeof options.persistEvents === "function" ? options.persistEvents : null;
    this._sessionSeq = new Map();
    this._batchSeq = new Map();
    this._pending = new Map();
    this._scheduled = false;
    this._flushTimer = null;
    this._recent = new Map();
    this._terminalTurns = new Set();
    // Passive observers (e.g. the mobile bridge projecting turn output to a
    // paired phone). Called on every committed batch; never affect renderer
    // delivery and are fully isolated — an observer throwing can't disrupt a turn.
    this._observers = new Set();
  }

  /** Register a passive (sessionId, events) observer. Returns an unsubscribe fn. */
  addObserver(fn) {
    if (typeof fn !== "function") return () => {};
    this._observers.add(fn);
    return () => this._observers.delete(fn);
  }

  _notifyObservers(sessionId, events) {
    if (!this._observers.size) return;
    for (const fn of this._observers) {
      try { fn(sessionId, events); } catch (err) {
        console.warn("[runtime-event-bus] observer failed:", err?.message || err);
      }
    }
  }

  emit(sessionId, eventLike) {
    return this.emitBatch(sessionId, [eventLike]);
  }

  emitBatch(sessionId, eventLikes) {
    const sid = String(sessionId || "");
    if (!sid || !Array.isArray(eventLikes) || eventLikes.length === 0) return [];
    const events = eventLikes
      .map((eventLike) => this._normalize(sid, eventLike))
      .filter(Boolean);
    if (!events.length) return [];
    const existing = this._pending.get(sid) || [];
    existing.push(...events);
    this._pending.set(sid, existing);
    this._remember(sid, events);
    this._persist(sid, events);
    this._notifyObservers(sid, events);
    this._scheduleFlush(events);
    return events;
  }

  snapshot(sessionId) {
    const sid = String(sessionId || "");
    return {
      sessionId: sid,
      seq: this._sessionSeq.get(sid) || 0,
      batchSeq: this._batchSeq.get(sid) || 0,
      recent: this._recent.get(sid) || [],
    };
  }

  _normalize(sessionId, eventLike) {
    const turnKey = eventLike?.turnId ? `${sessionId}:${eventLike.turnId}` : "";
    if (turnKey && this._terminalTurns.has(turnKey) && !POST_TERMINAL_ALLOWED.has(eventLike.type)) {
      return null;
    }
    const nextSeq = (this._sessionSeq.get(sessionId) || 0) + 1;
    this._sessionSeq.set(sessionId, nextSeq);
    const event = createRuntimeEvent({
      ...eventLike,
      sessionId,
      seq: nextSeq,
    });
    if (isTerminalEvent(event)) this._terminalTurns.add(`${sessionId}:${event.turnId}`);
    return event;
  }

  _remember(sessionId, events) {
    const next = [...(this._recent.get(sessionId) || []), ...events].slice(-200);
    this._recent.set(sessionId, next);
  }

  _persist(sessionId, events) {
    if (!this._persistEvents || !events?.length) return;
    try {
      this._persistEvents(sessionId, events);
    } catch (err) {
      console.warn("[runtime-event-bus] persist failed:", err?.message || err);
    }
  }

  _scheduleFlush(events = []) {
    const deltaOnly = events.length > 0 && events.every((event) => event.type === "assistant.delta");
    if (deltaOnly && !this._scheduled && !this._flushTimer) {
      this._flushTimer = setTimeout(() => {
        this._flushTimer = null;
        this.flush();
      }, 50);
      return;
    }
    if (this._flushTimer) {
      clearTimeout(this._flushTimer);
      this._flushTimer = null;
    }
    if (this._scheduled) return;
    this._scheduled = true;
    queueMicrotask(() => this.flush());
  }

  flush() {
    this._scheduled = false;
    if (this._flushTimer) {
      clearTimeout(this._flushTimer);
      this._flushTimer = null;
    }
    const win = this._mainWindowProvider?.();
    if (!win || win.isDestroyed?.()) {
      this._pending.clear();
      return;
    }
    for (const [sessionId, events] of this._pending.entries()) {
      if (!events.length) continue;
      const batchSeq = (this._batchSeq.get(sessionId) || 0) + 1;
      this._batchSeq.set(sessionId, batchSeq);
      win.webContents.send("assistant:runtime-events", {
        sessionId,
        batchSeq,
        events,
      });
    }
    this._pending.clear();
  }
}

module.exports = { RuntimeEventBus };
