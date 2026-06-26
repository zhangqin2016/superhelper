import Fastify from "fastify";
import cors from "@fastify/cors";
import cookie from "@fastify/cookie";
import multipart from "@fastify/multipart";
import { config } from "./config.js";
import { publicRoutes } from "./routes/public.js";
import { adminRoutes } from "./routes/admin.js";
import { modelGatewayRoutes } from "./services/model-gateway.js";
import { mediaGatewayRoutes } from "./services/media-gateway.js";
import { ensureEnvManagedConfigProfile } from "./services/client-config.js";
import { refreshModelCatalog } from "./services/model-catalog.js";
import { ensureEnvQiniuConfigSeeded } from "./services/app-settings.js";
import { installDocOnlyCompilers, registerOpenapi } from "./openapi.js";

const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 120;
const ADMIN_UPLOAD_LIMIT_BYTES = 100 * 1024 * 1024;
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
