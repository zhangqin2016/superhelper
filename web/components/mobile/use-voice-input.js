"use client";

// Voice dictation for the composer — the I/O around lib/mobile/dictation.mjs.
//
// Server ASR first (works on iOS Safari, which has no browser speech API):
// the pairing buys a scoped ASR token, the microphone is resampled to 16 kHz
// PCM and sent IN ORDER in ~250 ms batches, events come back over SSE and
// the transcript renders live (interim text included). "Stop" flushes the
// relay and keeps listening for results until it says it is finished, so the
// last sentence is not lost. Browser dictation is the fallback. Everything
// that goes wrong is said through `onNotice` — never a silent failure.
//
// iOS: the AudioContext is created synchronously in the tap, before any
// await, and resumed — created later it stays suspended and no audio flows.

import { useCallback, useEffect, useRef, useState } from "react";
import {
  abandon, begin, createAudioQueue, finishing, initialDictation, onAsrEvent, pcmToBase64, resampleTo16k, spoken, transcript,
} from "../../lib/mobile/dictation.mjs";

const FINISH_WAIT_MS = 4000;

const ERROR_TEXT = {
  ASR_CONNECT_FAILED: "语音服务连不上，请稍后再试",
  ASR_SOCKET_ERROR: "语音服务断开了，请再试一次",
  TRANSCRIPTION_FAILED: "没能识别，请再说一次",
};

/**
 * @param {{ client, getText: () => string, onValue: (text: string) => void, onNotice }} opts
 *   getText — the composer's text when dictation starts (kept as the base)
 *   onValue — the composer's text while dictating (base + what was heard)
 */
export function useVoiceInput({ client, getText, onValue, onNotice }) {
  const [view, setView] = useState({ phase: "idle", speaking: false });
  const dictRef = useRef(initialDictation(""));
  const asrRef = useRef(null);
  const recognitionRef = useRef(null);

  const setDict = useCallback((next) => {
    dictRef.current = next;
    setView({ phase: next.phase, speaking: next.speaking });
  }, []);

  const render = useCallback(() => onValue?.(transcript(dictRef.current)), [onValue]);

  const stopCapture = useCallback(() => {
    const a = asrRef.current;
    if (!a) return;
    try { a.processor.disconnect(); } catch { /* noop */ }
    try { a.source?.disconnect(); } catch { /* noop */ }
    try { a.stream?.getTracks().forEach((t) => t.stop()); } catch { /* noop */ }
    try { a.ctx.close(); } catch { /* noop */ }
  }, []);

  const endSession = useCallback(() => {
    const a = asrRef.current;
    asrRef.current = null;
    if (!a) return;
    stopCapture();
    try { a.abort.abort(); } catch { /* noop */ }
    if (a.finishTimer) clearTimeout(a.finishTimer);
  }, [stopCapture]);

  const applyEvent = useCallback((event) => {
    const { state, ended } = onAsrEvent(dictRef.current, event);
    setDict(state);
    render();
    if (state.error) onNotice(ERROR_TEXT[state.error] || `语音识别出错（${state.error}）`);
    if (ended) {
      const heard = spoken(state);
      endSession();
      if (!state.error && !heard.trim()) onNotice("没听到内容，请靠近麦克风再说一次");
    }
  }, [setDict, render, onNotice, endSession]);

  /** Stop: the relay flushes; results still arrive until it says finished. */
  const finishServerAsr = useCallback(async () => {
    const a = asrRef.current;
    if (!a) return;
    setDict(finishing(dictRef.current));
    stopCapture();
    await a.queue.drain();
    fetch(`${a.base}/llm/asr/sessions/${a.sessionId}/finish`, { method: "POST", headers: { Authorization: `Bearer ${a.token}` } }).catch(() => {});
    a.finishTimer = setTimeout(() => {
      if (asrRef.current !== a) return;
      applyEvent({ kind: "finished" }); // the relay never said so: keep what was heard
    }, FINISH_WAIT_MS);
  }, [setDict, stopCapture, applyEvent]);

  // `ctx` was created in the tap (iOS). True when the server path took over the
  // microphone (or already said why not); false = fall back to browser dictation.
  const startServerAsr = useCallback(async (ctx) => {
    const grant = client?.grant?.();
    if (!grant || !navigator.mediaDevices?.getUserMedia) return false;
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
    try { await ctx.resume(); } catch { /* best effort */ }
    const auth = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
    const queue = createAudioQueue({
      post: (chunks) => fetch(`${base}/llm/asr/sessions/${sessionId}/audio`, { method: "POST", headers: auth, body: JSON.stringify({ chunks }) }),
    });
    const source = ctx.createMediaStreamSource(stream);
    const processor = ctx.createScriptProcessor(4096, 1, 1);
    const abort = new AbortController();
    const st = { stream, ctx, source, processor, sessionId, base, token, abort, queue, finishTimer: null };
    asrRef.current = st;
    processor.onaudioprocess = (ev) => {
      if (asrRef.current !== st || dictRef.current.phase === "finishing") return;
      queue.push(pcmToBase64(resampleTo16k(ev.inputBuffer.getChannelData(0), ctx.sampleRate)));
    };
    source.connect(processor);
    processor.connect(ctx.destination);
    (async () => {
      try {
        const res = await fetch(`${base}/llm/asr/sessions/${sessionId}/events`, { headers: { Authorization: `Bearer ${token}` }, signal: abort.signal });
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        let buf = "";
        while (asrRef.current === st) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          const parts = buf.split("\n\n");
          buf = parts.pop() || "";
          for (const part of parts) {
            const line = part.split("\n").find((l) => l.startsWith("data:"));
            if (!line) continue;
            let evt = null;
            try { evt = JSON.parse(line.slice(5).trim()); } catch { continue; }
            if (asrRef.current === st) applyEvent(evt);
          }
        }
        if (asrRef.current === st) applyEvent({ kind: "closed" });
      } catch { if (asrRef.current === st) applyEvent({ kind: "closed" }); }
    })();
    return true;
  }, [client, onNotice, applyEvent]);

  const startBrowserSr = useCallback(() => {
    const SpeechRecognition = typeof window !== "undefined" ? (window.SpeechRecognition || window.webkitSpeechRecognition) : null;
    if (!SpeechRecognition) { setDict(abandon()); onNotice("此浏览器不支持语音输入，请用 Chrome 打开，或直接输入文字"); return; }
    let recognition;
    try { recognition = new SpeechRecognition(); } catch { setDict(abandon()); onNotice("语音输入启动失败，请直接输入文字"); return; }
    recognition.lang = "zh-CN";
    recognition.interimResults = true;
    recognition.continuous = true;
    recognition.onresult = (event) => {
      let finals = "";
      let interim = "";
      for (let i = event.resultIndex || 0; i < event.results.length; i += 1) {
        const piece = event.results[i]?.[0]?.transcript || "";
        if (event.results[i]?.isFinal) finals += piece; else interim += piece;
      }
      const { state } = onAsrEvent(dictRef.current, { kind: "partial", text: interim });
      setDict(finals ? onAsrEvent(state, { kind: "final", transcript: finals }).state : state);
      render();
    };
    recognition.onerror = (e) => {
      const code = e?.error || "";
      recognitionRef.current = null;
      setDict({ ...dictRef.current, phase: "idle", interim: "" });
      render();
      if (code === "not-allowed" || code === "service-not-allowed") onNotice("麦克风被拒绝：请在浏览器里允许麦克风权限");
      else if (code === "no-speech") onNotice("没听到声音，请再试一次");
      else if (code !== "aborted") onNotice(`语音输入出错：${code || "未知"}`);
    };
    recognition.onend = () => { recognitionRef.current = null; setDict({ ...dictRef.current, phase: "idle", interim: "" }); render(); };
    try { recognition.start(); recognitionRef.current = recognition; setDict({ ...dictRef.current, phase: "listening" }); }
    catch { recognitionRef.current = null; setDict(abandon()); onNotice("语音输入启动失败，请直接输入文字"); }
  }, [onNotice, render, setDict]);

  const toggle = useCallback(() => {
    if (asrRef.current) { void finishServerAsr(); return; }
    if (recognitionRef.current) { try { recognitionRef.current.stop(); } catch { /* noop */ } return; }
    if (dictRef.current.phase !== "idle") return;
    const AC = typeof window !== "undefined" ? (window.AudioContext || window.webkitAudioContext) : null;
    const ctx = AC ? new AC() : null; // in the tap, for iOS
    setDict(begin(dictRef.current, getText?.() || ""));
    void (async () => {
      const served = ctx ? await startServerAsr(ctx) : false;
      if (!served) { try { ctx?.close(); } catch { /* noop */ } startBrowserSr(); }
      else if (!asrRef.current) setDict(abandon()); // it said why (e.g. microphone refused)
    })();
  }, [finishServerAsr, startServerAsr, startBrowserSr, setDict, getText]);

  useEffect(() => () => { endSession(); try { recognitionRef.current?.stop(); } catch { /* noop */ } }, [endSession]);

  return { phase: view.phase, listening: view.phase !== "idle", speaking: view.speaking, toggle };
}
