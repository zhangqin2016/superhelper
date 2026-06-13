import Fastify from "fastify";
import cors from "@fastify/cors";
import cookie from "@fastify/cookie";
import { config } from "./config.js";
import { publicRoutes } from "./routes/public.js";
import { adminRoutes } from "./routes/admin.js";
import { modelGatewayRoutes } from "./services/model-gateway.js";
import { mediaGatewayRoutes } from "./services/media-gateway.js";
import { ensureEnvManagedConfigProfile } from "./services/client-config.js";

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
  const app = Fastify({
    logger: true,
    // Vision requests carry base64 images; default 1MB is too small.
    bodyLimit: 26214400,
  });

  await app.register(cors, {
    origin: true,
    credentials: true,
  });
  await app.register(cookie, {
    secret: config.sessionSecret,
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

  await ensureEnvManagedConfigProfile();
  await app.register(publicRoutes);
  await app.register(adminRoutes);
  await app.register(modelGatewayRoutes);
  await app.register(mediaGatewayRoutes);

  return app;
}
