"use strict";

/**
 * The desktop's ONE connection to the relay (control protocol 2).
 *
 * Transport only: connect with a fresh account token, keep the connection up,
 * turn relay frames into typed events, and send phone frames inside
 * `relay.frame` envelopes. It knows nothing about sessions or pairings beyond
 * the event shapes — the directory and controllers own meaning.
 *
 * Why one connection: a socket per phone meant a second phone could displace
 * the first, a direct-code phone never got one, and a restarted desktop had
 * none until something re-created them. With one channel the relay binds every
 * pairing of this device to it and pushes pairing changes down it; `hello`
 * on every (re)connect carries the full state, so a reconnect IS the
 * reconciliation.
 */

const { CLOSE, CONTROL, envelope, parseFrame } = require("./protocol");

const MAX_BACKOFF_MS = 30_000;

/**
 * @param {object} opts
 * @param {() => string} opts.getUrl        ws(s)://…/api/mobile/relay
 * @param {() => Promise<string>} opts.getToken  fresh account access token ("" = signed out)
 * @param {() => string} opts.getDeviceId
 * @param {(event: object) => void} opts.onEvent
 *   { type: "status", status } | { type: "hello", grants, pending }
 *   | { type: "pending", grant } | { type: "active", grant }
 *   | { type: "ended", grantId, reason } | { type: "presence", grantId, mobilesOnline }
 *   | { type: "phone-frame", grantId, frame }
 */
function createControlChannel({
  getUrl,
  getToken,
  getDeviceId,
  onEvent,
  WebSocketCtor = globalThis.WebSocket,
  baseDelayMs = 2000,
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
  log = { info() {}, warn() {} },
}) {
  let ws = null;
  let running = false;
  let timer = null;
  let failures = 0;
  let status = "idle"; // idle | connecting | online | offline | signed-out

  function emit(event) {
    try { onEvent(event); } catch (err) { log.warn("mobile control event handler failed: %s", err?.message || err); }
  }

  function setStatus(next) {
    if (status === next) return;
    status = next;
    emit({ type: "status", status });
  }

  function schedule(reason) {
    if (!running || timer) return;
    failures += 1;
    const delay = Math.min(MAX_BACKOFF_MS, baseDelayMs * 2 ** Math.min(failures - 1, 4));
    if (reason) log.warn("mobile control channel: %s; retry in %dms", reason, delay);
    timer = setTimeoutImpl(() => { timer = null; void connect(); }, delay);
    timer?.unref?.();
  }

  function dispatch(frame) {
    switch (frame.type) {
      case CONTROL.HELLO:
        return emit({ type: "hello", grants: frame.grants || [], pending: frame.pending || [] });
      case CONTROL.PAIRING_PENDING:
        return frame.grant ? emit({ type: "pending", grant: frame.grant }) : undefined;
      case CONTROL.GRANT_ACTIVE:
        return frame.grant ? emit({ type: "active", grant: frame.grant }) : undefined;
      case CONTROL.GRANT_ENDED:
        return emit({ type: "ended", grantId: String(frame.grantId || ""), reason: String(frame.reason || "") });
      case CONTROL.PRESENCE:
        return emit({ type: "presence", grantId: String(frame.grantId || ""), mobilesOnline: Number(frame.mobilesOnline || 0) });
      case CONTROL.FRAME: {
        const inner = parseFrame(frame.frame);
        if (frame.grantId && inner) emit({ type: "phone-frame", grantId: String(frame.grantId), frame: inner });
        return undefined;
      }
      case CONTROL.ERROR:
        return log.warn("mobile relay refused a frame: %s", frame.code || "");
      default:
        return undefined;
    }
  }

  async function connect() {
    if (!running) return;
    let token = "";
    try { token = String((await getToken()) || ""); } catch { token = ""; }
    if (!running) return;
    if (!token) {
      // Signed out: nothing to connect as. Try again later (sign-in is a user action).
      setStatus("signed-out");
      schedule("");
      return;
    }
    const url = String(getUrl() || "");
    if (!url) { setStatus("offline"); schedule("no relay url"); return; }
    setStatus("connecting");
    const q = new URLSearchParams({ role: "desktop", deviceId: String(getDeviceId() || ""), token });
    let socket;
    try {
      socket = new WebSocketCtor(`${url.replace(/\/+$/, "")}?${q.toString()}`);
    } catch (err) {
      setStatus("offline");
      schedule(err?.message || "connect failed");
      return;
    }
    ws = socket;
    socket.onopen = () => {
      if (ws !== socket) return;
      failures = 0;
      setStatus("online");
      log.info("mobile control channel online");
    };
    socket.onmessage = (event) => {
      if (ws !== socket) return;
      const frame = parseFrame(event?.data);
      if (frame) dispatch(frame);
    };
    socket.onerror = () => { /* onclose drives recovery */ };
    socket.onclose = (event) => {
      if (ws !== socket) return;
      ws = null;
      if (!running) return;
      setStatus("offline");
      // Replaced by a newer connection of this same device (e.g. a second
      // Lily instance): it owns the channel now; retry slowly, not in a fight.
      if (Number(event?.code) === CLOSE.REPLACED) failures = Math.max(failures, 4);
      schedule(`closed ${event?.code || ""}`.trim());
    };
  }

  return {
    start() {
      if (running) return;
      running = true;
      failures = 0;
      void connect();
    },
    stop() {
      running = false;
      if (timer) { clearTimeoutImpl(timer); timer = null; }
      const socket = ws;
      ws = null;
      try { socket?.close?.(); } catch { /* noop */ }
      setStatus("idle");
    },
    /** Reconnect now (e.g. the user just signed in). */
    kick() {
      if (!running || ws) return;
      if (timer) { clearTimeoutImpl(timer); timer = null; }
      failures = 0;
      void connect();
    },
    /** Send a phone frame to a pairing. False when the channel is down. */
    send(grantId, frame) {
      const socket = ws;
      if (!socket || socket.readyState !== (WebSocketCtor.OPEN ?? 1)) return false;
      try {
        socket.send(JSON.stringify(envelope(grantId, frame)));
        return true;
      } catch {
        return false;
      }
    },
    status() {
      return status;
    },
  };
}

module.exports = { createControlChannel };
