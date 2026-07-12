#!/usr/bin/env node
// Voice dictation (Qwen3-ASR-Flash-Realtime): protocol builders/parsers are
// pure, and the whole service lifecycle closes the loop against an injected
// fake WebSocket — no network, no electron.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lily-voice-"));
process.env.LILY_USER_DATA_DIR = tmp;
const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const svc = require(path.join(ROOT, "src/main/voice-dictation-service.js"));

// --- pure protocol pieces ----------------------------------------------------
{
  const update = svc.buildSessionUpdate();
  assert.equal(update.type, "session.update");
  assert.equal(update.session.input_audio_format, "pcm");
  assert.equal(update.session.sample_rate, 16000);
  assert.equal(update.session.turn_detection.type, "server_vad", "server VAD segments utterances");

  const append = svc.buildAppendEvent("QUJD");
  assert.deepEqual(append, { type: "input_audio_buffer.append", audio: "QUJD" });

  assert.equal(svc.resolveAsrUrl(), "wss://dashscope.aliyuncs.com/api-ws/v1/realtime?model=qwen3-asr-flash-realtime");
  process.env.LILY_ASR_MODEL = "qwen3-asr-realtime-custom";
  assert.match(svc.resolveAsrUrl(), /model=qwen3-asr-realtime-custom/);
  delete process.env.LILY_ASR_MODEL;

  assert.deepEqual(svc.parseAsrServerEvent(JSON.stringify({ type: "session.created" })), { kind: "ready" });
  assert.deepEqual(
    svc.parseAsrServerEvent(JSON.stringify({
      type: "conversation.item.input_audio_transcription.text",
      text: "你好，", stash: "世界", item_id: "item_1",
    })),
    { kind: "partial", text: "你好，", stash: "世界", itemId: "item_1" },
    "partial events carry confirmed text + provisional stash",
  );
  assert.deepEqual(
    svc.parseAsrServerEvent(JSON.stringify({
      type: "conversation.item.input_audio_transcription.completed",
      transcript: "你好，世界。", item_id: "item_1",
    })),
    { kind: "final", transcript: "你好，世界。", itemId: "item_1" },
  );
  assert.equal(svc.parseAsrServerEvent(JSON.stringify({ type: "input_audio_buffer.speech_started" })).kind, "vad");
  assert.equal(svc.parseAsrServerEvent(JSON.stringify({ type: "session.finished" })).kind, "finished");
  assert.equal(svc.parseAsrServerEvent(JSON.stringify({ type: "error", error: { code: "X", message: "y" } })).kind, "error");
  assert.equal(svc.parseAsrServerEvent("not json"), null, "garbage frames are ignored");
  assert.equal(svc.parseAsrServerEvent(JSON.stringify({ type: "response.unknown" })), null, "unknown events are ignored");
}

// --- full lifecycle against a fake socket -------------------------------------
class FakeWebSocket {
  static OPEN = 1;
  constructor(url, options) {
    FakeWebSocket.last = this;
    this.url = url;
    this.options = options;
    this.readyState = 0;
    this.sent = [];
    this.closed = false;
  }
  send(data) { this.sent.push(JSON.parse(data)); }
  close() { this.closed = true; }
  open() { this.readyState = 1; this.onopen?.(); }
  serverEvent(obj) { this.onmessage?.({ data: JSON.stringify(obj) }); }
}

function fakeSender() {
  return { events: [], send(_channel, payload) { this.events.push(payload); }, isDestroyed: () => false };
}

{
  const service = svc.createVoiceDictationService({
    resolveApiKey: () => "sk-test-dashscope",
    WebSocketCtor: FakeWebSocket,
    resolveUrl: () => "wss://fake.example/api-ws/v1/realtime?model=qwen3-asr-flash-realtime",
  });

  const sender = fakeSender();
  const started = service.start({ sender });
  assert.equal(started.ok, true, `start should succeed: ${JSON.stringify(started)}`);
  const ws = FakeWebSocket.last;
  assert.equal(ws.options.headers.authorization, "Bearer sk-test-dashscope", "the key rides the socket header, never the renderer");

  // Audio before the session is ready is refused (the renderer buffers it).
  assert.equal(service.feed("QUJD"), false, "feed before open is refused");

  ws.open();
  assert.equal(ws.sent[0].type, "session.update", "session.update is the first frame");

  ws.serverEvent({ type: "session.created" });
  assert.deepEqual(sender.events[0], { kind: "ready" });

  assert.equal(service.feed("QUJD"), true);
  assert.deepEqual(ws.sent[1], { type: "input_audio_buffer.append", audio: "QUJD" });

  ws.serverEvent({ type: "input_audio_buffer.speech_started" });
  ws.serverEvent({ type: "conversation.item.input_audio_transcription.text", text: "打开", stash: "文件", item_id: "i1" });
  ws.serverEvent({ type: "conversation.item.input_audio_transcription.completed", transcript: "打开文件。", item_id: "i1" });
  assert.equal(sender.events.at(-2).kind, "partial");
  assert.equal(sender.events.at(-1).transcript, "打开文件。");

  const stopped = service.stop();
  assert.equal(stopped.ok, true);
  assert.equal(ws.sent.at(-1).type, "session.finish", "stop flushes via session.finish");

  ws.serverEvent({ type: "session.finished" });
  assert.equal(sender.events.at(-1).kind, "closed", "the renderer learns the session closed");
  assert.equal(service.isActive(), false, "session is torn down after finished");
  assert.equal(ws.closed, true);
}

// --- guards --------------------------------------------------------------------
{
  const noKey = svc.createVoiceDictationService({ resolveApiKey: () => "", WebSocketCtor: FakeWebSocket });
  assert.deepEqual(noKey.start({ sender: fakeSender() }), { ok: false, error: "NO_DASHSCOPE_KEY" });

  process.env.LILY_VOICE_DICTATION = "0";
  const killed = svc.createVoiceDictationService({ resolveApiKey: () => "sk-x", WebSocketCtor: FakeWebSocket });
  assert.equal(killed.start({ sender: fakeSender() }).error, "VOICE_DICTATION_DISABLED", "kill switch blocks start");
  delete process.env.LILY_VOICE_DICTATION;
}

// --- connect retry: transient gateway drops before ready auto-reconnect --------
// (field: the realtime gateway intermittently kills a fresh socket; a single
// attempt surfaced "语音识别连接出现问题" instead of just retrying)
{
  process.env.LILY_ASR_CONNECT_BACKOFF_MS = "1";
  try {
    const built = [];
    class FlakyWS {
      static OPEN = 1;
      constructor() { FlakyWS.count = (FlakyWS.count || 0) + 1; this.n = FlakyWS.count; this.readyState = 0; this.sent = []; built.push(this); }
      send(d) { this.sent.push(JSON.parse(d)); }
      close() { this.closed = true; }
    }
    FlakyWS.count = 0;
    const service = svc.createVoiceDictationService({
      resolveApiKey: () => "sk-x",
      resolveRelay: () => null,
      WebSocketCtor: FlakyWS,
    });
    const sender = fakeSender();
    assert.equal(service.start({ sender }).ok, true);
    // Attempt 1: error before ready → should redial, not surface an error.
    built[0].onerror?.({ message: "boom" });
    await new Promise((r) => setTimeout(r, 10));
    assert.ok(sender.events.some((e) => e.kind === "reconnecting"), "an early drop emits reconnecting, not error");
    assert.equal(sender.events.filter((e) => e.kind === "error").length, 0, "no error surfaced while retries remain");
    assert.ok(built.length >= 2, "a second socket was dialed");
    // Attempt 2 succeeds.
    built[1].readyState = 1;
    built[1].onopen?.();
    built[1].onmessage?.({ data: JSON.stringify({ type: "session.created" }) });
    assert.ok(sender.events.some((e) => e.kind === "ready"), "the retry reaches ready");
    assert.equal(service.isActive(), true);
    service.stop();
  } finally {
    delete process.env.LILY_ASR_CONNECT_BACKOFF_MS;
  }
}

// --- connect retry exhausts → error surfaces ------------------------------------
{
  process.env.LILY_ASR_CONNECT_ATTEMPTS = "2";
  process.env.LILY_ASR_CONNECT_BACKOFF_MS = "1";
  try {
    class DeadWS {
      static OPEN = 1;
      constructor() { DeadWS.all = DeadWS.all || []; DeadWS.all.push(this); this.readyState = 0; }
      send() {}
      close() { this.closed = true; }
    }
    DeadWS.all = [];
    const service = svc.createVoiceDictationService({ resolveApiKey: () => "sk-x", resolveRelay: () => null, WebSocketCtor: DeadWS });
    const sender = fakeSender();
    service.start({ sender });
    DeadWS.all[0].onerror?.({ message: "x" });
    await new Promise((r) => setTimeout(r, 10));
    DeadWS.all[1].onerror?.({ message: "x" });
    await new Promise((r) => setTimeout(r, 10));
    assert.ok(sender.events.some((e) => e.kind === "error"), "error surfaces only after attempts exhaust");
    assert.equal(service.isActive(), false);
  } finally {
    delete process.env.LILY_ASR_CONNECT_ATTEMPTS;
    delete process.env.LILY_ASR_CONNECT_BACKOFF_MS;
  }
}

// --- relay transport (gateway media mode) against a fake fetch ------------------
{
  const calls = [];
  let sseController = null;
  const sseStream = new ReadableStream({
    start(controller) { sseController = controller; },
  });
  const encoder = new TextEncoder();
  const fakeFetch = async (url, init = {}) => {
    calls.push({ url, method: init.method || "GET", body: init.body || "" });
    if (url.endsWith("/sessions") && init.method === "POST") {
      return { ok: true, status: 200, json: async () => ({ ok: true, sessionId: "asr_test_1" }) };
    }
    if (url.includes("/events")) {
      return { ok: true, status: 200, body: sseStream };
    }
    return { ok: true, status: 200, json: async () => ({ ok: true }) };
  };

  const service = svc.createVoiceDictationService({
    resolveApiKey: () => "",
    resolveRelay: () => ({ url: "https://lily.example/llm/asr", token: "lgw.token.abc" }),
    WebSocketCtor: FakeWebSocket,
    fetchImpl: fakeFetch,
  });
  const sender = fakeSender();
  const started = service.start({ sender });
  assert.equal(started.ok, true);
  assert.equal(started.transport, "relay", "gateway mode selects the relay transport");
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(calls[0].url, "https://lily.example/llm/asr/sessions", "relay session created");
  assert.match(calls[1].url, /\/sessions\/asr_test_1\/events$/, "event stream attached");

  assert.equal(service.feed("QUJD"), true, "relay feed accepts audio");
  await new Promise((resolve) => setTimeout(resolve, 20));
  const audioCall = calls.find((c) => c.url.endsWith("/audio"));
  assert.ok(audioCall, "audio frame POSTed to the relay");
  assert.deepEqual(JSON.parse(audioCall.body), { chunks: ["QUJD"] });

  sseController.enqueue(encoder.encode('data: {"kind":"ready"}\n\ndata: {"kind":"partial","text":"打开","stash":"文件"}\n\n'));
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(sender.events[0], { kind: "ready" }, "relay forwards ready");
  assert.equal(sender.events[1].kind, "partial");

  const stopped = service.stop();
  assert.equal(stopped.ok, true);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(calls.some((c) => c.url.endsWith("/finish")), "stop POSTs finish");

  sseController.enqueue(encoder.encode('data: {"kind":"final","transcript":"打开文件。"}\n\ndata: {"kind":"finished"}\n\n'));
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.ok(sender.events.some((e) => e.kind === "final"), "trailing final arrives after finish");
  assert.equal(service.isActive(), false, "relay session torn down on finished");
}

// --- SSE buffer parser -----------------------------------------------------------
{
  const one = svc.drainSseBuffer('data: {"kind":"ready"}\n\ndata: {"kind":"par');
  assert.deepEqual(one.events, [{ kind: "ready" }]);
  assert.equal(one.rest, 'data: {"kind":"par', "incomplete block stays buffered");
  const two = svc.drainSseBuffer(`${one.rest}tial","text":"a","stash":""}\n\n: keepalive\n\n`);
  assert.equal(two.events.length, 1);
  assert.equal(two.events[0].kind, "partial");
  assert.equal(two.rest, "");
}

// --- wiring (static) ------------------------------------------------------------
{
  const preload = fs.readFileSync(path.join(ROOT, "src/preload.js"), "utf8");
  for (const piece of ["voiceDictationStart", "voiceDictationStop", "voiceDictationAudio", "onVoiceDictationEvent"]) {
    assert.match(preload, new RegExp(piece), `preload exposes ${piece}`);
  }
  const mainJs = fs.readFileSync(path.join(ROOT, "src/main.js"), "utf8");
  assert.match(mainJs, /registerVoiceDictationIpc/, "main registers the voice IPC");
  // Managed gateway mode: the server relays the ASR socket and the client is
  // told via LILY_ASR_RELAY_URL — keys stay server-side like all other media.
  const serverApp = fs.readFileSync(path.join(ROOT, "server/src/app.js"), "utf8");
  assert.match(serverApp, /asrGatewayRoutes/, "server registers the ASR relay routes");
  assert.match(serverApp, /llm\/asr\/sessions/, "ASR session streams are exempt from the general rate limit");
  const clientConfig = fs.readFileSync(path.join(ROOT, "server/src/services/client-config.js"), "utf8");
  assert.match(clientConfig, /LILY_ASR_RELAY_URL/, "gateway media mode delivers the relay URL");
  const asrGateway = fs.readFileSync(path.join(ROOT, "server/src/services/asr-gateway.js"), "utf8");
  assert.match(asrGateway, /verifyModelGatewayToken/, "relay authenticates gateway tokens");
  assert.match(asrGateway, /session\.finish/, "relay flushes the trailing segment on finish");
  const appJs = fs.readFileSync(path.join(ROOT, "src/renderer/app.js"), "utf8");
  assert.match(appJs, /initVoiceDictation/, "renderer initializes voice dictation");
  const rendererModule = fs.readFileSync(path.join(ROOT, "src/renderer/modules/voice-dictation.js"), "utf8");
  assert.match(rendererModule, /AudioWorklet/, "capture runs off the main thread");
  assert.match(rendererModule, /PRE_READY_BUFFER_LIMIT/, "pre-ready audio is buffered, not dropped");
  for (const locale of ["zh-CN", "en", "ar"]) {
    const messages = JSON.parse(fs.readFileSync(path.join(ROOT, `src/renderer/i18n/locales/${locale}.json`), "utf8"));
    for (const key of ["composer.voice", "composer.voiceStop", "toast.voiceNoKey", "toast.voiceMicDenied", "toast.voiceError"]) {
      assert.ok(messages[key], `${locale} missing ${key}`);
    }
  }
}

console.log("voice-dictation: ok");
