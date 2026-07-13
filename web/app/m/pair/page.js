"use client";

// Mobile Command — phone pairing + command page (desktop-vouched model).
//
// A phone scans the QR the desktop shows and can immediately send tasks into the
// desktop's active Lily session — NO login. The phone presents only a browser
// device id; it consumes the one-time QR token and receives a grant-scoped token
// whose only power is to relay for that one grant. Security is the QR possession
// (proximity) + the desktop user's explicit approval. This is what lets it work
// abroad, where the phone can't receive an SMS code.
//
// LIVE-VALIDATION PENDING: the on-device round-trip (scan → desktop approve →
// send) is exercised server-side by server/scripts/mobile-command-e2e.mjs; the
// page structure is guarded by scripts/test-mobile-pair-web.mjs.

import { useCallback, useEffect, useRef, useState } from "react";

function ensureDeviceId() {
  try {
    let id = localStorage.getItem("lily_m_device_id");
    if (!id) {
      id = `mweb_${(crypto.randomUUID?.() || String(Math.random()).slice(2)).replace(/-/g, "")}`;
      localStorage.setItem("lily_m_device_id", id);
    }
    return id;
  } catch {
    return `mweb_${Date.now()}`;
  }
}

function pageOrigin() {
  try { return typeof window !== "undefined" ? window.location.origin : ""; } catch { return ""; }
}

function parsePairingCode(raw) {
  // Desktop shows `${serverUrl}#${token}` for manual paste. Accept that, or a
  // bare token — in which case the API base is this page's own origin (the scan
  // deep link lands here, served from the API server).
  const text = String(raw || "").trim();
  const hashAt = text.lastIndexOf("#");
  if (hashAt > 0) return { url: text.slice(0, hashAt).replace(/\/+$/, ""), token: text.slice(hashAt + 1) };
  return { url: pageOrigin(), token: text };
}

// A scanned QR opens `${api}/m/pair#u=<api>&t=<token>`. Pull the API base (u)
// and one-time token (t) out of the URL fragment; fall back to this page's
// origin when u is absent. Returns null when the fragment isn't a scan link.
function parseScanHash(hash) {
  const frag = String(hash || "").replace(/^#/, "");
  if (!frag || !/(^|&)t=/.test(frag)) return null;
  const params = new URLSearchParams(frag);
  const token = params.get("t");
  if (!token) return null;
  const url = (params.get("u") || pageOrigin()).replace(/\/+$/, "");
  return { url, token };
}

function wsOrigin(httpUrl) {
  return String(httpUrl || "").replace(/^http/, "ws");
}

export default function MobilePairPage() {
  const [deviceId, setDeviceId] = useState("");
  const [codeInput, setCodeInput] = useState("");
  const [status, setStatus] = useState("idle"); // idle|consuming|waiting|connected|error
  const [message, setMessage] = useState("");
  const [task, setTask] = useState("");
  const [log, setLog] = useState([]);
  const wsRef = useRef(null);
  const grantRef = useRef({ url: "", grantId: "" });
  const autoPairedRef = useRef(false);

  const post = useCallback(async (base, path, body) => {
    const res = await fetch(`${base}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = await res.json().catch(() => ({}));
    return { ok: res.ok && json?.ok !== false, json, status: res.status };
  }, []);

  const connectRelay = useCallback((base, grantId, mobileToken) => {
    const url = `${wsOrigin(base)}/api/mobile/relay?role=mobile&grantId=${encodeURIComponent(grantId)}&deviceId=${encodeURIComponent(deviceId)}&token=${encodeURIComponent(mobileToken)}`;
    let attempts = 0;
    const tryOnce = () => {
      const ws = new WebSocket(url);
      wsRef.current = ws;
      ws.onopen = () => { setStatus("connected"); setMessage("已连接，手机现在可以发送任务"); };
      ws.onmessage = (e) => {
        try {
          const frame = JSON.parse(e.data);
          if (frame.type === "command.admitted") setLog((l) => [`✓ 已送达桌面（${frame.effectiveMode}）`, ...l].slice(0, 20));
          else if (frame.type === "command.rejected") setLog((l) => [`✗ 被拒绝：${frame.code}`, ...l].slice(0, 20));
        } catch { /* ignore */ }
      };
      ws.onclose = () => {
        // Before approval the relay refuses (grant not active): retry a few times.
        if (wsRef.current === ws && attempts < 30 && grantRef.current.grantId === grantId) {
          attempts += 1;
          setStatus("waiting");
          setTimeout(tryOnce, 2000);
        }
      };
      ws.onerror = () => { try { ws.close(); } catch { /* noop */ } };
    };
    tryOnce();
  }, [deviceId]);

  const pair = useCallback(async (rawCode) => {
    const { url, token } = parsePairingCode(rawCode ?? codeInput);
    if (!url || !token) { setMessage("配对码无效，请扫码或粘贴桌面显示的配对码"); return; }
    setStatus("consuming");
    setMessage("正在配对…");
    // No login: consume with just this browser's device id + the one-time token.
    const r = await post(url, "/api/mobile/pairing/consume", { deviceId, token });
    if (!r.ok || !r.json?.grantId || !r.json?.mobileToken) {
      setStatus("error");
      setMessage(`配对失败：${r.json?.code || r.status}`);
      return;
    }
    grantRef.current = { url, grantId: r.json.grantId };
    setStatus("waiting");
    setMessage("已提交配对请求，请在桌面上点击“批准”…");
    connectRelay(url, r.json.grantId, r.json.mobileToken);
  }, [codeInput, deviceId, post, connectRelay]);

  useEffect(() => {
    const id = ensureDeviceId();
    setDeviceId(id);
    // A scanned QR lands here with the API base + token in the fragment.
    if (typeof window !== "undefined" && window.location.hash.length > 1) {
      const scanned = parseScanHash(window.location.hash);
      if (scanned) setCodeInput(`${scanned.url}#${scanned.token}`);
      else setCodeInput(decodeURIComponent(window.location.hash.slice(1)));
    }
    return () => { try { wsRef.current?.close(); } catch { /* noop */ } };
  }, []);

  // Auto-pair once when opened via a scanned deep link — scanning is the whole
  // interaction; the only remaining step is the desktop tapping “批准”.
  useEffect(() => {
    if (autoPairedRef.current || !deviceId || status !== "idle") return;
    if (typeof window === "undefined") return;
    const scanned = parseScanHash(window.location.hash);
    if (scanned) {
      autoPairedRef.current = true;
      pair(`${scanned.url}#${scanned.token}`);
    }
  }, [deviceId, status, pair]);

  const sendTask = useCallback(() => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN || !task.trim()) return;
    const commandId = `cmd_${(crypto.randomUUID?.() || Date.now()).toString().replace(/-/g, "")}`;
    ws.send(JSON.stringify({
      type: "command",
      commandId,
      idempotencyKey: commandId,
      text: task.trim(),
      mobileDeviceId: deviceId,
      lilySessionId: "",
      mode: "queue",
    }));
    setLog((l) => [`→ ${task.trim()}`, ...l].slice(0, 20));
    setTask("");
  }, [task, deviceId]);

  return (
    <section className="mx-auto max-w-md p-4">
      <h1 className="text-xl font-semibold">手机控制桌面</h1>
      <p className="mt-1 text-sm text-slate-500">用手机相机扫描桌面「设置 → 手机控制」里的二维码；扫码后在桌面点“批准”即可，无需登录。</p>
      {message ? <p className="mt-3 rounded bg-slate-100 px-3 py-2 text-sm text-slate-700">{message}</p> : null}

      {status === "connected" ? null : (
        <>
          <label className="mt-4 block text-sm font-medium">配对码（扫不了码时手动粘贴）</label>
          <input className="mt-1 w-full rounded border border-slate-300 px-3 py-2 text-sm" value={codeInput} onChange={(e) => setCodeInput(e.target.value)} placeholder="粘贴桌面显示的配对码" />
          <button type="button" className="mt-4 w-full rounded bg-indigo-600 px-3 py-2 text-sm font-medium text-white" onClick={() => pair()} disabled={status === "consuming"}>配对并连接</button>
        </>
      )}

      {status === "connected" ? (
        <div className="mt-6">
          <label className="block text-sm font-medium">发送任务到桌面</label>
          <div className="mt-1 flex gap-2">
            <input className="flex-1 rounded border border-slate-300 px-3 py-2 text-sm" value={task} onChange={(e) => setTask(e.target.value)} placeholder="例如：整理今天的会议纪要" onKeyDown={(e) => { if (e.key === "Enter") sendTask(); }} />
            <button type="button" className="rounded bg-indigo-600 px-4 py-2 text-sm font-medium text-white" onClick={sendTask}>发送</button>
          </div>
          <ul className="mt-3 space-y-1 text-sm text-slate-600">
            {log.map((line, i) => <li key={i}>{line}</li>)}
          </ul>
        </div>
      ) : null}
    </section>
  );
}
