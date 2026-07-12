"use strict";

/**
 * Realtime voice dictation over Qwen3-ASR-Flash-Realtime (DashScope).
 *
 * The renderer captures 16 kHz mono PCM16 via an AudioWorklet and streams it
 * here over IPC; this service holds the authenticated WebSocket (the API key
 * NEVER enters the renderer) and forwards transcription events back:
 *
 *   renderer mic ──ipc──▶ this service ──wss──▶ DashScope realtime ASR
 *   promptInput ◀─ipc─── partial/final events ◀── server VAD segmentation
 *
 * Protocol (OpenAI-realtime-compatible subset, verified against the
 * Model Studio docs 2026-07):
 *   client → session.update { input_audio_format:"pcm", sample_rate:16000,
 *            turn_detection:{type:"server_vad"} }
 *   client → input_audio_buffer.append { audio:<base64 pcm16> }  (~100ms/帧)
 *   client → session.finish
 *   server → conversation.item.input_audio_transcription.text       (partial:
 *            `text` = confirmed prefix, `stash` = provisional tail)
 *   server → conversation.item.input_audio_transcription.completed  (final:
 *            `transcript`, one per VAD segment)
 *   server → input_audio_buffer.speech_started / speech_stopped / session.finished
 *
 * FAIL-SAFE: purely additive feature — nothing here runs unless the user
 * presses the mic button. Kill switch: LILY_VOICE_DICTATION=0.
 */

const { getLogger } = require("./logger");

const log = getLogger("voice-dictation");

const DEFAULT_MODEL = "qwen3-asr-flash-realtime";
const DEFAULT_WS_BASE = "wss://dashscope.aliyuncs.com/api-ws/v1/realtime";
const FINISH_GRACE_MS = 2_500;

function dictationEnabled() {
  return process.env.LILY_VOICE_DICTATION !== "0";
}

function resolveAsrUrl() {
  const explicit = String(process.env.LILY_ASR_WS_URL || "").trim();
  if (explicit) return explicit;
  const model = String(process.env.LILY_ASR_MODEL || "").trim() || DEFAULT_MODEL;
  return `${DEFAULT_WS_BASE}?model=${encodeURIComponent(model)}`;
}

/** session.update payload — server VAD segments utterances; 500ms silence
 *  closes a segment (docs default 800ms reads sluggish for dictation). */
function buildSessionUpdate() {
  return {
    type: "session.update",
    session: {
      modalities: ["text"],
      input_audio_format: "pcm",
      sample_rate: 16000,
      turn_detection: {
        type: "server_vad",
        silence_duration_ms: 500,
      },
    },
  };
}

function buildAppendEvent(base64Audio) {
  return { type: "input_audio_buffer.append", audio: String(base64Audio || "") };
}

/** Map a raw server event onto the small vocabulary the renderer consumes.
 *  Unknown events map to null (ignored) — tolerant of protocol additions. */
function parseAsrServerEvent(raw) {
  let event = raw;
  if (typeof raw === "string") {
    try {
      event = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  const type = String(event?.type || "");
  switch (type) {
    case "session.created":
    case "session.updated":
      return { kind: "ready" };
    case "conversation.item.input_audio_transcription.text": {
      const confirmed = String(event.text || "");
      const stash = String(event.stash || "");
      return { kind: "partial", text: confirmed, stash, itemId: String(event.item_id || "") };
    }
    case "conversation.item.input_audio_transcription.completed":
      return { kind: "final", transcript: String(event.transcript || ""), itemId: String(event.item_id || "") };
    case "conversation.item.input_audio_transcription.failed":
      return {
        kind: "error",
        code: String(event?.error?.code || "TRANSCRIPTION_FAILED"),
        message: String(event?.error?.message || "transcription failed"),
      };
    case "input_audio_buffer.speech_started":
      return { kind: "vad", speaking: true };
    case "input_audio_buffer.speech_stopped":
      return { kind: "vad", speaking: false };
    case "session.finished":
      return { kind: "finished" };
    case "error":
      return {
        kind: "error",
        code: String(event?.error?.code || "ASR_ERROR"),
        message: String(event?.error?.message || "ASR service error"),
      };
    default:
      return null;
  }
}

function defaultResolveApiKey() {
  const { resolveSettingsEnvValue } = require("./agent-settings");
  return resolveSettingsEnvValue("DASHSCOPE_API_KEY", "ALIYUN_BAILIAN_API_KEY") || "";
}

/**
 * One dictation session at a time (a second start stops the first). All deps
 * are injectable so the whole lifecycle closes the loop in plain-node tests.
 */
function createVoiceDictationService({
  resolveApiKey = defaultResolveApiKey,
  WebSocketCtor = globalThis.WebSocket,
  resolveUrl = resolveAsrUrl,
} = {}) {
  let active = null; // { ws, send(eventObj), emit, finishTimer, finished }

  function emitTo(sender, payload) {
    try {
      if (!sender || sender.isDestroyed?.()) return;
      sender.send("voice:event", payload);
    } catch {
      // The window may be closing; dictation events are best-effort.
    }
  }

  function teardown(session, { notifyClosed = false } = {}) {
    if (!session) return;
    if (active === session) active = null;
    clearTimeout(session.finishTimer);
    try {
      session.ws?.close?.();
    } catch {
      // best effort
    }
    if (notifyClosed) emitTo(session.sender, { kind: "closed" });
  }

  return {
    isActive() {
      return Boolean(active);
    },

    start({ sender } = {}) {
      if (!dictationEnabled()) return { ok: false, error: "VOICE_DICTATION_DISABLED" };
      const apiKey = String(resolveApiKey() || "").trim();
      if (!apiKey) return { ok: false, error: "NO_DASHSCOPE_KEY" };
      if (active) teardown(active, { notifyClosed: true });

      let ws;
      try {
        ws = new WebSocketCtor(resolveUrl(), {
          headers: {
            authorization: `Bearer ${apiKey}`,
            "openai-beta": "realtime=v1",
          },
        });
      } catch (err) {
        return { ok: false, error: "ASR_CONNECT_FAILED", detail: err?.message || String(err) };
      }

      const session = { ws, sender, finishTimer: null, finished: false };
      active = session;

      ws.onopen = () => {
        try {
          ws.send(JSON.stringify(buildSessionUpdate()));
        } catch (err) {
          log.warn(`session.update send failed: ${err?.message || err}`);
          emitTo(sender, { kind: "error", code: "ASR_CONNECT_FAILED", message: String(err?.message || err) });
          teardown(session, { notifyClosed: true });
        }
      };
      ws.onmessage = (message) => {
        const parsed = parseAsrServerEvent(message?.data);
        if (!parsed) return;
        emitTo(sender, parsed);
        if (parsed.kind === "finished") {
          session.finished = true;
          teardown(session, { notifyClosed: true });
        } else if (parsed.kind === "error") {
          log.warn(`asr error: ${parsed.code} ${parsed.message}`);
        }
      };
      ws.onerror = (err) => {
        log.warn(`asr socket error: ${err?.message || err?.error?.message || "socket error"}`);
        emitTo(sender, { kind: "error", code: "ASR_SOCKET_ERROR", message: String(err?.message || "connection error") });
        teardown(session, { notifyClosed: true });
      };
      ws.onclose = () => {
        if (active === session || !session.finished) {
          teardown(session, { notifyClosed: true });
        }
      };
      return { ok: true };
    },

    feed(base64Audio) {
      const session = active;
      if (!session) return false;
      const ws = session.ws;
      if (!ws || ws.readyState !== (WebSocketCtor.OPEN ?? 1)) return false;
      try {
        ws.send(JSON.stringify(buildAppendEvent(base64Audio)));
        return true;
      } catch {
        return false;
      }
    },

    stop() {
      const session = active;
      if (!session) return { ok: true, idle: true };
      // session.finish flushes the trailing segment; the server answers with
      // the last `completed` + `session.finished`. A grace timer guarantees
      // teardown even if the gateway never答复.
      try {
        session.ws?.send?.(JSON.stringify({ type: "session.finish" }));
      } catch {
        teardown(session, { notifyClosed: true });
        return { ok: true };
      }
      session.finishTimer = setTimeout(() => {
        if (!session.finished) teardown(session, { notifyClosed: true });
      }, FINISH_GRACE_MS);
      return { ok: true };
    },
  };
}

let singleton = null;

function voiceDictationService() {
  if (!singleton) singleton = createVoiceDictationService();
  return singleton;
}

/** IPC surface: start/stop via invoke; PCM chunks ride fire-and-forget send. */
function registerVoiceDictationIpc() {
  const { ipcMain, systemPreferences } = require("electron");
  ipcMain.handle("voice:start", async (event) => {
    try {
      if (process.platform === "darwin" && systemPreferences?.askForMediaAccess) {
        const granted = await systemPreferences.askForMediaAccess("microphone");
        if (!granted) return { ok: false, error: "MIC_PERMISSION_DENIED" };
      }
    } catch {
      // Permission probing is best-effort; getUserMedia still gates access.
    }
    return voiceDictationService().start({ sender: event.sender });
  });
  ipcMain.handle("voice:stop", () => voiceDictationService().stop());
  ipcMain.on("voice:audio", (_event, base64Audio) => {
    voiceDictationService().feed(base64Audio);
  });
}

module.exports = {
  buildAppendEvent,
  buildSessionUpdate,
  createVoiceDictationService,
  parseAsrServerEvent,
  registerVoiceDictationIpc,
  resolveAsrUrl,
};
