"use client";

// Voice dictation for the composer. Server ASR first (works on iOS Safari,
// which has no browser speech API): the pairing buys a scoped ASR token, the
// microphone is resampled to 16 kHz PCM and streamed, finals come back over
// SSE. Browser dictation is the fallback. Everything that goes wrong is said
// through `onNotice` — never a silent failure.

import { useCallback, useRef, useState } from "react";

export function useVoiceInput({ client, onText, onNotice }) {
  const [listening, setListening] = useState(false);
  const recognitionRef = useRef(null);
  const asrRef = useRef(null);

  const stopServerAsr = useCallback(() => {
    const a = asrRef.current;
    asrRef.current = null;
    if (!a) return;
    a.stopped = true;
    try { a.processor.disconnect(); } catch { /* noop */ }
    try { a.source.disconnect(); } catch { /* noop */ }
    try { a.ctx.close(); } catch { /* noop */ }
    try { a.stream.getTracks().forEach((t) => t.stop()); } catch { /* noop */ }
    try { a.abort.abort(); } catch { /* noop */ }
    if (a.sessionId) fetch(`${a.base}/llm/asr/sessions/${a.sessionId}/finish`, { method: "POST", headers: { Authorization: `Bearer ${a.token}` } }).catch(() => {});
    setListening(false);
  }, []);

  // True when it took over the microphone (or already told the user why not);
  // false means "not available here — try browser dictation".
  const startServerAsr = useCallback(async () => {
    const grant = client?.grant();
    if (!grant) return false;
    if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) return false;
    const AC = typeof window !== "undefined" ? (window.AudioContext || window.webkitAudioContext) : null;
    if (!AC) return false;
    const tokenRes = await client.authorizedPost("/api/mobile/asr/token");
    if (!tokenRes.ok || !tokenRes.json?.asrToken) return false;
    const token = tokenRes.json.asrToken;
    const base = grant.url;
    let stream;
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } }); }
    catch { onNotice("麦克风被拒绝：请在浏览器里允许麦克风权限"); return true; }
    let sessionId = "";
    try {
      const res = await fetch(`${base}/llm/asr/sessions`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: "{}" });
      const j = await res.json().catch(() => ({}));
      sessionId = j.sessionId || j.id || "";
      if (!res.ok || !sessionId) { stream.getTracks().forEach((t) => t.stop()); onNotice("语音服务暂不可用，改用浏览器听写"); return false; }
    } catch { stream.getTracks().forEach((t) => t.stop()); return false; }
    const ctx = new AC();
    const source = ctx.createMediaStreamSource(stream);
    const processor = ctx.createScriptProcessor(4096, 1, 1);
    const abort = new AbortController();
    const st = { stream, ctx, source, processor, sessionId, base, token, abort, stopped: false };
    asrRef.current = st;
    const outRate = 16000;
    processor.onaudioprocess = (ev) => {
      if (st.stopped) return;
      const input = ev.inputBuffer.getChannelData(0);
      const ratio = ctx.sampleRate / outRate; // resample (iOS ignores the 16k hint)
      const outLen = Math.max(0, Math.floor(input.length / ratio));
      const pcm = new Int16Array(outLen);
      for (let i = 0; i < outLen; i += 1) { const s = Math.max(-1, Math.min(1, input[Math.floor(i * ratio)] || 0)); pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff; }
      let bin = "";
      const bytes = new Uint8Array(pcm.buffer);
      for (let i = 0; i < bytes.length; i += 1) bin += String.fromCharCode(bytes[i]);
      fetch(`${base}/llm/asr/sessions/${sessionId}/audio`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ audio: btoa(bin) }) }).catch(() => {});
    };
    source.connect(processor);
    processor.connect(ctx.destination);
    setListening(true);
    onNotice("🎙 正在聆听（服务器识别）… 点麦克风停止");
    (async () => {
      try {
        const res = await fetch(`${base}/llm/asr/sessions/${sessionId}/events`, { headers: { Authorization: `Bearer ${token}` }, signal: abort.signal });
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        let buf = "";
        while (!st.stopped) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          const parts = buf.split("\n\n");
          buf = parts.pop() || "";
          for (const part of parts) {
            const line = part.split("\n").find((l) => l.startsWith("data:"));
            if (!line) continue;
            try { const evt = JSON.parse(line.slice(5).trim()); if (evt.kind === "final" && evt.transcript) onText(evt.transcript); }
            catch { /* keepalive / partial */ }
          }
        }
      } catch { /* aborted or ended */ }
    })();
    return true;
  }, [client, onNotice, onText]);

  const startBrowserSr = useCallback(() => {
    const SpeechRecognition = typeof window !== "undefined" ? (window.SpeechRecognition || window.webkitSpeechRecognition) : null;
    if (!SpeechRecognition) { onNotice("此浏览器不支持语音输入，请用 Chrome 打开，或直接输入文字"); return; }
    let recognition;
    try { recognition = new SpeechRecognition(); } catch { onNotice("语音输入启动失败，请直接输入文字"); return; }
    recognition.lang = "zh-CN";
    recognition.interimResults = true;
    recognition.continuous = true;
    recognition.onresult = (event) => {
      let text = "";
      for (let i = event.resultIndex || 0; i < event.results.length; i += 1) if (event.results[i]?.isFinal) text += event.results[i]?.[0]?.transcript || "";
      if (text) onText(text);
    };
    recognition.onerror = (e) => {
      const code = e?.error || "";
      recognitionRef.current = null;
      setListening(false);
      if (code === "not-allowed" || code === "service-not-allowed") onNotice("麦克风被拒绝：请在浏览器里允许麦克风权限");
      else if (code === "no-speech") onNotice("没听到声音，请再试一次");
      else if (code !== "aborted") onNotice(`语音输入出错：${code || "未知"}`);
    };
    recognition.onend = () => { recognitionRef.current = null; setListening(false); };
    try { recognition.start(); recognitionRef.current = recognition; setListening(true); onNotice("🎙 正在聆听，说完点一下麦克风停止"); }
    catch { recognitionRef.current = null; setListening(false); onNotice("语音输入启动失败，请直接输入文字"); }
  }, [onNotice, onText]);

  const toggle = useCallback(() => {
    if (asrRef.current) { stopServerAsr(); return; }
    if (recognitionRef.current) {
      try { recognitionRef.current.stop(); } catch { /* noop */ }
      recognitionRef.current = null;
      setListening(false);
      return;
    }
    void (async () => { if (!(await startServerAsr())) startBrowserSr(); })();
  }, [startServerAsr, stopServerAsr, startBrowserSr]);

  return { listening, toggle };
}
