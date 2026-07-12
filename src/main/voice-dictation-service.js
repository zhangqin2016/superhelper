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
// The realtime gateway intermittently drops a fresh socket before it is ready
// (esp. rapid reconnects) — the same instability seen across the endpoint.
// Retry the CONNECT a few times with backoff before surfacing an error; once
// the session is ready a drop ends dictation (reconnecting mid-utterance would
// lose audio). Read at call time so tests (and ops) can tune them.
function connectMaxAttempts() {
  return Math.max(1, Number(process.env.LILY_ASR_CONNECT_ATTEMPTS) || 3);
}
function connectBackoffMs() {
  const v = Number(process.env.LILY_ASR_CONNECT_BACKOFF_MS);
  return Number.isFinite(v) && v >= 0 ? v : 400;
}

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

/** Managed gateway relay (media_delivery_mode = "gateway"): the server keeps
 *  the DashScope key and bridges the realtime WS behind /llm/asr; the client
 *  authenticates with the vision gateway token already delivered in its
 *  DASHSCOPE_API_KEY slot. No relay URL (direct/BYOK mode) → dial DashScope
 *  directly with the real key. */
function defaultResolveRelay() {
  const { resolveSettingsEnvValue } = require("./agent-settings");
  const url = String(resolveSettingsEnvValue("LILY_ASR_RELAY_URL") || "").trim();
  if (!url) return null;
  const token = String(resolveSettingsEnvValue("DASHSCOPE_API_KEY", "ALIYUN_BAILIAN_API_KEY") || "").trim();
  if (!token) return null;
  return { url: url.replace(/\/+$/, ""), token };
}

/** Parse an SSE chunk stream incrementally; returns the JSON payloads of
 *  complete `data:` events and the unconsumed remainder. */
function drainSseBuffer(buffer) {
  const events = [];
  let rest = buffer;
  for (;;) {
    const cut = rest.indexOf("\n\n");
    if (cut === -1) break;
    const block = rest.slice(0, cut);
    rest = rest.slice(cut + 2);
    for (const line of block.split("\n")) {
      if (!line.startsWith("data:")) continue;
      try {
        events.push(JSON.parse(line.slice(5).trim()));
      } catch {
        // keepalives / malformed frames are ignored
      }
    }
  }
  return { events, rest };
}

/**
 * One dictation session at a time (a second start stops the first). All deps
 * are injectable so the whole lifecycle closes the loop in plain-node tests.
 */
function createVoiceDictationService({
  resolveApiKey = defaultResolveApiKey,
  resolveRelay = defaultResolveRelay,
  WebSocketCtor = globalThis.WebSocket,
  fetchImpl = globalThis.fetch,
  resolveUrl = resolveAsrUrl,
} = {}) {
  let active = null; // ws mode: { ws, ... } | relay mode: { relay, sessionId, outbox, ... }

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
    try {
      session.abort?.abort?.();
    } catch {
      // best effort
    }
    if (notifyClosed) emitTo(session.sender, { kind: "closed" });
  }

  async function pumpRelayEvents(session) {
    let response;
    try {
      response = await fetchImpl(`${session.relay.url}/sessions/${session.sessionId}/events`, {
        headers: { authorization: `Bearer ${session.relay.token}` },
        signal: session.abort.signal,
      });
    } catch {
      response = null;
    }
    if (!response?.ok || !response.body) {
      if (active === session) {
        emitTo(session.sender, { kind: "error", code: "ASR_RELAY_EVENTS_FAILED", message: "event stream unavailable" });
        teardown(session, { notifyClosed: true });
      }
      return;
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const drained = drainSseBuffer(buffer);
        buffer = drained.rest;
        for (const event of drained.events) {
          emitTo(session.sender, event);
          if (event.kind === "finished" || event.kind === "closed") {
            session.finished = true;
            teardown(session, { notifyClosed: event.kind !== "closed" });
            return;
          }
        }
      }
    } catch {
      // stream aborted (teardown) or network drop — fall through
    }
    if (active === session && !session.finished) {
      teardown(session, { notifyClosed: true });
    }
  }

  function flushRelayOutbox(session) {
    if (session.posting || !session.outbox.length || !session.sessionId) return;
    session.posting = true;
    const chunks = session.outbox.splice(0);
    fetchImpl(`${session.relay.url}/sessions/${session.sessionId}/audio`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${session.relay.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ chunks }),
      signal: session.abort.signal,
    }).catch(() => {
      // Dropped audio frames degrade transcription, not the app.
    }).finally(() => {
      session.posting = false;
      flushRelayOutbox(session);
    });
  }

  function startRelay(relay, sender) {
    const session = {
      relay,
      sender,
      sessionId: "",
      abort: new AbortController(),
      outbox: [],
      posting: false,
      finished: false,
      finishTimer: null,
    };
    active = session;
    void (async () => {
      let response;
      try {
        response = await fetchImpl(`${relay.url}/sessions`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${relay.token}`,
            "content-type": "application/json",
          },
          body: "{}",
          signal: session.abort.signal,
        });
      } catch (err) {
        response = { ok: false, _err: err };
      }
      if (active !== session) return;
      if (!response.ok) {
        emitTo(sender, {
          kind: "error",
          code: `ASR_RELAY_HTTP_${response.status || 0}`,
          message: String(response._err?.message || "relay session rejected"),
        });
        teardown(session, { notifyClosed: true });
        return;
      }
      let payload = null;
      try {
        payload = await response.json();
      } catch {
        payload = null;
      }
      session.sessionId = String(payload?.sessionId || "");
      if (!session.sessionId) {
        emitTo(sender, { kind: "error", code: "ASR_RELAY_BAD_SESSION", message: "relay returned no session id" });
        teardown(session, { notifyClosed: true });
        return;
      }
      void pumpRelayEvents(session);
      flushRelayOutbox(session);
    })();
    return { ok: true, transport: "relay" };
  }

  return {
    isActive() {
      return Boolean(active);
    },

    start({ sender } = {}) {
      if (!dictationEnabled()) return { ok: false, error: "VOICE_DICTATION_DISABLED" };
      if (active) teardown(active, { notifyClosed: true });
      // Managed gateway relay first — mirrors how every other media call
      // routes when the admin keeps keys server-side.
      const relay = resolveRelay();
      if (relay) return startRelay(relay, sender);
      const apiKey = String(resolveApiKey() || "").trim();
      if (!apiKey) return { ok: false, error: "NO_DASHSCOPE_KEY" };

      // The session survives across connect retries so buffered audio (fed by
      // the renderer before `ready`) rides the eventual live socket.
      const session = { ws: null, sender, finishTimer: null, finished: false, ready: false, stopped: false };
      active = session;

      const dial = (attempt) => {
        if (active !== session || session.stopped) return;
        let ws;
        try {
          ws = new WebSocketCtor(resolveUrl(), {
            headers: {
              authorization: `Bearer ${apiKey}`,
              "openai-beta": "realtime=v1",
            },
          });
        } catch (err) {
          retryOrFail(attempt, err);
          return;
        }
        session.ws = ws;
        ws.onopen = () => {
          try {
            ws.send(JSON.stringify(buildSessionUpdate()));
          } catch (err) {
            retryOrFail(attempt, err);
          }
        };
        ws.onmessage = (message) => {
          const parsed = parseAsrServerEvent(message?.data);
          if (!parsed) return;
          if (parsed.kind === "ready") session.ready = true;
          emitTo(sender, parsed);
          if (parsed.kind === "finished") {
            session.finished = true;
            teardown(session, { notifyClosed: true });
          } else if (parsed.kind === "error") {
            log.warn(`asr error: ${parsed.code} ${parsed.message}`);
          }
        };
        ws.onerror = (err) => {
          if (session.ready || active !== session) return; // post-ready drop → onclose ends it
          log.warn(`asr socket error (attempt ${attempt}): ${err?.message || err?.error?.message || "socket error"}`);
          retryOrFail(attempt, err);
        };
        ws.onclose = () => {
          if (active !== session) return;
          if (session.ready) {
            // A drop after transcripts began: end cleanly, do not silently
            // reconnect (buffered audio mid-utterance can't be replayed).
            teardown(session, { notifyClosed: true });
          } else if (!session.stopped) {
            retryOrFail(attempt, new Error("closed before ready"));
          }
        };
      };

      const retryOrFail = (attempt, err) => {
        if (active !== session || session.stopped) return;
        try {
          session.ws?.close?.();
        } catch { /* best effort */ }
        session.ws = null;
        if (attempt < connectMaxAttempts()) {
          const delay = connectBackoffMs() * attempt;
          emitTo(sender, { kind: "reconnecting", attempt });
          session.finishTimer = setTimeout(() => dial(attempt + 1), delay);
          return;
        }
        log.warn(`asr connect failed after ${attempt} attempts: ${err?.message || err}`);
        emitTo(sender, { kind: "error", code: "ASR_SOCKET_ERROR", message: String(err?.message || "connection error") });
        teardown(session, { notifyClosed: true });
      };

      dial(1);
      return { ok: true };
    },

    feed(base64Audio) {
      const session = active;
      if (!session) return false;
      if (session.relay) {
        // Outbox drains sequentially — one in-flight POST carrying every
        // queued frame, so batching adapts to network latency automatically.
        session.outbox.push(String(base64Audio || ""));
        if (session.outbox.length > 120) session.outbox.shift();
        flushRelayOutbox(session);
        return true;
      }
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
      // session.finish flushes the trailing segment; the upstream answers with
      // the last `completed` + `session.finished`. A grace timer guarantees
      // teardown even if it never does.
      if (session.relay) {
        if (session.sessionId) {
          fetchImpl(`${session.relay.url}/sessions/${session.sessionId}/finish`, {
            method: "POST",
            headers: {
              authorization: `Bearer ${session.relay.token}`,
              "content-type": "application/json",
            },
            body: "{}",
          }).catch(() => {});
        }
        session.finishTimer = setTimeout(() => {
          if (!session.finished) teardown(session, { notifyClosed: true });
        }, FINISH_GRACE_MS);
        return { ok: true };
      }
      // Stop during connect retries: cancel the pending redial and end now.
      session.stopped = true;
      clearTimeout(session.finishTimer);
      if (!session.ready || !session.ws) {
        teardown(session, { notifyClosed: true });
        return { ok: true };
      }
      try {
        session.ws.send(JSON.stringify({ type: "session.finish" }));
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
  drainSseBuffer,
  parseAsrServerEvent,
  registerVoiceDictationIpc,
  resolveAsrUrl,
};
