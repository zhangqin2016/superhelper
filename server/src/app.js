import Fastify from "fastify";
import cors from "@fastify/cors";
import cookie from "@fastify/cookie";
import multipart from "@fastify/multipart";
import { sql } from "kysely";
import pg from "pg";
import { config, assertProductionSecrets } from "./config.js";
import { db } from "./db.js";
import { publicRoutes } from "./routes/public.js";
import { adminRoutes } from "./routes/admin.js";
import { modelGatewayRoutes } from "./services/model-gateway.js";
import { mediaGatewayRoutes } from "./services/media-gateway.js";
import { asrGatewayRoutes } from "./services/asr-gateway.js";
import { registerMobileRelay } from "./services/mobile-relay.js";
import { ensureEnvManagedConfigProfile } from "./services/client-config.js";
import { refreshModelCatalog } from "./services/model-catalog.js";
import { ensureEnvQiniuConfigSeeded } from "./services/app-settings.js";
import { installDocOnlyCompilers, registerOpenapi } from "./openapi.js";
import { ADMIN_UPLOAD_LIMIT_BYTES } from "./limits.js";
import { createCollaborationWsTicketService } from "./services/collaboration/ws-ticket.js";
import { COLLABORATION_NOTIFY_CHANNEL, createRealtimeDispatcher, createRealtimeNotifyLifecycle } from "./services/collaboration/realtime-dispatcher.js";
import { registerCollaborationRealtimeGateway } from "./services/collaboration/realtime-gateway.js";

const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 120;
const rateBuckets = new Map();

function clientKey(request) {
  return request.ip || request.headers["x-forwarded-for"] || "unknown";
}

function checkRateLimit(request) {
  const now = Date.now();
  const key = String(clientKey(request));
  const bucket = rateBuckets.get(key);
  if (!bucket || now >= bucket.resetAt) {
    rateBuckets.set(key, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return true;
  }
  bucket.count += 1;
  return bucket.count <= RATE_LIMIT_MAX;
}

export async function buildApp() {
  assertProductionSecrets();
  const app = Fastify({
    logger: true,
    // Vision requests carry base64 images, and admin catalog uploads can carry workspace apps.
    bodyLimit: ADMIN_UPLOAD_LIMIT_BYTES,
  });

  await app.register(cors, {
    origin: true,
    credentials: true,
  });
  await app.register(cookie, {
    secret: config.sessionSecret,
  });
  await app.register(multipart, {
    limits: {
      fileSize: ADMIN_UPLOAD_LIMIT_BYTES,
      files: 1,
      fields: 32,
    },
  });

  app.addHook("preHandler", async (request, reply) => {
    if (!request.url.startsWith("/api/") && !request.url.startsWith("/llm/")) return;
    // Realtime dictation streams ~10 small audio frames per second — the
    // general per-IP budget would kill a session after ~12s. The ASR relay
    // has its own guards (session cap, idle/hard timers, gateway token auth).
    if (request.url.startsWith("/llm/asr/sessions")) return;
    if (checkRateLimit(request)) return;
    reply.code(429).send({ ok: false, code: "RATE_LIMITED" });
  });

  app.setErrorHandler((error, _request, reply) => {
    if (error?.name === "ZodError") {
      return reply.code(400).send({ ok: false, code: "VALIDATION_ERROR", issues: error.issues });
    }
    app.log.error(error);
    return reply.code(500).send({ ok: false, code: "INTERNAL_ERROR" });
  });

  // Pull the latest BYOK provider catalog from models.dev before building the
  // delivered config (best-effort; falls back to the vendored snapshot). Then
  // refresh daily and re-publish so clients get new models without an app/server
  // rebuild — the catalog is cached server-side; clients just receive it.
  await refreshModelCatalog();
  await ensureEnvManagedConfigProfile();
  await ensureEnvQiniuConfigSeeded();
  const catalogTimer = setInterval(() => {
    refreshModelCatalog()
      .then(() => ensureEnvManagedConfigProfile())
      .catch((err) => app.log.warn({ err }, "model catalog refresh failed"));
  }, 24 * 60 * 60 * 1000);
  catalogTimer.unref?.();
  await registerRoutes(app);
  // Mobile Command WebSocket relay: attaches to the underlying http server's
  // upgrade event (fastify has no WS server). Gated so it only runs in the full
  // app, not the doc-only app used by the OpenAPI coverage test.
  registerMobileRelay(app);
  // Durable sync remains the delivery source of truth. This optional layer
  // emits only wake-up hints and is absent entirely when rollout is disabled.
  if (config.collaborationEnabled && config.collaborationRealtimeEnabled && !config.collaborationKillSwitch) {
    const gateway = registerCollaborationRealtimeGateway(app, {
      ticketService: createCollaborationWsTicketService({ db }),
      resolveEphemeralRecipients: async ({ userId, conversationId }) => {
        const conversation = await db.selectFrom("conversations").select(["scope_type", "organization_id"])
          .where("id", "=", conversationId).where("status", "=", "active").executeTakeFirst();
        if (!conversation) return [];
        if (conversation.scope_type === "organization") {
          const organizationMembers = await db.selectFrom("organization_members").select("user_id")
            .where("organization_id", "=", conversation.organization_id).where("status", "=", "active").execute();
          const activeOrganizationUserIds = new Set(organizationMembers.map((member) => String(member.user_id)));
          if (!activeOrganizationUserIds.has(userId)) return [];
          const members = await db.selectFrom("conversation_members").select("user_id")
            .where("conversation_id", "=", conversationId).where("status", "=", "active").execute();
          return members.map((member) => String(member.user_id)).filter((memberId) => activeOrganizationUserIds.has(memberId));
        }
        const members = await db.selectFrom("conversation_members").select("user_id")
          .where("conversation_id", "=", conversationId).where("status", "=", "active").execute();
        const recipientUserIds = members.map((member) => String(member.user_id));
        return recipientUserIds.includes(userId) ? recipientUserIds : [];
      },
    });
    const dispatcher = createRealtimeDispatcher({
      db,
      notify: async ({ userId, maxCursor }) => {
        gateway.notifySyncAvailable(userId, maxCursor);
        await sql`select pg_notify(${COLLABORATION_NOTIFY_CHANNEL}, ${JSON.stringify({ userId, cursor: maxCursor })})`.execute(db);
      },
    });
    let realtimeTimer = null;
    const startDispatcher = () => {
      if (realtimeTimer) return;
      realtimeTimer = setInterval(() => dispatcher.dispatchOnce({ workerId: `app-${process.pid}` }).catch((err) => app.log.warn({ err }, "collaboration realtime dispatch failed")), 1000);
      realtimeTimer.unref?.();
    };
    // Local durable delivery must not depend on the optional cross-instance
    // LISTEN connection. A reconnecting listener only fan-outs best-effort
    // wake-up hints; the dispatcher continuously drains the outbox itself.
    startDispatcher();
    const listener = createRealtimeNotifyLifecycle({
      createClient: () => new pg.Client({ connectionString: config.databaseUrl }),
      onHint: ({ userId, cursor }) => gateway.notifySyncAvailable(userId, cursor),
    });
    try { await listener.start(); } catch (err) { app.log.warn({ err }, "collaboration realtime LISTEN failed; continuing local dispatcher while reconnecting"); }
    app.addHook("onClose", (_instance, done) => {
      if (realtimeTimer) clearInterval(realtimeTimer);
      listener.stop().catch(() => {});
      done();
    });
  }

  return app;
}

// Swagger + the four route plugins, in the order the OpenAPI doc and the app both
// need. Split out from buildApp() (which also seeds the DB at boot) so the API-doc
// test can enumerate every route without a live database.
export async function registerRoutes(app) {
  installDocOnlyCompilers(app);
  await registerOpenapi(app);
  await app.register(publicRoutes);
  await app.register(adminRoutes);
  await app.register(modelGatewayRoutes);
  await app.register(mediaGatewayRoutes);
  await app.register(asrGatewayRoutes);
}

// A logger-less app with only Swagger + routes wired (no CORS/cookie/multipart, no
// DB seeding) so tooling can read the generated OpenAPI via app.swagger() without a
// database. Used by the API-documentation coverage test.
export async function buildDocApp() {
  const app = Fastify({ logger: false });
  await registerRoutes(app);
  await app.ready();
  return app;
}
