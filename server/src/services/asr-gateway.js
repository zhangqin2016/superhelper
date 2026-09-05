import crypto from "node:crypto";
import { config } from "../config.js";
import { verifyLiveModelGatewayToken } from "./model-gateway/auth.js";
import { listModelGatewayProviders } from "./model-gateway/providers.js";

// Realtime ASR relay (voice dictation, qwen3-asr-flash-realtime).
//
// Gateway media delivery mode keeps the DashScope key server-side; realtime
// ASR is a WebSocket API, so this relay bridges it WITHOUT new dependencies:
//
//   client ──POST /llm/asr/sessions──────────▶ create session, dial upstream WS
//   client ──POST /llm/asr/sessions/:id/audio─▶ forward base64 PCM frames
//   client ◀─GET  /llm/asr/sessions/:id/events─ SSE stream of parsed events
//   client ──POST /llm/asr/sessions/:id/finish▶ flush + close
//
// The server side of the upstream leg uses Node's global WebSocket (Node 21+),
// acting as a CLIENT to DashScope — no ws/@fastify/websocket needed. Auth
// reuses the vision/DashScope gateway token the client already holds in its
// DASHSCOPE_API_KEY slot under gateway mode.
//
// NOTE: usage is not wallet-metered yet (membership users are covered anyway);
// per-second speech pricing is a follow-up before opening this to unit-billed
// accounts.

const DEFAULT_ASR_MODEL = "qwen3-asr-flash-realtime";
const UPSTREAM_BASE = "wss://dashscope.aliyuncs.com/api-ws/v1/realtime";
const MAX_SESSIONS = 64;
const IDLE_TIMEOUT_MS = 60_000;
const HARD_CAP_MS = 10 * 60_000;
const SSE_HEARTBEAT_MS = 15_000;

const sessions = new Map();

function upstreamUrl() {
  const model = String(process.env.LILY_ASR_MODEL || "").trim() || DEFAULT_ASR_MODEL;
  const base = String(process.env.LILY_ASR_UPSTREAM_WS || "").trim() || UPSTREAM_BASE;
  return base.includes("model=") ? base : `${base}?model=${encodeURIComponent(model)}`;
}

function resolveAsrApiKey() {
  try {
    const provider = listModelGatewayProviders().vision;
    if (provider?.apiKey) return provider.apiKey;
  } catch {
    // registry unavailable — env fallback below
  }
  return config.dashscopeApiKey || "";
}

function bearerToken(request) {
  const auth = String(request.headers.authorization || "").trim();
  if (auth.toLowerCase().startsWith("bearer ")) return auth.slice(7).trim();
  return String(request.headers["x-api-key"] || "").trim();
}

/** Same event vocabulary the desktop client's direct-WS path produces, so the
 *  renderer is transport-agnostic. (Deliberate small duplicate of the client
 *  parser — server and client do not share modules.) */
function parseUpstreamEvent(raw) {
  let event;
  try {
    event = JSON.parse(String(raw));
  } catch {
    return null;
  }
  switch (String(event?.type || "")) {
    case "session.created":
    case "session.updated":
      return { kind: "ready" };
    case "conversation.item.input_audio_transcription.text":
      return { kind: "partial", text: String(event.text || ""), stash: String(event.stash || ""), itemId: String(event.item_id || "") };
    case "conversation.item.input_audio_transcription.completed":
      return { kind: "final", transcript: String(event.transcript || ""), itemId: String(event.item_id || "") };
    case "conversation.item.input_audio_transcription.failed":
      return { kind: "error", code: String(event?.error?.code || "TRANSCRIPTION_FAILED"), message: String(event?.error?.message || "") };
    case "input_audio_buffer.speech_started":
      return { kind: "vad", speaking: true };
    case "input_audio_buffer.speech_stopped":
      return { kind: "vad", speaking: false };
    case "session.finished":
      return { kind: "finished" };
    case "error":
      return { kind: "error", code: String(event?.error?.code || "ASR_ERROR"), message: String(event?.error?.message || "") };
    default:
      return null;
  }
}

function pushEvent(session, payload) {
  if (session.sse) {
    try {
      session.sse.raw.write(`data: ${JSON.stringify(payload)}\n\n`);
      return;
    } catch {
      session.sse = null;
    }
  }
  session.backlog.push(payload);
  if (session.backlog.length > 500) session.backlog.shift();
}

function destroySession(session, { notifyClosed = true } = {}) {
  if (!sessions.has(session.id)) return;
  sessions.delete(session.id);
  clearTimeout(session.idleTimer);
  clearTimeout(session.capTimer);
  clearInterval(session.heartbeat);
  if (notifyClosed) pushEvent(session, { kind: "closed" });
  try {
    session.ws?.close?.();
  } catch {
    // best effort
  }
  if (session.sse) {
    try {
      session.sse.raw.end();
    } catch {
      // best effort
    }
    session.sse = null;
  }
}

function armIdleTimer(session) {
  clearTimeout(session.idleTimer);
  session.idleTimer = setTimeout(() => destroySession(session), IDLE_TIMEOUT_MS);
}

async function authorized(request, reply) {
  if (!config.modelGatewayEnabled) {
    reply.code(404).send({ error: { type: "not_found", message: "gateway disabled" } });
    return false;
  }
  const token = await verifyLiveModelGatewayToken(bearerToken(request), "vision");
  if (!token.ok) {
    reply.code(401).send({ error: { type: "authentication_error", message: token.code } });
    return false;
  }
  return true;
}

function sessionFor(request, reply) {
  const session = sessions.get(String(request.params.id || ""));
  if (!session) {
    reply.code(404).send({ error: { type: "not_found", message: "unknown asr session" } });
    return null;
  }
  return session;
}

export async function asrGatewayRoutes(app) {
  app.post(
    "/llm/asr/sessions",
    { schema: { tags: ["gateway:media"], summary: "Open a realtime ASR relay session" } },
    async (request, reply) => {
      if (!(await authorized(request, reply))) return reply;
      if (typeof WebSocket === "undefined") {
        return reply.code(501).send({ error: { type: "configuration_error", message: "ASR relay needs Node 21+ (global WebSocket)" } });
      }
      const apiKey = resolveAsrApiKey();
      if (!apiKey) {
        return reply.code(503).send({ error: { type: "configuration_error", message: "dashscope key not configured" } });
      }
      if (sessions.size >= MAX_SESSIONS) {
        return reply.code(429).send({ error: { type: "rate_limit_error", message: "too many concurrent dictation sessions" } });
      }

      const id = `asr_${crypto.randomUUID()}`;
      let ws;
      try {
        ws = new WebSocket(upstreamUrl(), {
          headers: { authorization: `Bearer ${apiKey}`, "openai-beta": "realtime=v1" },
        });
      } catch (error) {
        return reply.code(502).send({ error: { type: "upstream_error", message: String(error?.message || error) } });
      }
      const session = {
        id,
        ws,
        sse: null,
        backlog: [],
        finished: false,
        idleTimer: null,
        capTimer: setTimeout(() => destroySession(sessions.get(id) || session), HARD_CAP_MS),
        heartbeat: null,
      };
      sessions.set(id, session);
      armIdleTimer(session);

      ws.onopen = () => {
        try {
          ws.send(JSON.stringify({
            type: "session.update",
            session: {
              modalities: ["text"],
              input_audio_format: "pcm",
              sample_rate: 16000,
              turn_detection: { type: "server_vad", silence_duration_ms: 500 },
            },
          }));
        } catch (error) {
          pushEvent(session, { kind: "error", code: "ASR_CONNECT_FAILED", message: String(error?.message || error) });
          destroySession(session);
        }
      };
      ws.onmessage = (message) => {
        const parsed = parseUpstreamEvent(message?.data);
        if (!parsed) return;
        pushEvent(session, parsed);
        if (parsed.kind === "finished") {
          session.finished = true;
          destroySession(session);
        }
      };
      ws.onerror = () => {
        pushEvent(session, { kind: "error", code: "ASR_SOCKET_ERROR", message: "upstream connection error" });
        destroySession(session);
      };
      ws.onclose = () => {
        if (sessions.has(id) && !session.finished) destroySession(session);
      };

      return reply.send({ ok: true, sessionId: id });
    },
  );

  app.get(
    "/llm/asr/sessions/:id/events",
    { schema: { tags: ["gateway:media"], summary: "Stream ASR relay events (SSE)" } },
    async (request, reply) => {
      if (!(await authorized(request, reply))) return reply;
      const session = sessionFor(request, reply);
      if (!session) return reply;
      reply.raw.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      session.sse = reply;
      for (const payload of session.backlog.splice(0)) {
        reply.raw.write(`data: ${JSON.stringify(payload)}\n\n`);
      }
      clearInterval(session.heartbeat);
      session.heartbeat = setInterval(() => {
        try {
          reply.raw.write(": keepalive\n\n");
        } catch {
          clearInterval(session.heartbeat);
        }
      }, SSE_HEARTBEAT_MS);
      request.raw.on("close", () => {
        if (session.sse === reply) session.sse = null;
      });
      return reply;
    },
  );

  app.post(
    "/llm/asr/sessions/:id/audio",
    { schema: { tags: ["gateway:media"], summary: "Forward a base64 PCM16 frame" } },
    async (request, reply) => {
      if (!(await authorized(request, reply))) return reply;
      const session = sessionFor(request, reply);
      if (!session) return reply;
      armIdleTimer(session);
      const body = request.body && typeof request.body === "object" ? request.body : {};
      const chunks = Array.isArray(body.chunks) ? body.chunks : body.audio ? [body.audio] : [];
      for (const chunk of chunks) {
        const audio = String(chunk || "");
        if (!audio) continue;
        try {
          session.ws.send(JSON.stringify({ type: "input_audio_buffer.append", audio }));
        } catch {
          return reply.code(409).send({ error: { type: "upstream_error", message: "asr session not writable" } });
        }
      }
      return reply.send({ ok: true });
    },
  );

  app.post(
    "/llm/asr/sessions/:id/finish",
    { schema: { tags: ["gateway:media"], summary: "Flush and close an ASR relay session" } },
    async (request, reply) => {
      if (!(await authorized(request, reply))) return reply;
      const session = sessionFor(request, reply);
      if (!session) return reply;
      try {
        session.ws.send(JSON.stringify({ type: "session.finish" }));
      } catch {
        destroySession(session);
      }
      // The upstream answers with the trailing `completed` + session.finished;
      // the idle timer guarantees teardown if it never does.
      armIdleTimer(session);
      return reply.send({ ok: true });
    },
  );
}
