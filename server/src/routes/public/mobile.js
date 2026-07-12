import { z } from "zod";
import { zodBody, okResponse } from "../../openapi.js";
import { db } from "../../db.js";
import {
  requireSignedDeviceRequest,
  upsertDevice,
  validLicenseScope,
} from "../../services/device-identity.js";
import { requireAccountSession } from "../../services/account-session-guard.js";
import {
  createPairingChallenge,
  consumePairingChallenge,
  approvePairingGrant,
  denyPairingGrant,
  revokePairingGrant,
  listPendingGrants,
} from "../../services/mobile-pairing.js";

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

export function registerPublicMobileRoutes(app) {
  // Both guards: the device signature proves key possession, the account token
  // proves the logged-in user — pairing needs both (a device key is not a user).
  // upsertDevice first so a first-contact device has a row to sign for.
  async function bothGuards(request, reply, input) {
    await upsertDevice(input);
    if (!(await requireSignedDeviceRequest(request, reply, input))) return null;
    return requireAccountSession(request, reply, input);
  }

  // Mobile-side (Phase 1): account token only, no per-request device signature.
  // The mobile client is a WEB page that cannot hold a native ed25519 device
  // key. Pairing security here rests on three controls: the 256-bit one-time QR
  // token (proximity/possession), the SAME-account session (consume requires
  // challenge.user_id === caller), and explicit desktop approval (human gate).
  // Per-request device signature is defense-in-depth deferred to a native shell.
  // Desktop-side endpoints (challenge/approve/deny/pending) keep bothGuards.
  async function accountGuard(request, reply, input) {
    await upsertDevice(input);
    return requireAccountSession(request, reply, input);
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
        response: { 200: okResponse({ grantId: { type: "string" }, desktopDeviceId: { type: "string" }, approvalExpiresAt: { type: "string" } }) },
      },
    },
    async (request, reply) => {
      const input = consumeSchema.parse(request.body);
      // Mobile web client: account-token auth (see accountGuard rationale).
      const account = await accountGuard(request, reply, input);
      if (!account) return;
      const result = await consumePairingChallenge({
        token: input.token,
        mobileUserId: account.userId,
        mobileSessionId: account.sessionId,
        mobileDeviceId: account.deviceId,
        casConsumeChallenge: (tokenHash, now) => db.transaction().execute((trx) => trx
          .updateTable("mobile_pairing_challenges")
          .set({ status: "consumed", consumed_at: now.toISOString() })
          .where("token_hash", "=", tokenHash)
          .where("status", "=", "pending")
          .where("expires_at", ">", now.toISOString())
          .returningAll()
          .executeTakeFirst()),
        resolveDesktopLicense: async (deviceId) => (await validLicenseScope({ deviceId })) || null,
        insertGrant: (row) => db.insertInto("mobile_pairing_grants").values(row).execute(),
      });
      if (!result.ok) return reply.code(409).send({ ok: false, code: result.code });
      return reply.send({ ok: true, grantId: result.grantId, desktopDeviceId: result.desktopDeviceId, approvalExpiresAt: result.approvalExpiresAt });
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
}
