import { z } from "zod";
import { zodBody, okResponse } from "../../openapi.js";
import { db } from "../../db.js";
import {
  requireSignedDeviceRequest,
  upsertDevice,
  validLicenseScope,
} from "../../services/device-identity.js";
import { requireAccountSession } from "../../services/account-session-guard.js";
import { createGrantToken, verifyGrantToken } from "../../services/mobile-grant-token.js";
import { createDirectCode, consumeDirectCode } from "../../services/mobile-direct-connect.js";
import { signModelGatewayToken } from "../../services/model-gateway/auth.js";
import {
  createPairingChallenge,
  consumePairingChallenge,
  approvePairingGrant,
  denyPairingGrant,
  revokePairingGrant,
  listPendingGrants,
  listGrantsForDesktop,
} from "../../services/mobile-pairing.js";
import {
  DISABLED_CAPABILITIES,
  disabledCapability,
} from "../../services/mobile-command-capabilities.js";
import { registerMobileCommandSurfaceRoutes } from "./mobile-command-surface.js";

// Mobile Command Phase 1 pairing routes. Thin HTTP layer over the pure pairing
// decisions in services/mobile-pairing.js: it authenticates (device signature
// + account session), supplies real Kysely queries, and maps result codes to
// HTTP status. The security decisions are unit-tested; end-to-end DB integration
// is covered in Phase 1-6.

const deviceBase = {
  deviceId: z.string().min(6).max(120),
  fingerprintHash: z.string().max(160).optional().nullable(),
  platform: z.string().max(40).optional().nullable(),
  appVersion: z.string().max(40).optional().nullable(),
};
const challengeSchema = z.object({ ...deviceBase });
const consumeSchema = z.object({ ...deviceBase, token: z.string().min(10).max(400) });
const grantDecisionSchema = z.object({ ...deviceBase, grantId: z.string().min(6).max(120) });
const revokeSchema = z.object({ ...deviceBase, grantId: z.string().min(6).max(120), reason: z.string().max(40).optional() });
const directCreateSchema = z.object({ ...deviceBase });
const directConsumeSchema = z.object({ ...deviceBase, code: z.string().min(4).max(40), password: z.string().min(3).max(40) });
const asrTokenSchema = z.object({ ...deviceBase, grantId: z.string().min(6).max(120), token: z.string().min(10).max(400) });

export function registerPublicMobileRoutes(app) {
  // Both guards: the device signature proves key possession, the account token
  // proves the logged-in user — pairing needs both (a device key is not a user).
  // upsertDevice first so a first-contact device has a row to sign for.
  async function bothGuards(request, reply, input) {
    await upsertDevice(input);
    if (!(await requireSignedDeviceRequest(request, reply, input))) return null;
    return requireAccountSession(request, reply, input);
  }

  // Mobile-side consume: NO login at all (desktop-vouched model). The phone is a
  // web page that can't hold a native key and — abroad — can't receive an SMS
  // code. It presents only a browser device id. Security rests on: the 256-bit
  // one-time QR token (proximity/possession), the desktop user's explicit
  // approval (human gate), and a grant-scoped token whose only power is to relay
  // for that one approved grant. Desktop-side endpoints (challenge/approve/deny/
  // pending) keep bothGuards (the desktop IS authenticated and vouches).
  async function deviceOnly(request, reply, input) {
    await upsertDevice(input);
    return true;
  }

  app.post(
    "/api/mobile/pairing/challenge",
    {
      schema: {
        tags: ["public:mobile"],
        summary: "Desktop issues a pairing challenge (QR token)",
        body: zodBody(challengeSchema),
        response: { 200: okResponse({ challengeId: { type: "string" }, token: { type: "string" }, expiresAt: { type: "string" } }) },
      },
    },
    async (request, reply) => {
      const input = challengeSchema.parse(request.body);
      const account = await bothGuards(request, reply, input);
      if (!account) return;
      const result = await createPairingChallenge({
        userId: account.userId,
        accountSessionId: account.sessionId,
        desktopDeviceId: account.deviceId,
        insertChallenge: (row) => db.insertInto("mobile_pairing_challenges").values(row).execute(),
      });
      if (!result.ok) return reply.code(400).send({ ok: false, code: result.code });
      return reply.send({ ok: true, challengeId: result.challengeId, token: result.token, expiresAt: result.expiresAt });
    },
  );

  app.post(
    "/api/mobile/pairing/consume",
    {
      schema: {
        tags: ["public:mobile"],
        summary: "Mobile consumes a challenge and requests pairing approval",
        body: zodBody(consumeSchema),
        response: { 200: okResponse({ grantId: { type: "string" }, mobileToken: { type: "string" }, desktopDeviceId: { type: "string" }, approvalExpiresAt: { type: "string" } }) },
      },
    },
    async (request, reply) => {
      const input = consumeSchema.parse(request.body);
      // Desktop-vouched: only register the phone's device row; no login.
      if (!(await deviceOnly(request, reply, input))) return;
      const result = await consumePairingChallenge({
        token: input.token,
        mobileDeviceId: input.deviceId,
        casConsumeChallenge: (tokenHash, now) => db.transaction().execute((trx) => trx
          .updateTable("mobile_pairing_challenges")
          .set({ status: "consumed", consumed_at: now.toISOString() })
          .where("token_hash", "=", tokenHash)
          .where("status", "=", "pending")
          .where("expires_at", ">", now.toISOString())
          .returningAll()
          .executeTakeFirst()),
        resolveDesktopLicense: async (deviceId) => (await validLicenseScope({ deviceId })) || null,
        supersedeLivePairs: ({ desktopDeviceId, mobileDeviceId, now }) => db
          .updateTable("mobile_pairing_grants")
          .set({ status: "revoked", terminal_at: now.toISOString(), revoked_reason: "superseded" })
          .where("desktop_device_id", "=", desktopDeviceId)
          .where("mobile_device_id", "=", mobileDeviceId)
          .where("status", "in", ["pending_approval", "active"])
          .execute(),
        insertGrant: (row) => db.insertInto("mobile_pairing_grants").values(row).execute(),
        issueGrantToken: ({ grantId, mobileDeviceId }) => createGrantToken({ grantId, mobileDeviceId }),
      });
      if (!result.ok) return reply.code(409).send({ ok: false, code: result.code });
      return reply.send({ ok: true, grantId: result.grantId, mobileToken: result.mobileToken, desktopDeviceId: result.desktopDeviceId, approvalExpiresAt: result.approvalExpiresAt });
    },
  );

  app.post(
    "/api/mobile/pairing/approve",
    { schema: { tags: ["public:mobile"], summary: "Desktop approves a pending pairing", body: zodBody(grantDecisionSchema), response: { 200: okResponse({ grantId: { type: "string" }, status: { type: "string" } }) } } },
    async (request, reply) => {
      const input = grantDecisionSchema.parse(request.body);
      const account = await bothGuards(request, reply, input);
      if (!account) return;
      const result = await approvePairingGrant({
        grantId: input.grantId,
        desktopDeviceId: account.deviceId,
        casApproveGrant: async ({ grantId, desktopDeviceId, now }) => {
          const rows = await db.updateTable("mobile_pairing_grants")
            .set({ status: "active", approved_at: now.toISOString() })
            .where("id", "=", grantId)
            .where("desktop_device_id", "=", desktopDeviceId)
            .where("status", "=", "pending_approval")
            .where("approval_expires_at", ">", now.toISOString())
            .executeTakeFirst();
          return Number(rows?.numUpdatedRows || 0);
        },
      });
      if (!result.ok) return reply.code(409).send({ ok: false, code: result.code });
      return reply.send({ ok: true, grantId: result.grantId, status: result.status });
    },
  );

  app.post(
    "/api/mobile/pairing/deny",
    { schema: { tags: ["public:mobile"], summary: "Desktop denies a pending pairing", body: zodBody(grantDecisionSchema), response: { 200: okResponse({ grantId: { type: "string" }, status: { type: "string" } }) } } },
    async (request, reply) => {
      const input = grantDecisionSchema.parse(request.body);
      const account = await bothGuards(request, reply, input);
      if (!account) return;
      const result = await denyPairingGrant({
        grantId: input.grantId,
        desktopDeviceId: account.deviceId,
        casDenyGrant: async ({ grantId, desktopDeviceId, now }) => {
          const rows = await db.updateTable("mobile_pairing_grants")
            .set({ status: "denied", terminal_at: now.toISOString() })
            .where("id", "=", grantId)
            .where("desktop_device_id", "=", desktopDeviceId)
            .where("status", "=", "pending_approval")
            .executeTakeFirst();
          return Number(rows?.numUpdatedRows || 0);
        },
      });
      if (!result.ok) return reply.code(409).send({ ok: false, code: result.code });
      return reply.send({ ok: true, grantId: result.grantId, status: result.status });
    },
  );

  app.post(
    "/api/mobile/pairing/revoke",
    { schema: { tags: ["public:mobile"], summary: "Revoke a pairing grant", body: zodBody(revokeSchema), response: { 200: okResponse({ grantId: { type: "string" }, status: { type: "string" } }) } } },
    async (request, reply) => {
      const input = revokeSchema.parse(request.body);
      const account = await bothGuards(request, reply, input);
      if (!account) return;
      const result = await revokePairingGrant({
        grantId: input.grantId,
        userId: account.userId,
        reason: input.reason,
        casRevokeGrant: async ({ grantId, userId, reason, now }) => {
          const rows = await db.updateTable("mobile_pairing_grants")
            .set({ status: "revoked", terminal_at: now.toISOString(), revoked_reason: reason })
            .where("id", "=", grantId)
            .where("user_id", "=", userId)
            .where("status", "in", ["pending_approval", "active"])
            .executeTakeFirst();
          return Number(rows?.numUpdatedRows || 0);
        },
      });
      if (!result.ok) return reply.code(409).send({ ok: false, code: result.code });
      return reply.send({ ok: true, grantId: result.grantId, status: result.status });
    },
  );

  app.post(
    "/api/mobile/pairing/pending",
    { schema: { tags: ["public:mobile"], summary: "Desktop lists its pending pairing requests", body: zodBody(challengeSchema), response: { 200: okResponse({ grants: { type: "array", items: { type: "object" } } }) } } },
    async (request, reply) => {
      const input = challengeSchema.parse(request.body);
      const account = await bothGuards(request, reply, input);
      if (!account) return;
      const result = await listPendingGrants({
        desktopDeviceId: account.deviceId,
        listPending: (desktopDeviceId, nowIso) => db
          .selectFrom("mobile_pairing_grants")
          .selectAll()
          .where("desktop_device_id", "=", desktopDeviceId)
          .where("status", "=", "pending_approval")
          .where("approval_expires_at", ">", nowIso)
          .orderBy("created_at", "asc")
          .execute(),
      });
      if (!result.ok) return reply.code(400).send({ ok: false, code: result.code });
      return reply.send({ ok: true, grants: result.grants });
    },
  );

  app.post(
    "/api/mobile/pairing/list",
    { schema: { tags: ["public:mobile"], summary: "Desktop lists its live pairings (pending + active)", body: zodBody(challengeSchema), response: { 200: okResponse({ grants: { type: "array", items: { type: "object" } } }) } } },
    async (request, reply) => {
      const input = challengeSchema.parse(request.body);
      const account = await bothGuards(request, reply, input);
      if (!account) return;
      const result = await listGrantsForDesktop({
        desktopDeviceId: account.deviceId,
        listGrants: (desktopDeviceId, nowIso) => db
          .selectFrom("mobile_pairing_grants")
          .selectAll()
          .where("desktop_device_id", "=", desktopDeviceId)
          .where("status", "in", ["pending_approval", "active"])
          // active pairings never expire; only drop stale pendings.
          .where((eb) => eb.or([eb("status", "=", "active"), eb("approval_expires_at", ">", nowIso)]))
          .orderBy("created_at", "desc")
          .execute(),
      });
      if (!result.ok) return reply.code(400).send({ ok: false, code: result.code });
      return reply.send({ ok: true, grants: result.grants });
    },
  );
  // --- Direct-connect codes (TeamViewer/ToDesk-style): short code + password,
  // no approval. Opt-in; QR + approval stays the default. ---
  app.post(
    "/api/mobile/direct/create",
    { schema: { tags: ["public:mobile"], summary: "Desktop generates a direct-connect code + password", body: zodBody(directCreateSchema), response: { 200: okResponse({ codeId: { type: "string" }, code: { type: "string" }, password: { type: "string" }, expiresAt: { type: "string" } }) } } },
    async (request, reply) => {
      const input = directCreateSchema.parse(request.body);
      const account = await bothGuards(request, reply, input);
      if (!account) return;
      const result = await createDirectCode({
        userId: account.userId,
        accountSessionId: account.sessionId,
        desktopDeviceId: account.deviceId,
        revokePriorActive: ({ desktopDeviceId }) => db
          .updateTable("mobile_direct_codes")
          .set({ status: "revoked" })
          .where("desktop_device_id", "=", desktopDeviceId)
          .where("status", "=", "active")
          .execute(),
        insertCode: (row) => db.insertInto("mobile_direct_codes").values(row).execute(),
      });
      if (!result.ok) return reply.code(400).send({ ok: false, code: result.code });
      return reply.send({ ok: true, codeId: result.codeId, code: result.code, password: result.password, expiresAt: result.expiresAt });
    },
  );

  app.post(
    "/api/mobile/direct/consume",
    { schema: { tags: ["public:mobile"], summary: "Phone connects directly via code + password (no approval)", body: zodBody(directConsumeSchema), response: { 200: okResponse({ grantId: { type: "string" }, mobileToken: { type: "string" }, desktopDeviceId: { type: "string" } }) } } },
    async (request, reply) => {
      const input = directConsumeSchema.parse(request.body);
      if (!(await deviceOnly(request, reply, input))) return;
      const result = await consumeDirectCode({
        code: input.code,
        password: input.password,
        mobileDeviceId: input.deviceId,
        findActiveCodeByHash: (codeHash, nowIso) => db
          .selectFrom("mobile_direct_codes")
          .selectAll()
          .where("code_hash", "=", codeHash)
          .where("status", "=", "active")
          .where("expires_at", ">", nowIso)
          .executeTakeFirst(),
        registerFailedAttempt: ({ id, attemptCount, lockedUntil }) => db
          .updateTable("mobile_direct_codes")
          .set({ attempt_count: attemptCount, locked_until: lockedUntil })
          .where("id", "=", id)
          .execute(),
        resetAttempts: ({ id }) => db
          .updateTable("mobile_direct_codes")
          .set({ attempt_count: 0, locked_until: null })
          .where("id", "=", id)
          .execute(),
        resolveDesktopLicense: async (deviceId) => (await validLicenseScope({ deviceId })) || null,
        supersedeLivePairs: ({ desktopDeviceId, mobileDeviceId, now }) => db
          .updateTable("mobile_pairing_grants")
          .set({ status: "revoked", terminal_at: now.toISOString(), revoked_reason: "superseded" })
          .where("desktop_device_id", "=", desktopDeviceId)
          .where("mobile_device_id", "=", mobileDeviceId)
          .where("status", "in", ["pending_approval", "active"])
          .execute(),
        insertGrant: (row) => db.insertInto("mobile_pairing_grants").values(row).execute(),
        issueGrantToken: ({ grantId, mobileDeviceId }) => createGrantToken({ grantId, mobileDeviceId }),
      });
      if (!result.ok) return reply.code(409).send({ ok: false, code: result.code });
      return reply.send({ ok: true, grantId: result.grantId, mobileToken: result.mobileToken, desktopDeviceId: result.desktopDeviceId });
    },
  );

  // Mobile ASR token: a paired phone (grant token) exchanges it for a short
  // "vision"-scoped model-gateway token so it can use the server ASR relay
  // (/llm/asr/*) for dictation. Scoped to the desktop's license + the vision
  // provider only — strictly less power than the command control the phone
  // already holds.
  app.post(
    "/api/mobile/asr/token",
    { schema: { tags: ["public:mobile"], summary: "Paired phone gets a vision-scoped token for server ASR", body: zodBody(asrTokenSchema), response: { 200: okResponse({ asrToken: { type: "string" } }) } } },
    async (request, reply) => {
      const input = asrTokenSchema.parse(request.body);
      if (!(await deviceOnly(request, reply, input))) return;
      const v = verifyGrantToken(input.token);
      if (!v.ok) return reply.code(401).send({ ok: false, code: v.code || "GRANT_TOKEN_INVALID" });
      if (v.grantId !== input.grantId || v.mobileDeviceId !== input.deviceId) {
        return reply.code(403).send({ ok: false, code: "GRANT_MISMATCH" });
      }
      const grant = await db.selectFrom("mobile_pairing_grants").selectAll()
        .where("id", "=", input.grantId).where("status", "=", "active").executeTakeFirst();
      if (!grant) return reply.code(409).send({ ok: false, code: "GRANT_INACTIVE" });
      if (grant.mobile_device_id !== input.deviceId) return reply.code(403).send({ ok: false, code: "DEVICE_MISMATCH" });
      const asrToken = signModelGatewayToken({
        deviceId: input.deviceId,
        licenseId: grant.license_id,
        providerId: "vision",
        userId: grant.user_id,
      });
      return reply.send({ ok: true, asrToken });
    },
  );

  registerMobileCommandSurfaceRoutes(app);
}

export { DISABLED_CAPABILITIES, disabledCapability };
