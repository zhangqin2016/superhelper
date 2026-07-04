import crypto from "node:crypto";
import { z } from "zod";
import { zodBody, okResponse } from "../../openapi.js";
import { config } from "../../config.js";
import { db } from "../../db.js";
import { publicId } from "../../services/ids.js";
import { hashRefreshToken, verifyAccessToken, verifyWebSessionToken } from "../../services/account-auth.js";
import { consumeBillingLinkToken } from "../../services/billing-link-token.js";
import { fetchEntitlementSummary } from "../../services/wallet.js";
import { clientFeatureEnabled } from "../../services/client-bootstrap.js";
import { requireSignedDeviceRequest, upsertDevice, upsertDevicePublicKey } from "../../services/device-identity.js";
import { registerDeviceSchema } from "./devices.js";

const accountRequestSchema = registerDeviceSchema;
const consumeBillingLinkSchema = z.object({
  token: z.string().min(1),
});

function bearerToken(request) {
  const header = String(request.headers.authorization || "");
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : "";
}

async function requireAccount(request, reply, input) {
  const token = bearerToken(request);
  const verified = verifyAccessToken(token);
  if (!verified.ok) {
    reply.code(401).send({ ok: false, code: verified.code || "ACCESS_TOKEN_INVALID" });
    return null;
  }
  if (verified.deviceId !== input.deviceId) {
    reply.code(403).send({ ok: false, code: "DEVICE_MISMATCH" });
    return null;
  }
  const session = await db
    .selectFrom("user_sessions")
    .selectAll()
    .where("id", "=", verified.sessionId)
    .executeTakeFirst();
  if (!session || session.revoked_at || new Date(session.expires_at).getTime() <= Date.now()) {
    reply.code(401).send({ ok: false, code: "SESSION_EXPIRED" });
    return null;
  }
  if (session.user_id !== verified.userId || session.device_id !== verified.deviceId) {
    reply.code(403).send({ ok: false, code: "SESSION_MISMATCH" });
    return null;
  }
  return {
    userId: verified.userId,
    sessionId: verified.sessionId,
    deviceId: verified.deviceId,
  };
}

async function requireWebAccount(request, reply) {
  const sessionToken = request.cookies?.lily_user_session || "";
  const verified = verifyWebSessionToken(sessionToken);
  if (!verified.ok) {
    reply.code(401).send({ ok: false, code: verified.code || "USER_LOGIN_REQUIRED" });
    return null;
  }
  const session = await db
    .selectFrom("user_sessions")
    .selectAll()
    .where("id", "=", verified.sessionId)
    .executeTakeFirst();
  if (!session || session.user_id !== verified.userId || session.revoked_at || new Date(session.expires_at).getTime() <= Date.now()) {
    reply.code(401).send({ ok: false, code: "USER_LOGIN_REQUIRED" });
    return null;
  }
  return { userId: verified.userId, sessionId: verified.sessionId };
}

function createBillingLinkToken() {
  return `one_time_${crypto.randomBytes(32).toString("base64url")}`;
}

export function registerPublicAccountRoutes(app) {
  app.get(
    "/api/account/entitlements",
    {
      schema: {
        tags: ["public:account"],
        summary: "Get current web account entitlements",
        response: { 200: okResponse({ entitlements: { type: "object" } }) },
      },
    },
    async (request, reply) => {
      const account = await requireWebAccount(request, reply);
      if (!account) return;
      const entitlements = await fetchEntitlementSummary(account.userId);
      return reply.send({ ok: true, entitlements });
    },
  );

  app.post(
    "/api/account/entitlements",
    {
      schema: {
        tags: ["public:account"],
        summary: "Get current account entitlements",
        body: zodBody(accountRequestSchema),
        response: { 200: okResponse({ entitlements: { type: "object" } }) },
      },
    },
    async (request, reply) => {
      if (!clientFeatureEnabled(request, "purchase")) {
        return reply.code(403).send({ ok: false, code: "REGION_FEATURE_DISABLED" });
      }
      const input = accountRequestSchema.parse(request.body);
      await upsertDevice(input);
      await upsertDevicePublicKey(input);
      if (!(await requireSignedDeviceRequest(request, reply, input))) return;
      const account = await requireAccount(request, reply, input);
      if (!account) return;
      const entitlements = await fetchEntitlementSummary(account.userId);
      return reply.send({ ok: true, entitlements });
    },
  );

  app.post(
    "/api/account/billing-link",
    {
      schema: {
        tags: ["public:account"],
        summary: "Create a one-time website billing link",
        body: zodBody(accountRequestSchema),
        response: { 200: okResponse({ url: { type: "string" }, expiresIn: { type: "number" } }) },
      },
    },
    async (request, reply) => {
      const input = accountRequestSchema.parse(request.body);
      await upsertDevice(input);
      await upsertDevicePublicKey(input);
      if (!(await requireSignedDeviceRequest(request, reply, input))) return;
      const account = await requireAccount(request, reply, input);
      if (!account) return;
      const token = createBillingLinkToken();
      const id = publicId("blink");
      const expiresAt = new Date(Date.now() + 5 * 60 * 1000);
      await db
        .insertInto("billing_link_tokens")
        .values({
          id,
          user_id: account.userId,
          session_id: account.sessionId,
          device_id: account.deviceId,
          token_hash: hashRefreshToken(token),
          expires_at: expiresAt,
        })
        .execute();
      const base = String(config.webBaseUrl || "https://www.lilywb.cn").replace(/\/+$/, "");
      return reply.send({
        ok: true,
        url: `${base}/account/billing?token=${encodeURIComponent(token)}`,
        expiresIn: 300,
      });
    },
  );

  app.post(
    "/api/account/billing-link/consume",
    {
      schema: {
        tags: ["public:account"],
        summary: "Consume a one-time website billing link",
        body: zodBody(consumeBillingLinkSchema),
        response: { 200: okResponse({ webSessionToken: { type: "string" }, expiresIn: { type: "number" } }) },
      },
    },
    async (request, reply) => {
      const input = consumeBillingLinkSchema.parse(request.body);
      const result = await consumeBillingLinkToken({
        token: input.token,
        lookupToken: async (tokenHash) => db
          .selectFrom("billing_link_tokens")
          .innerJoin("user_sessions", "user_sessions.id", "billing_link_tokens.session_id")
          .select([
            "billing_link_tokens.id",
            "billing_link_tokens.user_id",
            "billing_link_tokens.session_id",
            "billing_link_tokens.device_id",
            "billing_link_tokens.token_hash",
            "billing_link_tokens.expires_at",
            "billing_link_tokens.consumed_at",
            "user_sessions.revoked_at as session_revoked_at",
            "user_sessions.expires_at as session_expires_at",
          ])
          .where("billing_link_tokens.token_hash", "=", tokenHash)
          .executeTakeFirst(),
        markConsumed: async (id, consumedAt) => {
          const rows = await db
            .updateTable("billing_link_tokens")
            .set({ consumed_at: consumedAt })
            .where("id", "=", id)
            .where("consumed_at", "is", null)
            .execute();
          return Number(rows?.[0]?.numUpdatedRows || 0) === 1;
        },
      });
      if (!result.ok) {
        const gone = result.code === "BILLING_LINK_EXPIRED" || result.code === "BILLING_LINK_CONSUMED";
        return reply.code(gone ? 410 : 401).send({ ok: false, code: result.code });
      }
      return reply.send({
        ok: true,
        webSessionToken: result.webSessionToken,
        expiresIn: 7 * 24 * 60 * 60,
      });
    },
  );
}
