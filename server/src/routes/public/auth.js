import crypto from "node:crypto";
import { z } from "zod";
import { zodBody, okResponse } from "../../openapi.js";
import { config } from "../../config.js";
import { db } from "../../db.js";
import { publicId } from "../../services/ids.js";
import { redeemInvitationsForPhone } from "../../services/enterprise-invitations.js";
import {
  createAccessToken,
  createRefreshToken,
  createWebSessionToken,
  evaluateSmsRisk,
  extendSessionExpiresAt,
  hashRefreshToken,
  hashSmsCode,
  normalizePhoneE164,
  verifySmsCodeHash,
  verifyWebSessionToken,
} from "../../services/account-auth.js";
import { sendLoginSms } from "../../services/sms-provider-aliyun.js";
import { clientFeatureEnabled } from "../../services/client-bootstrap.js";
import { smsRequestAllowedFromRegion } from "../../services/sms-region-policy.js";
import { ensureSignupGrants, fetchEntitlementSummary } from "../../services/wallet.js";
import { requireSignedDeviceRequest, upsertDevice, upsertDevicePublicKey } from "../../services/device-identity.js";
import { registerDeviceSchema } from "./devices.js";

const sendSmsSchema = z.object({
  phone: z.string().min(3).max(40),
  purpose: z.literal("login").default("login"),
  deviceId: z.string().min(6).max(120).optional().nullable(),
});

const loginSchema = registerDeviceSchema.extend({
  phone: z.string().min(3).max(40),
  code: z.string().regex(/^\d{6}$/),
});

const refreshSchema = registerDeviceSchema.extend({
  refreshToken: z.string().min(20).max(240),
});

const logoutSchema = z.object({
  refreshToken: z.string().min(20).max(240).optional(),
});

function clientIp(request) {
  return String(request.ip || request.headers["x-forwarded-for"] || "").split(",")[0].trim();
}

function randomSmsCode() {
  return String(crypto.randomInt(0, 1000000)).padStart(6, "0");
}

function accessScopes() {
  return ["account", "billing", "model_gateway", "media_gateway"];
}

async function recentSmsCount(where, since) {
  let query = db.selectFrom("sms_codes").select((eb) => eb.fn.count("id").as("count")).where("created_at", ">=", since);
  for (const [column, value] of Object.entries(where)) {
    if (value) query = query.where(column, "=", value);
  }
  const row = await query.executeTakeFirst();
  return Number(row?.count || 0);
}

async function recentSmsPrefixCount(phonePrefix, since) {
  const row = await db
    .selectFrom("sms_codes")
    .select((eb) => eb.fn.count("id").as("count"))
    .where("created_at", ">=", since)
    .where("phone_e164", "like", `${phonePrefix}%`)
    .executeTakeFirst();
  return Number(row?.count || 0);
}

async function findActiveSmsCode(phoneE164, purpose) {
  return db
    .selectFrom("sms_codes")
    .selectAll()
    .where("phone_e164", "=", phoneE164)
    .where("purpose", "=", purpose)
    .where("consumed_at", "is", null)
    .where("expires_at", ">", new Date())
    .orderBy("created_at", "desc")
    .executeTakeFirst();
}

async function createSession({ userId, deviceId, trx = db }) {
  const refreshToken = createRefreshToken();
  const sessionId = publicId("sess");
  await trx
    .insertInto("user_sessions")
    .values({
      id: sessionId,
      user_id: userId,
      device_id: deviceId,
      refresh_token_hash: hashRefreshToken(refreshToken),
      expires_at: extendSessionExpiresAt(),
    })
    .execute();
  return {
    sessionId,
    refreshToken,
    accessToken: createAccessToken({
      userId,
      sessionId,
      deviceId,
      scopes: accessScopes(),
    }),
    expiresIn: 15 * 60,
  };
}

export function registerPublicAuthRoutes(app) {
  app.post(
    "/api/auth/sms/send",
    {
      schema: {
        tags: ["public:auth"],
        summary: "Send a login SMS code",
        body: zodBody(sendSmsSchema),
        response: { 200: okResponse({ cooldownSeconds: { type: "number" }, reusedActiveCode: { type: "boolean" } }) },
      },
    },
    async (request, reply) => {
      const input = sendSmsSchema.parse(request.body);
      const phoneE164 = normalizePhoneE164(input.phone);
      const regionAllowed = smsRequestAllowedFromRegion(request, { phoneE164 });
      if (!regionAllowed.ok) {
        return reply.code(403).send({ ok: false, code: regionAllowed.code || "SMS_REGION_BLOCKED" });
      }
      if (regionAllowed.bypass !== "phone" && !clientFeatureEnabled(request, "accountLogin")) {
        return reply.code(403).send({ ok: false, code: "REGION_FEATURE_DISABLED" });
      }
      if (!phoneE164) return reply.code(400).send({ ok: false, code: "INVALID_PHONE" });

      const active = await findActiveSmsCode(phoneE164, input.purpose);
      const sinceHour = new Date(Date.now() - 60 * 60 * 1000);
      const phoneRecentCount = await recentSmsCount({ phone_e164: phoneE164 }, sinceHour);
      const ip = clientIp(request);
      const ipRecentCount = await recentSmsCount({ ip }, sinceHour);
      const deviceRecentCount = input.deviceId ? await recentSmsCount({ device_id: input.deviceId }, sinceHour) : 0;
      const prefixRecentCount = await recentSmsPrefixCount(phoneE164.slice(0, 6), sinceHour);
      const risk = evaluateSmsRisk({
        phoneRecentCount,
        ipRecentCount,
        deviceRecentCount,
        prefixRecentCount,
        hasActiveCode: Boolean(active),
      });

      if (risk.action === "cooldown") return reply.send({ ok: true, cooldownSeconds: 60, reusedActiveCode: true });
      if (risk.action === "captcha_required") return reply.code(403).send({ ok: false, code: "CAPTCHA_REQUIRED" });
      if (risk.action === "blocked") return reply.code(429).send({ ok: false, code: "SMS_RISK_BLOCKED" });

      const code = randomSmsCode();
      const id = publicId("sms");
      const sent = await sendLoginSms({ phoneE164, code, requestId: id });
      if (!sent.ok) return reply.code(503).send({ ok: false, code: sent.code || "SMS_PROVIDER_FAILED" });
      await db
        .insertInto("sms_codes")
        .values({
          id,
          phone_e164: phoneE164,
          code_hash: hashSmsCode(phoneE164, code),
          purpose: input.purpose,
          expires_at: new Date(Date.now() + 5 * 60 * 1000),
          ip,
          user_agent: request.headers["user-agent"] || null,
          device_id: input.deviceId || null,
          risk_level: risk.level,
          risk_reason: risk.reason || null,
          send_provider: "aliyun",
          send_status: sent.skipped ? "skipped" : "sent",
        })
        .execute();
      return reply.send({
        ok: true,
        cooldownSeconds: 60,
        ...(sent.skipped && process.env.NODE_ENV !== "production" ? { devCode: code } : {}),
      });
    },
  );

  app.post(
    "/api/auth/sms/login",
    {
      schema: {
        tags: ["public:auth"],
        summary: "Login or create an account with an SMS code",
        body: zodBody(loginSchema),
        response: { 200: okResponse({ accessToken: { type: "string" }, refreshToken: { type: "string" } }) },
      },
    },
    async (request, reply) => {
      const input = loginSchema.parse(request.body);
      const phoneE164 = normalizePhoneE164(input.phone);
      if (!phoneE164) return reply.code(400).send({ ok: false, code: "INVALID_PHONE" });
      const regionAllowed = smsRequestAllowedFromRegion(request, { phoneE164 });
      if (regionAllowed.bypass !== "phone" && !clientFeatureEnabled(request, "accountLogin")) {
        return reply.code(403).send({ ok: false, code: "REGION_FEATURE_DISABLED" });
      }
      await upsertDevice(input);
      await upsertDevicePublicKey(input);

      const sms = await findActiveSmsCode(phoneE164, "login");
      if (!sms) return reply.code(401).send({ ok: false, code: "INVALID_SMS_CODE" });
      if (Number(sms.attempt_count || 0) >= 5) return reply.code(429).send({ ok: false, code: "SMS_CODE_LOCKED" });
      if (!verifySmsCodeHash(phoneE164, input.code, sms.code_hash)) {
        await db.updateTable("sms_codes").set({ attempt_count: Number(sms.attempt_count || 0) + 1 }).where("id", "=", sms.id).execute();
        return reply.code(401).send({ ok: false, code: "INVALID_SMS_CODE" });
      }

      const result = await db.transaction().execute(async (trx) => {
        await trx.updateTable("sms_codes").set({ consumed_at: new Date() }).where("id", "=", sms.id).execute();
        let user = await trx.selectFrom("users").selectAll().where("phone_e164", "=", phoneE164).executeTakeFirst();
        if (!user) {
          const userId = publicId("usr");
          await trx.insertInto("users").values({ id: userId, phone_e164: phoneE164, last_login_at: new Date() }).execute();
          user = { id: userId, phone_e164: phoneE164, status: "active" };
          await ensureSignupGrants(userId, trx);
        } else {
          await trx.updateTable("users").set({ last_login_at: new Date() }).where("id", "=", user.id).execute();
        }
        if (user.status !== "active") return { disabled: true };
        await trx
          .insertInto("user_devices")
          .values({ user_id: user.id, device_id: input.deviceId })
          .onConflict((oc) => oc.columns(["user_id", "device_id"]).doUpdateSet({ last_seen_at: new Date(), status: "active" }))
          .execute();
        const session = await createSession({ userId: user.id, deviceId: input.deviceId, trx });
        return { user, session };
      });
      if (result.disabled) return reply.code(403).send({ ok: false, code: "USER_DISABLED" });
      // Grant any enterprise seats waiting for this phone. Deliberately AFTER
      // the login transaction commits and in its own try: a login must never
      // fail because a seat could not be granted, and an invitation left
      // pending is simply retried at the next login.
      try {
        await redeemInvitationsForPhone(db, { userId: result.user.id, phoneE164 });
      } catch (invitationError) {
        request.log?.warn?.({ err: invitationError }, "enterprise invitation redemption failed");
      }
      const entitlements = await fetchEntitlementSummary(result.user.id);
      return reply.send({
        ok: true,
        ...result.session,
        webSessionToken: createWebSessionToken({
          userId: result.user.id,
          sessionId: result.session.sessionId,
        }),
        user: {
          id: result.user.id,
          phoneMasked: `${phoneE164.slice(3, 6)}****${phoneE164.slice(-4)}`,
        },
        entitlements,
      });
    },
  );

  app.post(
    "/api/auth/session/refresh",
    {
      schema: {
        tags: ["public:auth"],
        summary: "Refresh a user access token",
        body: zodBody(refreshSchema),
        response: { 200: okResponse({ accessToken: { type: "string" } }) },
      },
    },
    async (request, reply) => {
      const input = refreshSchema.parse(request.body);
      await upsertDevice(input);
      await upsertDevicePublicKey(input);
      if (!(await requireSignedDeviceRequest(request, reply, input))) return;
      const session = await db
        .selectFrom("user_sessions")
        .selectAll()
        .where("refresh_token_hash", "=", hashRefreshToken(input.refreshToken))
        .executeTakeFirst();
      if (!session || session.revoked_at || new Date(session.expires_at).getTime() <= Date.now()) {
        return reply.code(401).send({ ok: false, code: "SESSION_EXPIRED" });
      }
      if (session.device_id !== input.deviceId) return reply.code(403).send({ ok: false, code: "DEVICE_MISMATCH" });
      await db
        .updateTable("user_sessions")
        .set({
          last_seen_at: new Date(),
          expires_at: extendSessionExpiresAt(session.expires_at),
        })
        .where("id", "=", session.id)
        .execute();
      return reply.send({
        ok: true,
        accessToken: createAccessToken({
          userId: session.user_id,
          sessionId: session.id,
          deviceId: session.device_id,
          scopes: accessScopes(),
        }),
        expiresIn: 15 * 60,
      });
    },
  );

  app.post(
    "/api/auth/session/logout",
    {
      schema: {
        tags: ["public:auth"],
        summary: "Logout the current user session",
        body: zodBody(logoutSchema),
        response: { 200: okResponse() },
      },
    },
    async (request) => {
      const input = logoutSchema.parse(request.body || {});
      if (input.refreshToken) {
        await db
          .updateTable("user_sessions")
          .set({ revoked_at: new Date(), revoked_reason: "logout" })
          .where("refresh_token_hash", "=", hashRefreshToken(input.refreshToken))
          .execute();
      } else {
        const webSession = request.cookies?.lily_user_session || "";
        const verified = verifyWebSessionToken(webSession);
        if (verified.ok) {
          await db
            .updateTable("user_sessions")
            .set({ revoked_at: new Date(), revoked_reason: "web_logout" })
            .where("id", "=", verified.sessionId)
            .where("user_id", "=", verified.userId)
            .execute();
        }
      }
      return { ok: true };
    },
  );
}
