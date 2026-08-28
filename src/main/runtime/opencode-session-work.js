"use strict";

const { getLogger } = require("../logger");
const log = getLogger("opencode-session-work");

// Engine identities survive view/profile replacement against the same database.
// Keep receipts for the app lifetime: evicting them would recount replayed parts.
const sessions = new Map();

function usageTotals(tokens = {}) {
  const positive = value => typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : 0;
  return {
    input_tokens: positive(tokens?.input),
    output_tokens: positive(tokens?.output) + positive(tokens?.reasoning),
    cache_read_input_tokens: positive(tokens?.cache?.read),
    cache_creation_input_tokens: positive(tokens?.cache?.write),
  };
}

function createOpencodeSessionWork(manager, ownerSessionId, isChatActive = () => false) {
  const leases = new Map();
  const requests = new Map();
  const messageSessions = new Map();
  let flushQueued = false;
  let ended = false;

  function session(sid) {
    if (ended || !sid || !manager.sessionID || !ownerSessionId) return null;
    if (sid !== manager.sessionID && !manager._childSessionIDs.has(sid)) return null;
    const key = JSON.stringify([manager.dataDir, sid]);
    let state = sessions.get(key);
    if (!state) {
      state = { ownerSessionId, messages: new Map() };
      sessions.set(key, state);
    }
    return state.ownerSessionId === ownerSessionId ? state : null;
  }

  function flush() {
    if (!ownerSessionId || flushQueued || isChatActive()) return;
    flushQueued = true;
    queueMicrotask(() => {
      flushQueued = false;
      if (isChatActive()) return;
      Promise.resolve().then(() => require("../usage-reporter").flush(ownerSessionId))
        .catch(error => log.warn("usage flush failed: %s", error?.message || error));
    });
  }

  function retain(key) {
    if (!ended && !leases.has(key) && manager._shared) leases.set(key, manager._shared.retainWork());
  }

  function release(key) {
    const done = leases.get(key);
    if (!done) return;
    leases.delete(key);
    if (manager._terminated && !leases.size) manager._finishTermination();
    done?.();
  }

  // Wrap the raw SDK request, underneath its timeout adapter. A timeout stops
  // waiting, not the engine's work; only real settlement releases this lease.
  async function request(operation) {
    if (ended) throw new Error("OPENCODE_ENGINE_ENDED");
    const key = Symbol("request");
    const stopped = new Promise((_, reject) => requests.set(key, reject));
    retain(key);
    try { return await Promise.race([operation(), stopped]); }
    finally {
      requests.delete(key);
      if (!ended) { manager._shared?._flushEvents(); flush(); }
      release(key);
    }
  }

  function rememberChild(sid) {
    if (!session(manager.sessionID)) return false;
    const known = manager._childSessionIDs.has(sid);
    manager._childSessionIDs.add(sid);
    if (!session(sid)) { manager._childSessionIDs.delete(sid); return false; }
    if (!known) retain(sid);
    return true;
  }

  function discover(directory, event) {
    if (directory && directory !== manager.cwd) return;
    const info = event?.properties?.info;
    if (event?.type === "session.created" && info?.id && info.parentID && session(info.parentID)) {
      rememberChild(info.id);
    }
  }

  function record(message) {
    if (!message.model || message.role !== "assistant") return;
    for (const part of message.parts.values()) {
      const totals = part.pending;
      if (!totals) continue;
      const delta = Object.fromEntries(Object.entries(totals).map(([key, value]) => [key, Math.max(0, value - (part.recorded[key] || 0))]));
      if (!Object.values(delta).some(Boolean)) { delete part.pending; continue; }
      try {
        require("../usage-reporter").recordModelUsage(ownerSessionId, delta, message.model);
        for (const [key, value] of Object.entries(totals)) part.recorded[key] = Math.max(value, part.recorded[key] || 0);
        delete part.pending;
        flush();
      } catch (error) { log.warn("usage record failed: %s", error?.message || error); }
    }
  }

  function observe(event, sid, mid) {
    const state = session(sid);
    if (!state) return;
    if (mid) messageSessions.set(mid, sid);
    const p = event.properties || {};
    const part = p.part || {};
    if (event.type === "message.part.updated" && part.type === "tool" && part.tool === "task") {
      const child = part.state?.metadata?.sessionID || part.state?.metadata?.sessionId;
      if (child) {
        rememberChild(child);
        if (["pending", "running"].includes(part.state?.status)) retain(child);
        if (["completed", "error"].includes(part.state?.status)) release(child);
      }
    }
    if (event.type === "session.status" && p.status?.type !== "idle") retain(sid);
    if (event.type === "session.idle" || event.type === "session.error" || event.type === "session.deleted"
      || (event.type === "session.status" && p.status?.type === "idle")) release(sid);

    // Account the v1 processor's canonical part, including compaction. Some
    // engines also publish experimental session.next mirrors with different IDs.
    if (!mid || (event.type !== "message.updated" && !(event.type === "message.part.updated" && part.type === "step-finish"))) return;
    if (event.type === "message.updated" && p.info?.role === "user") return;
    let message = state.messages.get(mid);
    if (!message) { message = { parts: new Map(), model: null, role: "" }; state.messages.set(mid, message); }
    if (event.type === "message.updated") {
      const info = p.info || {};
      if (info.role) message.role = info.role;
      if (info.providerID && info.modelID) message.model = { providerID: info.providerID, modelID: info.modelID };
    } else if (part.id) {
      const prior = message.parts.get(part.id);
      message.parts.set(part.id, { pending: usageTotals(part.tokens), recorded: prior?.recorded || {} });
    }
    record(message);
  }

  function cancelSession() {
    manager._shared?._flushEvents();
    for (const key of [...leases.keys()]) {
      if (typeof key === "symbol" || key === manager.sessionID) release(key);
    }
  }

  function engineEnded() {
    if (ended) return;
    ended = true;
    for (const reject of requests.values()) reject(new Error("OPENCODE_ENGINE_ENDED"));
    requests.clear();
    for (const key of [...leases.keys()]) release(key);
    messageSessions.clear();
    flush();
  }

  function diagnostics() {
    const states = [manager.sessionID, ...manager._childSessionIDs]
      .map(sid => sessions.get(JSON.stringify([manager.dataDir, sid])))
      .filter(state => state && state.ownerSessionId === ownerSessionId);
    const messages = states.flatMap(state => [...state.messages.values()]);
    const parts = messages.flatMap(message => [...message.parts.values()]);
    return { ended, leases: leases.size, requests: requests.size,
      usageMessages: messages.length, usageParts: parts.length, pendingTokenParts: parts.filter(part => part.pending).length };
  }

  return { discover, observe, rememberChild, request, flush, cancelSession, engineEnded, diagnostics,
    hasWork: () => leases.size > 0,
    bind: () => session(manager.sessionID),
    messageSession: mid => messageSessions.get(mid),
  };
}

module.exports = { createOpencodeSessionWork };
