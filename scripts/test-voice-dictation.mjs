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

// --- wiring (static) ------------------------------------------------------------
{
  const preload = fs.readFileSync(path.join(ROOT, "src/preload.js"), "utf8");
  for (const piece of ["voiceDictationStart", "voiceDictationStop", "voiceDictationAudio", "onVoiceDictationEvent"]) {
    assert.match(preload, new RegExp(piece), `preload exposes ${piece}`);
  }
  const mainJs = fs.readFileSync(path.join(ROOT, "src/main.js"), "utf8");
  assert.match(mainJs, /registerVoiceDictationIpc/, "main registers the voice IPC");
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
