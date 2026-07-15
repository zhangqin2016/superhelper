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

// Downscale an image file to fit the relay frame (256KB). Draw to a canvas at a
// bounded size, then drop JPEG quality until the base64 is small enough. Returns
// { name, mimeType, dataBase64 } or null (non-image / failure → skip attachment).
async function fileToDownscaledAttachment(file, { maxDim = 1280, maxBytes = 170 * 1024 } = {}) {
  if (!file || !String(file.type || "").startsWith("image/")) return null;
  const dataUrl = await new Promise((resolve) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result || ""));
    fr.onerror = () => resolve("");
    fr.readAsDataURL(file);
  });
  if (!dataUrl) return null;
  const img = await new Promise((resolve) => {
    const im = new Image();
    im.onload = () => resolve(im);
    im.onerror = () => resolve(null);
    im.src = dataUrl;
  });
  if (!img) return null;
  const scale = Math.min(1, maxDim / Math.max(img.width || 1, img.height || 1));
  const w = Math.max(1, Math.round((img.width || 1) * scale));
  const h = Math.max(1, Math.round((img.height || 1) * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w; canvas.height = h;
  const cctx = canvas.getContext("2d");
  if (!cctx) return null;
  cctx.drawImage(img, 0, 0, w, h);
  let q = 0.72;
  let out = "";
  for (let i = 0; i < 5; i += 1) {
    out = canvas.toDataURL("image/jpeg", q);
    if (out.length * 0.75 <= maxBytes) break; // ~decoded size
    q -= 0.15;
    if (q < 0.3) break;
  }
  const b64 = out.replace(/^data:[^,]*,/, "");
  if (!b64) return null;
  return { name: (file.name || "photo").replace(/\.[^.]+$/, "") + ".jpg", mimeType: "image/jpeg", dataBase64: b64, preview: out };
}

export default function MobilePairPage() {
  const [deviceId, setDeviceId] = useState("");
  const [codeInput, setCodeInput] = useState("");
  const [pairMode, setPairMode] = useState("scan"); // scan | direct
  const [directCode, setDirectCode] = useState("");
  const [directPassword, setDirectPassword] = useState("");
  const [status, setStatus] = useState("idle"); // idle|consuming|waiting|connected|error
  const [message, setMessage] = useState("");
  const [task, setTask] = useState("");
  const [log, setLog] = useState([]);
  const [reply, setReply] = useState("");
  const [turnState, setTurnState] = useState("idle"); // idle|queued|running|completed|failed|interrupted|stalled
  const [sessionCtx, setSessionCtx] = useState(null); // { title, phase, recent: [{role,text}] }
  const [sessions, setSessions] = useState([]);
  const [selectedSessionId, setSelectedSessionId] = useState("");
  const [projects, setProjects] = useState([]);
  const [selectedProjectId, setSelectedProjectId] = useState("");
  const [pickerOpen, setPickerOpen] = useState(false); // workspace/session sheet
  const [attachment, setAttachment] = useState(null); // { name, mimeType, dataBase64, preview }
  const [capabilities, setCapabilities] = useState(null);
  const [listeningVoice, setListeningVoice] = useState(false);
  const [toast, setToast] = useState("");
  const recognitionRef = useRef(null);
  const toastTimerRef = useRef(null);
  const wsRef = useRef(null);
  const grantRef = useRef({ url: "", grantId: "" });
  const autoPairedRef = useRef(false);
  // The pairing token is ONE-TIME: consuming it twice makes the second call fail
  // with PAIRING_CHALLENGE_INVALID_OR_EXPIRED. This guards against a double
  // consume (dev StrictMode double-invoking the auto-pair effect, or a tap on
  // the button after a scan already paired). Reset on a failed attempt so a
  // fresh code can be retried.
  const consumingRef = useRef(false);

  const post = useCallback(async (base, path, body) => {
    const res = await fetch(`${base}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = await res.json().catch(() => ({}));
    return { ok: res.ok && json?.ok !== false, json, status: res.status };
  }, []);

  const loadCapabilities = useCallback(async (base) => {
    try {
      const res = await fetch(`${base || pageOrigin()}/api/mobile/capabilities`);
      const json = await res.json().catch(() => null);
      if (json?.ok) setCapabilities(json.capabilities || null);
    } catch {
      // Capability metadata is informational; pairing/command remains usable.
    }
  }, []);

  const connectRelay = useCallback((base, grantId, mobileToken) => {
    const url = `${wsOrigin(base)}/api/mobile/relay?role=mobile&grantId=${encodeURIComponent(grantId)}&deviceId=${encodeURIComponent(deviceId)}&token=${encodeURIComponent(mobileToken)}`;
    let attempts = 0;
    const tryOnce = () => {
      const ws = new WebSocket(url);
      wsRef.current = ws;
      ws.onopen = () => {
        setStatus("connected");
        setMessage("已连接，手机现在可以发送任务");
        try { ws.send(JSON.stringify({ type: "projects.request" })); } catch { /* noop */ }
        try { ws.send(JSON.stringify({ type: "sessions.request" })); } catch { /* noop */ }
        try { ws.send(JSON.stringify({ type: "session.request" })); } catch { /* noop */ }
      };
      ws.onmessage = (e) => {
        try {
          const frame = JSON.parse(e.data);
          switch (frame.type) {
            case "relay.peer_offline": setLog((l) => [`桌面暂时离线，任务未送达${frame.correlationId ? ` · ${frame.correlationId}` : ""}`, ...l].slice(0, 20)); break;
            case "command.admitted": setLog((l) => {
              const attachmentNote = frame.attachmentStatus === "dropped"
                ? " · 图片未送达"
                : frame.attachmentStatus === "partial"
                  ? " · 部分图片未送达"
                  : "";
              return [`✓ 已送达桌面（${frame.effectiveMode}）${attachmentNote}${frame.correlationId ? ` · ${frame.correlationId}` : ""}`, ...l].slice(0, 20);
            }); break;
            case "command.rejected": setLog((l) => [`✗ 被拒绝：${frame.code}${frame.correlationId ? ` · ${frame.correlationId}` : ""}`, ...l].slice(0, 20)); break;
            // Projected desktop turn output — the phone sees the reply it triggered.
            case "turn.started": setReply(""); setTurnState("running"); break;
            case "assistant.delta": setReply((r) => (r + String(frame.text || "")).slice(-8000)); break;
            case "assistant.final": if (frame.text) setReply(String(frame.text).slice(-8000)); break;
            case "tool.started": setLog((l) => [`🔧 正在使用 ${frame.tool}`, ...l].slice(0, 20)); break;
            case "turn.ended": setTurnState(frame.status || "completed"); break;
            case "interrupt.ack": setLog((l) => [frame.ok ? `⏹ 已请求停止${frame.correlationId ? ` · ${frame.correlationId}` : ""}` : `停止失败：${frame.code || ""}${frame.correlationId ? ` · ${frame.correlationId}` : ""}`, ...l].slice(0, 20)); break;
            case "projects.list":
              setProjects(Array.isArray(frame.projects) ? frame.projects : []);
              setSelectedProjectId(frame.selectedProjectId || frame.activeProjectId || "");
              break;
            case "project.select.ack": if (!frame.ok) setLog((l) => [`工作空间切换失败：${frame.code || ""}`, ...l].slice(0, 20)); break;
            case "sessions.list":
              setSessions(Array.isArray(frame.sessions) ? frame.sessions : []);
              setSelectedSessionId(frame.selectedSessionId || frame.activeSessionId || "");
              if (frame.projectId) setSelectedProjectId(frame.projectId);
              break;
            case "session.context":
              setSessionCtx({ title: frame.title || "", sessionId: frame.sessionId || "", phase: frame.phase || "", recent: Array.isArray(frame.recent) ? frame.recent : [] });
              if (frame.sessionId) setSelectedSessionId(frame.sessionId);
              break;
            case "session.select.ack": if (!frame.ok) setLog((l) => [`会话切换失败：${frame.code || ""}`, ...l].slice(0, 20)); break;
            default: break;
          }
        } catch { /* ignore */ }
      };
      ws.onclose = () => {
        // Before approval the relay refuses (grant not active): retry a few times.
        if (wsRef.current === ws && attempts < 30 && grantRef.current.grantId === grantId) {
          const firstRetry = attempts === 0;
          attempts += 1;
          setStatus("waiting");
          setMessage("连接已断开，正在重新连接桌面…");
          if (firstRetry) setLog((l) => ["连接已断开，正在重连…", ...l].slice(0, 20));
          setTimeout(tryOnce, 2000);
        } else if (wsRef.current === ws && grantRef.current.grantId === grantId) {
          setStatus("error");
          setMessage("无法连接桌面，请确认桌面端在线后重新扫码配对");
          setLog((l) => ["无法连接桌面，请重新配对", ...l].slice(0, 20));
        }
      };
      ws.onerror = () => { try { ws.close(); } catch { /* noop */ } };
    };
    tryOnce();
  }, [deviceId]);

  const pair = useCallback(async (rawCode) => {
    if (consumingRef.current) return; // one-time token: never consume twice
    const { url, token } = parsePairingCode(rawCode ?? codeInput);
    if (!url || !token) { setMessage("配对码无效，请扫码或粘贴桌面显示的配对码"); return; }
    consumingRef.current = true;
    setStatus("consuming");
    setMessage("正在配对…");
    loadCapabilities(url);
    // No login: consume with just this browser's device id + the one-time token.
    const r = await post(url, "/api/mobile/pairing/consume", { deviceId, token });
    if (!r.ok || !r.json?.grantId || !r.json?.mobileToken) {
      consumingRef.current = false; // allow a retry with a fresh code
      setStatus("error");
      const code = r.json?.code || r.status;
      setMessage(code === "PAIRING_CHALLENGE_INVALID_OR_EXPIRED"
        ? "配对码已过期或已被使用，请在桌面重新生成后再扫一次"
        : `配对失败：${code}`);
      return;
    }
    grantRef.current = { url, grantId: r.json.grantId };
    setStatus("waiting");
    setMessage("已提交配对请求，请在桌面上点击“批准”…");
    connectRelay(url, r.json.grantId, r.json.mobileToken);
  }, [codeInput, deviceId, post, connectRelay, loadCapabilities]);

  // Direct connect (TeamViewer/ToDesk-style): code + password → active grant, no
  // approval. The base is this page's own origin (the server it's served from).
  const directConnect = useCallback(async () => {
    if (consumingRef.current) return;
    const code = directCode.trim();
    const password = directPassword.trim();
    if (!code || !password) { setMessage("请输入授权码和密码"); return; }
    const url = pageOrigin();
    consumingRef.current = true;
    setStatus("consuming");
    setMessage("正在连接…");
    loadCapabilities(url);
    const r = await post(url, "/api/mobile/direct/consume", { deviceId, code, password });
    if (!r.ok || !r.json?.grantId || !r.json?.mobileToken) {
      consumingRef.current = false;
      setStatus("error");
      const c = r.json?.code || r.status;
      setMessage(
        c === "DIRECT_CODE_LOCKED" ? "尝试次数过多，请在桌面重新生成直控码后再试"
          : c === "DIRECT_CODE_INVALID" ? "授权码或密码错误"
            : `连接失败：${c}`,
      );
      return;
    }
    grantRef.current = { url, grantId: r.json.grantId };
    setStatus("waiting");
    setMessage("已连接授权，正在建立通道…");
    // Grant is already active (no approval) → the relay accepts immediately.
    connectRelay(url, r.json.grantId, r.json.mobileToken);
  }, [directCode, directPassword, deviceId, post, connectRelay, loadCapabilities]);

  useEffect(() => {
    const id = ensureDeviceId();
    setDeviceId(id);
    // A scanned QR lands here with the API base + token in the fragment.
    if (typeof window !== "undefined" && window.location.hash.length > 1) {
      const scanned = parseScanHash(window.location.hash);
      if (scanned) setCodeInput(`${scanned.url}#${scanned.token}`);
      else setCodeInput(decodeURIComponent(window.location.hash.slice(1)));
    }
    loadCapabilities(pageOrigin());
    return () => { try { wsRef.current?.close(); } catch { /* noop */ } };
  }, [loadCapabilities]);

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

  const pickImage = useCallback(async (e) => {
    const file = e?.target?.files?.[0];
    if (e?.target) e.target.value = ""; // allow re-picking the same file
    if (!file) return;
    const att = await fileToDownscaledAttachment(file);
    if (!att) { setLog((l) => ["图片无法处理(仅支持图片)", ...l].slice(0, 20)); return; }
    setAttachment(att);
  }, []);

  const selectSession = useCallback((sessionId) => {
    setSelectedSessionId(sessionId);
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      setLog((l) => ["手机尚未连接桌面，无法切换会话", ...l].slice(0, 20));
      return;
    }
    try {
      ws.send(JSON.stringify({ type: "session.select", sessionId }));
      setLog((l) => ["已请求切换手机目标会话", ...l].slice(0, 20));
    } catch {
      setLog((l) => ["会话切换发送失败", ...l].slice(0, 20));
    }
  }, []);

  const selectProject = useCallback((projectId) => {
    setSelectedProjectId(projectId);
    setSessions([]); setSelectedSessionId("");
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    try { ws.send(JSON.stringify({ type: "project.select", projectId })); } catch { /* noop */ }
  }, []);

  const flash = useCallback((msg) => {
    setToast(msg);
    setLog((l) => [msg, ...l].slice(0, 20));
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    toastTimerRef.current = setTimeout(() => setToast(""), 3500);
  }, []);

  // Voice: a clear tap-to-start / tap-to-stop toggle with visible feedback.
  // Browser SpeechRecognition is on-device + free but unsupported on some
  // mobile browsers (notably iOS Safari) — when missing, say so plainly instead
  // of failing silently.
  const toggleVoice = useCallback(() => {
    // Already listening → stop.
    if (recognitionRef.current) {
      try { recognitionRef.current.stop(); } catch { /* noop */ }
      recognitionRef.current = null;
      setListeningVoice(false);
      return;
    }
    const SpeechRecognition = typeof window !== "undefined"
      ? (window.SpeechRecognition || window.webkitSpeechRecognition)
      : null;
    if (!SpeechRecognition) {
      flash("此浏览器不支持语音输入，请用 Chrome 打开，或直接输入文字");
      return;
    }
    let recognition;
    try {
      recognition = new SpeechRecognition();
    } catch {
      flash("语音输入启动失败，请直接输入文字");
      return;
    }
    recognition.lang = "zh-CN";
    recognition.interimResults = true;
    recognition.continuous = true;
    recognition.onresult = (event) => {
      let text = "";
      for (let i = event.resultIndex || 0; i < event.results.length; i += 1) {
        if (event.results[i]?.isFinal) text += event.results[i]?.[0]?.transcript || "";
      }
      if (text.trim()) setTask((prev) => `${prev}${prev && !prev.endsWith(" ") ? " " : ""}${text.trim()}`);
    };
    recognition.onerror = (e) => {
      const code = e?.error || "";
      recognitionRef.current = null;
      setListeningVoice(false);
      if (code === "not-allowed" || code === "service-not-allowed") flash("麦克风被拒绝：请在浏览器里允许麦克风权限");
      else if (code === "no-speech") flash("没听到声音，请再试一次");
      else if (code === "aborted") { /* user stopped; no toast */ }
      else flash(`语音输入出错：${code || "未知"}`);
    };
    recognition.onend = () => { recognitionRef.current = null; setListeningVoice(false); };
    try {
      recognition.start();
      recognitionRef.current = recognition;
      setListeningVoice(true);
      flash("🎙 正在聆听，说完点一下麦克风停止");
    } catch {
      recognitionRef.current = null;
      setListeningVoice(false);
      flash("语音输入启动失败，请直接输入文字");
    }
  }, [flash]);

  const sendTask = useCallback(() => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      setLog((l) => ["手机尚未连接桌面，任务未发送", ...l].slice(0, 20));
      return;
    }
    if (!task.trim() && !attachment) return;
    const commandId = `cmd_${(crypto.randomUUID?.() || Date.now()).toString().replace(/-/g, "")}`;
    const correlationId = `corr_${commandId.slice(4, 14) || Date.now()}`;
    ws.send(JSON.stringify({
      type: "command",
      commandId,
      correlationId,
      idempotencyKey: commandId,
      text: task.trim(),
      attachments: attachment ? [{ name: attachment.name, mimeType: attachment.mimeType, dataBase64: attachment.dataBase64 }] : [],
      mobileDeviceId: deviceId,
      mode: "queue",
      lilySessionId: selectedSessionId,
    }));
    setReply("");
    setTurnState("queued");
    setLog((l) => [`→ ${attachment ? "🖼 " : ""}${task.trim() || "(图片)"} · ${correlationId}`, ...l].slice(0, 20));
    setTask("");
    setAttachment(null);
  }, [task, attachment, deviceId, selectedSessionId]);

  const sendInterrupt = useCallback(() => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      setLog((l) => ["手机尚未连接桌面，无法停止", ...l].slice(0, 20));
      return;
    }
    const stopCorrelationId = `corr_stop_${(crypto.randomUUID?.() || Date.now()).toString().replace(/-/g, "").slice(0, 10)}`;
    ws.send(JSON.stringify({ type: "interrupt", correlationId: stopCorrelationId }));
    setLog((l) => [`⏹ 发送停止… · ${stopCorrelationId}`, ...l].slice(0, 20));
  }, []);

  const connected = status === "connected";
  const busy = turnState === "running" || turnState === "queued";
  const dot = connected ? (busy ? "bg-amber-400" : "bg-emerald-400") : status === "error" ? "bg-rose-400" : "bg-slate-300";
  const statusText = connected ? (busy ? "运行中" : "在线") : status === "waiting" || status === "consuming" ? "连接中" : status === "error" ? "已断开" : "未连接";
  const workspaceName = projects.find((p) => p.id === selectedProjectId)?.name || "默认工作空间";
  const sessionName = sessions.find((s) => s.id === selectedSessionId)?.title || sessionCtx?.title || "当前会话";
  const history = Array.isArray(sessionCtx?.recent) ? sessionCtx.recent : [];

  return (
    <div className="mx-auto flex h-[100dvh] max-w-md flex-col bg-slate-50 text-slate-900">
      {/* Header */}
      <header className="flex-shrink-0 bg-gradient-to-br from-indigo-600 to-violet-600 px-4 pb-3 pt-[max(0.75rem,env(safe-area-inset-top))] text-white shadow-md">
        <div className="flex items-center gap-2">
          <h1 className="text-base font-semibold">手机控制桌面</h1>
          <span className="ml-auto inline-flex items-center gap-1.5 rounded-full bg-white/15 px-2.5 py-1 text-xs">
            <span className={`h-2 w-2 rounded-full ${dot} ${busy ? "animate-pulse" : ""}`} />
            {statusText}
          </span>
        </div>
        {connected ? (
          <button type="button" onClick={() => setPickerOpen(true)} className="mt-2 flex w-full items-center gap-2 rounded-xl bg-white/12 px-3 py-2 text-left text-sm backdrop-blur active:bg-white/20">
            <span className="truncate">
              <span className="opacity-70">🗂 {workspaceName}</span>
              <span className="mx-1 opacity-40">/</span>
              <span className="font-medium">{sessionName}</span>
            </span>
            <span className="ml-auto text-xs opacity-70">切换 ▾</span>
          </button>
        ) : null}
      </header>

      {message && !connected ? <p className="mx-4 mt-3 rounded-lg bg-white px-3 py-2 text-sm text-slate-600 shadow-sm">{message}</p> : null}

      {/* Pairing view */}
      {!connected ? (
        <main className="flex-1 overflow-y-auto px-4 py-4">
          <p className="text-sm text-slate-500">用相机扫描桌面「设置 → 手机控制」的二维码；或用授权码直连，无需登录。</p>
          {capabilities && !(capabilities.observeControl?.enabled || capabilities.voice?.enabled) ? (
            <p className="mt-2 text-xs text-slate-400">当前支持：任务、图片、回复、历史、工作空间/会话选择、浏览器听写。屏幕、语音、鼠标键盘控制等待桌面证据放行。</p>
          ) : null}
          <div className="mt-4 flex gap-1 rounded-xl bg-slate-200/70 p-1 text-sm">
            <button type="button" className={`flex-1 rounded-lg py-2 font-medium transition ${pairMode === "scan" ? "bg-white text-indigo-600 shadow-sm" : "text-slate-500"}`} onClick={() => setPairMode("scan")}>扫码 / 配对码</button>
            <button type="button" className={`flex-1 rounded-lg py-2 font-medium transition ${pairMode === "direct" ? "bg-white text-indigo-600 shadow-sm" : "text-slate-500"}`} onClick={() => setPairMode("direct")}>授权码直连</button>
          </div>
          <div className="mt-4 rounded-2xl bg-white p-4 shadow-sm">
            {pairMode === "scan" ? (
              <>
                <label className="block text-sm font-medium text-slate-700">配对码（扫不了码时手动粘贴）</label>
                <input className="mt-2 w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm focus:border-indigo-400 focus:outline-none" value={codeInput} onChange={(e) => setCodeInput(e.target.value)} placeholder="粘贴桌面显示的配对码" />
                <button type="button" className="mt-4 w-full rounded-xl bg-indigo-600 py-3 text-sm font-semibold text-white active:bg-indigo-700" onClick={() => pair()} disabled={status === "consuming"}>{status === "consuming" || status === "waiting" ? "连接中…" : "配对并连接"}</button>
              </>
            ) : (
              <>
                <label className="block text-sm font-medium text-slate-700">授权码 + 密码</label>
                <p className="mt-1 text-xs text-slate-400">桌面「手机控制 → 生成直控码」</p>
                <input className="mt-2 w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-center text-lg uppercase tracking-[0.3em] focus:border-indigo-400 focus:outline-none" value={directCode} onChange={(e) => setDirectCode(e.target.value)} placeholder="授权码" autoCapitalize="characters" />
                <input className="mt-2 w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-center text-lg uppercase tracking-[0.3em] focus:border-indigo-400 focus:outline-none" value={directPassword} onChange={(e) => setDirectPassword(e.target.value)} placeholder="密码" autoCapitalize="characters" />
                <button type="button" className="mt-4 w-full rounded-xl bg-indigo-600 py-3 text-sm font-semibold text-white active:bg-indigo-700" onClick={() => directConnect()} disabled={status === "consuming"}>{status === "consuming" || status === "waiting" ? "连接中…" : "直接连接"}</button>
                <p className="mt-2 text-xs text-slate-400">直连无需桌面批准，请只在你信任的网络输入。</p>
              </>
            )}
          </div>
        </main>
      ) : (
        <>
          {/* Chat */}
          <main className="flex-1 space-y-3 overflow-y-auto px-4 py-4">
            {history.length === 0 && !reply && turnState === "idle" ? (
              <p className="mt-10 text-center text-sm text-slate-400">发送第一个任务，或说句话试试 🎙</p>
            ) : null}
            {history.map((m, i) => (
              <div key={i} className={`flex ${m.role === "assistant" ? "justify-start" : "justify-end"}`}>
                <div className={`max-w-[82%] whitespace-pre-wrap rounded-2xl px-3.5 py-2 text-sm shadow-sm ${m.role === "assistant" ? "rounded-tl-sm bg-white text-slate-800" : "rounded-tr-sm bg-indigo-600 text-white"}`}>
                  {m.text.length > 1200 ? `${m.text.slice(0, 1200)}…` : m.text}
                </div>
              </div>
            ))}
            {reply || turnState !== "idle" ? (
              <div className="flex justify-start">
                <div className="max-w-[82%] rounded-2xl rounded-tl-sm bg-white px-3.5 py-2 text-sm text-slate-800 shadow-sm">
                  <div className="mb-1 flex items-center gap-2 text-xs">
                    {turnState === "queued" ? <span className="text-slate-400">排队中…</span> : null}
                    {turnState === "running" ? <span className="text-indigo-500">运行中</span> : null}
                    {turnState === "completed" ? <span className="text-emerald-500">已完成</span> : null}
                    {turnState === "failed" || turnState === "stalled" ? <span className="text-rose-500">出错</span> : null}
                    {turnState === "interrupted" ? <span className="text-slate-400">已中断</span> : null}
                    {turnState === "running" ? <button type="button" className="ml-auto rounded-full bg-rose-50 px-2 py-0.5 text-xs font-medium text-rose-600" onClick={sendInterrupt}>停止</button> : null}
                  </div>
                  <div className="whitespace-pre-wrap">{reply || (turnState === "queued" || turnState === "running" ? "…" : "")}</div>
                </div>
              </div>
            ) : null}
          </main>

          {/* Composer */}
          <footer className="flex-shrink-0 border-t border-slate-200 bg-white px-3 pb-[max(0.5rem,env(safe-area-inset-bottom))] pt-2">
            {attachment ? (
              <div className="mb-2 flex items-center gap-2 rounded-xl bg-slate-50 p-2">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={attachment.preview} alt="" className="h-11 w-11 rounded-lg object-cover" />
                <span className="flex-1 truncate text-xs text-slate-500">{attachment.name}</span>
                <button type="button" className="text-xs font-medium text-rose-500" onClick={() => setAttachment(null)}>移除</button>
              </div>
            ) : null}
            {toast ? <p className="mb-1 rounded-lg bg-slate-800/90 px-3 py-1.5 text-center text-xs text-white">{toast}</p> : null}
            {listeningVoice ? <p className="mb-1 text-center text-xs font-medium text-indigo-500">🎙 正在聆听… 点麦克风停止</p> : (!toast && log[0] ? <p className="mb-1 truncate text-center text-xs text-slate-400">{log[0]}</p> : null)}
            <div className="flex items-end gap-2">
              <label className="flex h-10 w-10 flex-shrink-0 cursor-pointer items-center justify-center rounded-full bg-slate-100 text-lg active:bg-slate-200" title="添加图片">
                📷<input type="file" accept="image/*" className="hidden" onChange={pickImage} />
              </label>
              <button type="button" onClick={toggleVoice} title="语音输入"
                className={`flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full text-lg transition ${listeningVoice ? "animate-pulse bg-rose-500 text-white ring-4 ring-rose-200" : "bg-slate-100 active:bg-slate-200"}`}>🎙</button>
              <textarea rows={1} className="max-h-28 min-h-[2.5rem] flex-1 resize-none rounded-2xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm focus:border-indigo-400 focus:outline-none"
                value={task} onChange={(e) => setTask(e.target.value)} placeholder="发消息 / 派任务给桌面…"
                onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendTask(); } }} />
              <button type="button" onClick={sendTask} disabled={!task.trim() && !attachment}
                className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full bg-indigo-600 text-white disabled:bg-slate-300 active:bg-indigo-700" title="发送">➤</button>
            </div>
          </footer>
        </>
      )}

      {/* Workspace / session bottom sheet */}
      {pickerOpen ? (
        <div className="fixed inset-0 z-20 flex flex-col justify-end bg-black/30" onClick={() => setPickerOpen(false)}>
          <div className="max-h-[75vh] overflow-y-auto rounded-t-2xl bg-white p-4 pb-[max(1rem,env(safe-area-inset-bottom))]" onClick={(e) => e.stopPropagation()}>
            <div className="mx-auto mb-3 h-1 w-10 rounded-full bg-slate-300" />
            <h2 className="text-sm font-semibold text-slate-700">工作空间</h2>
            <div className="mt-2 flex flex-wrap gap-2">
              {projects.length ? projects.map((p) => (
                <button key={p.id} type="button" onClick={() => selectProject(p.id)}
                  className={`rounded-full px-3 py-1.5 text-sm ${p.id === selectedProjectId ? "bg-indigo-600 text-white" : "bg-slate-100 text-slate-600"}`}>
                  {p.pinned ? "📌 " : ""}{p.name}
                </button>
              )) : <span className="text-xs text-slate-400">仅当前工作空间</span>}
            </div>
            <h2 className="mt-5 text-sm font-semibold text-slate-700">会话</h2>
            <ul className="mt-2 space-y-1">
              {sessions.length ? sessions.map((s) => (
                <li key={s.id}>
                  <button type="button" onClick={() => { selectSession(s.id); setPickerOpen(false); }}
                    className={`flex w-full items-center gap-2 rounded-xl px-3 py-2.5 text-left text-sm ${s.id === selectedSessionId ? "bg-indigo-50 text-indigo-700" : "active:bg-slate-100"}`}>
                    <span className="flex-1 truncate">{s.title || "未命名会话"}</span>
                    {s.id === selectedSessionId ? <span className="text-xs">✓</span> : null}
                  </button>
                </li>
              )) : <li className="px-3 py-2 text-xs text-slate-400">该工作空间暂无会话</li>}
            </ul>
            <button type="button" className="mt-4 w-full rounded-xl bg-slate-100 py-2.5 text-sm font-medium text-slate-600" onClick={() => setPickerOpen(false)}>关闭</button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
