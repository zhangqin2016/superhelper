// The phone's connection to its desktop — a state machine, no framework.
//
//   idle ─pair()/directConnect()─▶ pairing ─▶ waiting (for the desktop's approval)
//                                              │ relay accepts
//   resume() (saved pairing) ─────────────────▶ connecting ─▶ online
//   online ─drop─▶ reconnecting ─▶ online        (backoff; token renewed)
//   any ─ revoked (4001) / pairing dead ─▶ ended (pairing forgotten, rescan)
//
// The pairing is remembered, so a refresh — or iOS evicting a background tab —
// reconnects instead of asking for a new scan. What is kept is the grant-scoped
// relay token only: it can do nothing but relay for this one pairing.

import { CLOSE } from "./protocol.mjs";

export const GRANT_STORAGE_KEY = "lily_m_grant";
const TOKEN_REFRESH_AFTER_MS = 6 * 60 * 60 * 1000;
const APPROVAL_WAIT_ATTEMPTS = 45; // ~90 s at 2 s: time to walk to the desktop and tap 批准
const MAX_BACKOFF_MS = 15_000;
// Phases from which a new pairing may start.
const CAN_START = new Set(["idle", "error", "ended"]);

export const MESSAGES = Object.freeze({
  pairing: "正在配对…",
  waiting: "已发出配对请求，请在电脑上点「批准」",
  connecting: "正在连接电脑…",
  reconnecting: "连接已断开，正在重新连接…",
  revoked: "这台手机已在电脑上被解除配对。需要继续控制的话，请在电脑上重新生成二维码扫码。",
  lapsed: "配对已失效（在电脑上被解除，或超过两天没有使用）。请在电脑上重新生成二维码扫码。",
  approvalTimeout: "电脑上一直没有批准。请确认电脑上的 Lily 打开着，然后重新扫码。",
  codeExpired: "配对码已过期或已被使用，请在电脑上重新生成后再扫一次",
  directLocked: "尝试次数过多，请在电脑上重新生成直控码后再试",
  directInvalid: "授权码或密码错误",
  invalidCode: "配对码无效，请扫码或粘贴电脑显示的配对码",
});

/** `${api}#${token}` (paste form) or a bare token (then the API is this page's origin). */
export function parsePairingCode(raw, pageOrigin) {
  const text = String(raw || "").trim();
  const hashAt = text.lastIndexOf("#");
  if (hashAt > 0) return { url: text.slice(0, hashAt).replace(/\/+$/, ""), token: text.slice(hashAt + 1) };
  return { url: pageOrigin, token: text };
}

/** A scanned QR opens `${api}/m/pair#u=<api>&t=<token>`; null when the hash is not one. */
export function parseScanHash(hash, pageOrigin) {
  const frag = String(hash || "").replace(/^#/, "");
  if (!frag || !/(^|&)t=/.test(frag)) return null;
  const params = new URLSearchParams(frag);
  const token = params.get("t");
  if (!token) return null;
  return { url: (params.get("u") || pageOrigin).replace(/\/+$/, ""), token };
}

export function createRelayClient({
  deviceId,
  pageOrigin,
  storage = globalThis.localStorage,
  fetchImpl = (...args) => globalThis.fetch(...args),
  WebSocketImpl = globalThis.WebSocket,
  setTimeoutImpl = (fn, ms) => setTimeout(fn, ms),
  clearTimeoutImpl = (t) => clearTimeout(t),
  now = () => Date.now(),
  onFrame = () => {},
  onStatus = () => {},
}) {
  let grant = null; // { url, grantId, mobileToken, savedAt }
  let ws = null;
  let timer = null;
  let attempts = 0;
  let everOnline = false;
  let phase = "idle";

  function setPhase(next, message = MESSAGES[next] || "") {
    phase = next;
    onStatus({ phase, message });
  }

  function save() {
    try { storage?.setItem(GRANT_STORAGE_KEY, JSON.stringify(grant)); } catch { /* private mode */ }
  }

  function forget() {
    try { storage?.removeItem(GRANT_STORAGE_KEY); } catch { /* private mode */ }
  }

  async function post(url, path, body) {
    try {
      const res = await fetchImpl(`${url}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const json = await res.json().catch(() => ({}));
      return { ok: res.ok && json?.ok !== false, status: res.status, json };
    } catch {
      return { ok: false, status: 0, json: {} };
    }
  }

  function end(message) {
    forget();
    grant = null;
    clearTimeoutImpl(timer);
    timer = null;
    const socket = ws;
    ws = null;
    try { socket?.close(); } catch { /* noop */ }
    setPhase("ended", message);
  }

  /** Renew the relay token; tells a lapsed/revoked pairing apart from a network blip. */
  async function renew() {
    if (!grant) return "missing";
    const r = await post(grant.url, "/api/mobile/grant/refresh", { deviceId, grantId: grant.grantId, token: grant.mobileToken });
    if (r.ok && r.json?.mobileToken) {
      grant = { ...grant, mobileToken: r.json.mobileToken, savedAt: now() };
      save();
      return "ok";
    }
    return r.status === 401 || r.status === 403 || r.status === 409 ? "dead" : "unknown";
  }

  function connect() {
    if (!grant) return;
    clearTimeoutImpl(timer);
    timer = null;
    const { url, grantId, mobileToken } = grant;
    const socket = new WebSocketImpl(`${url.replace(/^http/, "ws")}/api/mobile/relay?role=mobile&grantId=${encodeURIComponent(grantId)}&deviceId=${encodeURIComponent(deviceId)}&token=${encodeURIComponent(mobileToken)}`);
    ws = socket;
    socket.onopen = () => {
      if (ws !== socket) return;
      attempts = 0;
      everOnline = true;
      save();
      setPhase("online", "");
      if (now() - Number(grant?.savedAt || 0) > TOKEN_REFRESH_AFTER_MS) void renew();
    };
    socket.onmessage = (event) => {
      if (ws !== socket) return;
      let frame = null;
      try { frame = JSON.parse(event.data); } catch { return; }
      if (frame && typeof frame.type === "string") onFrame(frame);
    };
    socket.onerror = () => { try { socket.close(); } catch { /* noop */ } };
    socket.onclose = async (event) => {
      if (ws !== socket) return;
      ws = null;
      if (!grant) return;
      if (event?.code === CLOSE.GRANT_ENDED) return end(MESSAGES.revoked);
      attempts += 1;
      if (!everOnline) {
        // Not approved yet — the relay refuses until the desktop taps 批准.
        if (attempts >= APPROVAL_WAIT_ATTEMPTS) return end(MESSAGES.approvalTimeout);
        timer = setTimeoutImpl(connect, 2000);
        return;
      }
      // A refused upgrade carries no reason: after a few, ask whether the pairing lives.
      if (attempts === 3 && (await renew()) === "dead") return end(MESSAGES.lapsed);
      setPhase("reconnecting");
      timer = setTimeoutImpl(connect, Math.min(MAX_BACKOFF_MS, 1000 * 2 ** Math.min(attempts - 1, 4)));
    };
  }

  // `active`: the pairing is already live (saved, or a direct code), so a
  // refused connect means "reconnect", not "still awaiting approval".
  function begin(next, nextPhase, { active }) {
    grant = { ...next, savedAt: Number.isFinite(next.savedAt) ? next.savedAt : now() };
    attempts = 0;
    everOnline = active;
    save();
    setPhase(nextPhase);
    connect();
  }

  return {
    phase: () => phase,
    grant: () => grant,

    /** Pick up the pairing saved by an earlier visit. */
    resume() {
      let saved = null;
      try { saved = JSON.parse(storage?.getItem(GRANT_STORAGE_KEY) || "null"); } catch { saved = null; }
      if (!saved?.url || !saved?.grantId || !saved?.mobileToken) return false;
      begin(saved, "connecting", { active: true });
      return true;
    },

    /** Consume a scanned / pasted one-time code; the desktop then approves. */
    async pair(rawCode) {
      if (!CAN_START.has(phase)) return false; // a one-time code is never consumed twice
      const { url, token } = parsePairingCode(rawCode, pageOrigin);
      if (!url || !token) { setPhase("error", MESSAGES.invalidCode); return false; }
      setPhase("pairing");
      const r = await post(url, "/api/mobile/pairing/consume", { deviceId, token });
      if (!r.ok || !r.json?.grantId || !r.json?.mobileToken) {
        const code = r.json?.code || r.status;
        setPhase("error", code === "PAIRING_CHALLENGE_INVALID_OR_EXPIRED" ? MESSAGES.codeExpired : `配对失败：${code}`);
        return false;
      }
      begin({ url, grantId: r.json.grantId, mobileToken: r.json.mobileToken }, "waiting", { active: false });
      return true;
    },

    /** Code + password (TeamViewer-style): active at once, no approval. */
    async directConnect(code, password) {
      if (!CAN_START.has(phase)) return false; // a one-time code is never consumed twice
      const url = pageOrigin;
      setPhase("pairing");
      const r = await post(url, "/api/mobile/direct/consume", { deviceId, code: String(code || "").trim(), password: String(password || "").trim() });
      if (!r.ok || !r.json?.grantId || !r.json?.mobileToken) {
        const c = r.json?.code || r.status;
        setPhase("error", c === "DIRECT_CODE_LOCKED" ? MESSAGES.directLocked : c === "DIRECT_CODE_INVALID" ? MESSAGES.directInvalid : `连接失败：${c}`);
        return false;
      }
      begin({ url, grantId: r.json.grantId, mobileToken: r.json.mobileToken }, "connecting", { active: true });
      return true;
    },

    /** Send a frame to the desktop. False when not connected. */
    send(frame) {
      const socket = ws;
      if (!socket || socket.readyState !== (WebSocketImpl.OPEN ?? 1)) return false;
      try { socket.send(JSON.stringify(frame)); return true; } catch { return false; }
    },

    /** The page became visible again: skip the backoff. */
    reconnectNow() {
      if (grant && !ws && phase === "reconnecting") connect();
    },

    /** POST with this pairing's token (speech-to-text token, etc.). */
    async authorizedPost(path, body = {}) {
      if (!grant) return { ok: false, status: 0, json: {} };
      return post(grant.url, path, { deviceId, grantId: grant.grantId, token: grant.mobileToken, ...body });
    },

    stop() {
      clearTimeoutImpl(timer);
      timer = null;
      const socket = ws;
      ws = null;
      try { socket?.close(); } catch { /* noop */ }
    },
  };
}
