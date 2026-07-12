"use client";

// Mobile Command — phone pairing + command page (Phase 1).
//
// A phone opens this page, logs in (SMS), pastes/opens the pairing code the
// desktop shows, and sends tasks into the desktop's active Lily session. Auth
// is the account device-flow (browser device id + bearer access token) — the
// consume + relay endpoints accept the account token (see accountGuard on the
// server); no native device signature is required.
//
// LIVE-VALIDATION PENDING: this flow (SMS login → consume → relay connect on
// approval → command send) must be validated against a running server + phone;
// the pieces are structurally guarded by scripts/test-mobile-pair-web.mjs but
// the on-device round-trip is not yet exercised.

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
  // bare token — in which case the API base is this page's own origin (the
  // scan deep link lands here, served from the API server).
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
  const [phone, setPhone] = useState("");
  const [smsCode, setSmsCode] = useState("");
  const [accessToken, setAccessToken] = useState("");
  const [codeInput, setCodeInput] = useState("");
  const [status, setStatus] = useState("idle"); // idle|logging|consuming|waiting|connected|error
  const [message, setMessage] = useState("");
  const [task, setTask] = useState("");
  const [log, setLog] = useState([]);
  const wsRef = useRef(null);
  const grantRef = useRef({ url: "", token: "", grantId: "" });

  useEffect(() => {
    setDeviceId(ensureDeviceId());
    // A scanned QR lands here with the API base + token in the fragment: prefill
    // the code so the only manual step left is the one-time same-account login.
    if (typeof window !== "undefined" && window.location.hash.length > 1) {
      const scanned = parseScanHash(window.location.hash);
      if (scanned) setCodeInput(`${scanned.url}#${scanned.token}`);
      else setCodeInput(decodeURIComponent(window.location.hash.slice(1)));
    }
    return () => { try { wsRef.current?.close(); } catch { /* noop */ } };
  }, []);

  const post = useCallback(async (base, path, body, token) => {
    const res = await fetch(`${base}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body),
    });
    const json = await res.json().catch(() => ({}));
    return { ok: res.ok && json?.ok !== false, json, status: res.status };
  }, []);

  const sendSms = useCallback(async () => {
    const { url } = parsePairingCode(codeInput);
    if (!url) { setMessage("请先粘贴桌面显示的配对码（包含服务器地址）"); return; }
    setStatus("logging");
    const r = await post(url, "/api/auth/sms/send", { phone: phone.trim(), purpose: "login", deviceId });
    setMessage(r.ok ? "验证码已发送" : `发送失败：${r.json?.code || r.status}`);
  }, [codeInput, phone, deviceId, post]);

  const login = useCallback(async () => {
    const { url } = parsePairingCode(codeInput);
    if (!url) { setMessage("请先粘贴配对码"); return; }
    setStatus("logging");
    await post(url, "/api/devices/register", { deviceId });
    const r = await post(url, "/api/auth/sms/login", { deviceId, phone: phone.trim(), code: smsCode.trim() });
    if (!r.ok || !r.json?.accessToken) { setStatus("error"); setMessage(`登录失败：${r.json?.code || r.status}`); return; }
    setAccessToken(r.json.accessToken);
    setStatus("idle");
    setMessage("登录成功，可以配对了");
  }, [codeInput, phone, smsCode, deviceId, post]);

  const connectRelay = useCallback((base, grantId, token) => {
    const url = `${wsOrigin(base)}/api/mobile/relay?role=mobile&grantId=${encodeURIComponent(grantId)}&deviceId=${encodeURIComponent(deviceId)}&token=${encodeURIComponent(token)}`;
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
        if (wsRef.current === ws && attempts < 20 && grantRef.current.grantId === grantId) {
          attempts += 1;
          setStatus("waiting");
          setTimeout(tryOnce, 2000);
        }
      };
      ws.onerror = () => { try { ws.close(); } catch { /* noop */ } };
    };
    tryOnce();
  }, [deviceId]);

  const pair = useCallback(async () => {
    if (!accessToken) { setMessage("请先登录"); return; }
    const { url, token } = parsePairingCode(codeInput);
    if (!url || !token) { setMessage("配对码无效"); return; }
    setStatus("consuming");
    const r = await post(url, "/api/mobile/pairing/consume", { deviceId, token }, accessToken);
    if (!r.ok || !r.json?.grantId) { setStatus("error"); setMessage(`配对失败：${r.json?.code || r.status}`); return; }
    grantRef.current = { url, token, grantId: r.json.grantId };
    setStatus("waiting");
    setMessage("已提交配对请求，请在桌面上点击“批准”…");
    connectRelay(url, r.json.grantId, accessToken);
  }, [accessToken, codeInput, deviceId, post, connectRelay]);

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
      <p className="mt-1 text-sm text-slate-500">在桌面「设置 → 手机控制」生成配对码，粘贴到下方完成配对。</p>
      {message ? <p className="mt-3 rounded bg-slate-100 px-3 py-2 text-sm text-slate-700">{message}</p> : null}

      <label className="mt-4 block text-sm font-medium">配对码</label>
      <input className="mt-1 w-full rounded border border-slate-300 px-3 py-2 text-sm" value={codeInput} onChange={(e) => setCodeInput(e.target.value)} placeholder="粘贴桌面显示的配对码" />

      {!accessToken ? (
        <div className="mt-4 space-y-2">
          <input className="w-full rounded border border-slate-300 px-3 py-2 text-sm" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="手机号" />
          <div className="flex gap-2">
            <input className="flex-1 rounded border border-slate-300 px-3 py-2 text-sm" value={smsCode} onChange={(e) => setSmsCode(e.target.value)} placeholder="验证码" />
            <button type="button" className="rounded bg-slate-200 px-3 py-2 text-sm" onClick={sendSms}>发送验证码</button>
          </div>
          <button type="button" className="w-full rounded bg-indigo-600 px-3 py-2 text-sm font-medium text-white" onClick={login}>登录</button>
        </div>
      ) : (
        <button type="button" className="mt-4 w-full rounded bg-indigo-600 px-3 py-2 text-sm font-medium text-white" onClick={pair} disabled={status === "consuming"}>配对并连接</button>
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
