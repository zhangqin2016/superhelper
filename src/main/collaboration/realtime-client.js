"use strict";

const HEARTBEAT_MS = 30_000;
const FOREGROUND_POLL_MS = 15_000;
const BACKGROUND_POLL_MS = 60_000;

/** Realtime is a hint channel only; every trigger invokes durable cursor sync. */
function createCollaborationRealtimeClient({ sync, onReconnect = () => {}, onEphemeral = () => {}, onConnectionState = () => {}, onForeground = () => {}, createSocket = null, setIntervalFn = setInterval, clearIntervalFn = clearInterval, setTimeoutFn = setTimeout, clearTimeoutFn = clearTimeout, random = Math.random, onWake = () => {}, onFocus = () => {} } = {}) {
  if (typeof sync !== "function") throw new TypeError("A durable sync function is required.");
  let socket = null;
  let pollTimer = null;
  let heartbeatTimer = null;
  let reconnectTimer = null;
  let reconnectAttempt = 0;
  let connectionTimer = null, connectEpoch = 0;
  let background = false;
  let stopped = true;
  const triggerSync = () => Promise.resolve(sync()).catch(() => undefined);
  const stopPoll = () => { if (pollTimer != null) clearIntervalFn(pollTimer); pollTimer = null; };
  const startPoll = () => {
    stopPoll();
    pollTimer = setIntervalFn(triggerSync, background ? BACKGROUND_POLL_MS : FOREGROUND_POLL_MS);
  };
  const stopReconnect = () => { if (reconnectTimer != null) clearTimeoutFn(reconnectTimer); reconnectTimer = null; };
  const scheduleReconnect = () => {
    if (stopped || reconnectTimer != null || typeof createSocket !== "function") return;
    const base = Math.min(1_000 * (2 ** Math.min(reconnectAttempt, 5)), 30_000);
    const delay = Math.min(30_000, Math.max(1, Math.floor(base * (0.5 + Math.max(0, Math.min(1, Number(random()) || 0))))));
    reconnectAttempt += 1;
    reconnectTimer = setTimeoutFn(() => { reconnectTimer = null; connect(); }, delay);
  };
  const attach = (target, event, handler) => {
    if (typeof target?.on === "function") target.on(event, handler);
    else if (typeof target?.addEventListener === "function") target.addEventListener(event, handler);
  };
  const messageData = (value) => value?.data ?? value;
  const connect = () => {
    if (stopped || typeof createSocket !== "function") return;
    const epoch = ++connectEpoch;
    const accept = (target) => {
      if (stopped || epoch !== connectEpoch) { attach(target,"error",()=>{}); try {target?.close?.();}catch{} return; }
      socket = target;
      const currentSocket = target;
      const current = () => !stopped && socket === currentSocket;
      const clearConnectionTimer = () => {if(connectionTimer != null)clearTimeoutFn(connectionTimer);connectionTimer=null;};
      attach(socket, "message", (raw) => {
        if (!current()) return;
        try {
          const frame = typeof messageData(raw) === "string" ? JSON.parse(messageData(raw)) : messageData(raw);
          if (Number(frame?.schemaVersion) !== 1) return;
          if (frame.type === "sync.available") { triggerSync(); return; }
          // Ephemeral hints (typing/presence) are relayed, never persisted. They
          // are handed up as-is; the consumer bounds and expires them.
          if (frame.type === "typing" || frame.type === "presence" || frame.type === "presence.changed") onEphemeral(frame);
        } catch { /* malformed ephemeral frame is ignored; polling is durable */ }
      });
      attach(socket, "open", () => { if (!current()) return; clearConnectionTimer();reconnectAttempt = 0; onConnectionState("connected"); Promise.resolve().then(onReconnect).catch(() => undefined); });
      const disconnected = () => { if (!current()) return; clearConnectionTimer();socket = null; onConnectionState("disconnected"); try { currentSocket?.close?.(); } catch {} scheduleReconnect(); };
      attach(socket, "close", disconnected);
      attach(socket, "error", disconnected);
      if(target?.readyState===0){connectionTimer=setTimeoutFn(disconnected,15000);connectionTimer?.unref?.();}
    };
    const failed = () => {if(!stopped && epoch===connectEpoch){onConnectionState("disconnected");scheduleReconnect();}};
    try { const target=createSocket(); if(target?.then)Promise.resolve(target).then(accept).catch(failed);else accept(target); } catch { failed(); }
  };
  return {
    start() {
      if (!stopped) return;
      stopped = false;
      connect();
      startPoll();
      if (typeof createSocket === "function") heartbeatTimer = setIntervalFn(() => { if(socket?.readyState!==1)return;try { socket.send(JSON.stringify({ type: "realtime.heartbeat", schemaVersion: 1 })); } catch { /* poll remains authoritative */ } }, HEARTBEAT_MS);
      const foreground = () => { if (stopped) return; triggerSync(); onForeground(); };
      onWake(foreground);
      onFocus(foreground);
    },
    /** Publish an ephemeral hint. Best effort by contract: a closed socket is
     *  not an error, because durable state never depends on these frames. */
    sendEphemeral(frame) {
      if (stopped || !frame || socket?.readyState !== 1 || typeof socket.send !== "function") return false;
      try { socket.send(JSON.stringify({ schemaVersion: 1, ...frame })); return true; }
      catch { return false; }
    },
    setBackground(next) { background = Boolean(next); if (!stopped) { startPoll(); if (!background) onForeground(); } },
    notifyAvailable() { return triggerSync(); },
    stop() {
      stopped = true;
      connectEpoch++;
      if(connectionTimer!=null)clearTimeoutFn(connectionTimer);connectionTimer=null;
      stopReconnect();
      stopPoll();
      if (heartbeatTimer != null) clearIntervalFn(heartbeatTimer);
      heartbeatTimer = null;
      try { socket?.close?.(); } catch { /* best effort */ }
      socket = null;
    },
  };
}

module.exports = { createCollaborationRealtimeClient, HEARTBEAT_MS, FOREGROUND_POLL_MS, BACKGROUND_POLL_MS };
