import { z } from "zod";
import { db } from "../../db.js";
import { publicId } from "../../services/ids.js";
import { zodBody, okResponse } from "../../openapi.js";
import { artifactErrorResponse, checkReleaseArtifact } from "../../services/release-artifact-check.js";
import { listPage, pageQuerySchema, pageResponseSchema } from "../../services/admin-pagination.js";
import { latestReleases } from "../../services/release-versions.js";
import { DEFAULT_CHANNEL } from "../../services/release-offer.js";
import { transitionRollout } from "../../services/release-rollouts.js";
import { normalizeSupport } from "../../services/release-support.js";
import { writeReleaseSupport } from "./rollouts.js";

const createReleaseSchema = z.object({
  version: z.string().min(1).max(40),
  platform: z.string().min(1).max(40),
  url: z.string().url(),
  sha256: z.string().min(16).max(160),
  sizeBytes: z.number().int().min(0).optional().nullable(),
  notes: z.string().max(5000).optional().nullable(),
  forceUpdate: z.boolean().default(false),
  enabled: z.boolean().default(true),
  // Published with its own auto-update feed (auto-updates/<platform>/releases/<version>/),
  // which is what lets a partial rollout point a device at exactly this version.
  immutableFeed: z.boolean().default(false),
  // Staged from the first instant: the release and its rollout are written in
  // one transaction, so there is no moment where a staged release has no
  // rollout row and is therefore offered to everyone.
  rolloutPercent: z.number().int().min(1).max(100).optional(),
  draft: z.boolean().optional(),
  channel: z.enum(["stable", "beta"]).optional(),
});

// A release can be switched on/off, and marked mandatory after the fact: an
// operator usually learns a version must go only once it is already out.
const updateReleaseSchema = z.object({
  enabled: z.boolean().optional(),
  forceUpdate: z.boolean().optional(),
}).refine((value) => value.enabled !== undefined || value.forceUpdate !== undefined, { message: "enabled or forceUpdate is required" });

export function registerAdminReleaseRoutes(app, { audit }) {
  app.get(
    "/api/admin/releases",
    {
      schema: {
        tags: ["admin:releases"],
        summary: "List app releases",
        description: "Returns the most recent app releases ordered by creation time, plus the version each platform is currently offered (newest enabled).",
        querystring: zodBody(pageQuerySchema),
        response: { 200: okResponse({ ...pageResponseSchema("releases"), latest: { type: "object", additionalProperties: { type: "string" } } }) },
      },
    },
    async (request) => {
      const [page, enabled] = await Promise.all([
        listPage(request, {
          key: "releases",
          query: () => db.selectFrom("releases").selectAll(),
          countQuery: () => db.selectFrom("releases").select((eb) => eb.fn.count("id").as("count")),
          sortColumn: "created_at",
        }),
        db.selectFrom("releases").select(["platform", "version"]).where("enabled", "=", true).execute().catch(() => []),
      ]);
      // Which row a client is offered today is the one fact the list could not say.
      const latest = Object.fromEntries(latestReleases(enabled).map((row) => [row.platform, row.latest]));
      return { ...page, latest };
    },
  );

  app.post(
    "/api/admin/releases",
    {
      schema: {
        tags: ["admin:releases"],
        summary: "Create an app release",
        description: "Inserts a new app release record for a version/platform.",
        body: zodBody(createReleaseSchema),
        response: { 201: okResponse({ id: { type: "string" }, rolloutId: { type: "string" }, rolloutState: { type: "string" } }) },
      },
    },
    async (request, reply) => {
    const input = createReleaseSchema.parse(request.body);
    // A release row promises a file. Refuse only a definite "not there" — a host
    // that guards or cannot answer HEAD must never block a release.
    const artifact = await checkReleaseArtifact(input.url);
    if (!artifact.ok) return reply.code(400).send(artifactErrorResponse(artifact));
    if (input.draft && input.rolloutPercent !== undefined) {
      return reply.code(400).send({ ok: false, code: "ROLLOUT_DRAFT_AND_PERCENT", message: "Pass either draft or rolloutPercent, not both." });
    }
    const id = publicId("rel");
    const channel = input.channel || DEFAULT_CHANNEL;
    // A beta release is always staged: without a rollout it would be legacy — offered to everyone.
    const staged = input.draft || input.rolloutPercent !== undefined || channel !== DEFAULT_CHANNEL;
    let rollout = null;
    if (staged) {
      rollout = { id: publicId("rol"), release_id: id, platform: input.platform, version: input.version, channel, state: "draft", percent: 0, notes: input.notes || null, created_by: "admin" };
      // Beta is opt-in: a beta release with no percentage goes to all of beta.
      const startAt = input.rolloutPercent ?? (!input.draft && channel !== DEFAULT_CHANNEL ? 100 : undefined);
      if (startAt !== undefined) {
        const active = await db.selectFrom("release_rollouts").select(["id", "version"])
          .where("channel", "=", channel).where("platform", "=", input.platform)
          .where("state", "in", ["rolling", "paused"]).executeTakeFirst();
        const decided = transitionRollout({ ...rollout, immutable_feed: input.immutableFeed }, { action: "start", percent: startAt }, { otherActive: active || null });
        if (!decided.ok) return reply.code(400).send(decided);
        rollout = { ...rollout, ...decided.patch };
      }
    }
    await db.transaction().execute(async (trx) => {
      await trx
        .insertInto("releases")
        .values({
          id,
          version: input.version,
          platform: input.platform,
          url: input.url,
          sha256: input.sha256,
          size_bytes: input.sizeBytes || null,
          notes: input.notes || null,
          force_update: input.forceUpdate,
          enabled: input.enabled,
          immutable_feed: input.immutableFeed,
        })
        .execute();
      if (rollout) await trx.insertInto("release_rollouts").values(rollout).execute();
    });
    await audit(request, "release.create", "release", id, { version: input.version, platform: input.platform, ...(rollout ? { rollout: { id: rollout.id, state: rollout.state, percent: rollout.percent } } : {}) });
    return reply.code(201).send({ ok: true, id, ...(rollout ? { rolloutId: rollout.id, rolloutState: rollout.state } : {}) });
    },
  );

  app.patch(
    "/api/admin/releases/:id",
    {
      schema: {
        tags: ["admin:releases"],
        summary: "Enable, disable, or mark a release mandatory",
        description: "Updates the enabled and/or force_update flags of an existing app release. A mandatory release is a floor: clients below it must update.",
        body: zodBody(updateReleaseSchema),
        response: { 200: okResponse({ id: { type: "string" } }) },
      },
    },
    async (request, reply) => {
      const input = updateReleaseSchema.parse(request.body);
      const release = await db.selectFrom("releases").select(["id", "version", "platform"]).where("id", "=", request.params.id).executeTakeFirst();
      if (!release) return reply.code(404).send({ ok: false, code: "RELEASE_NOT_FOUND" });
      if (input.enabled !== undefined) {
        await db.updateTable("releases").set({ enabled: input.enabled }).where("id", "=", release.id).execute();
        await audit(request, "release.update", "release", release.id, { enabled: input.enabled });
      }
      // "Mandatory" is the platform's minimum supported version, not a flag on
      // a row: making a release mandatory sets that floor; unmarking clears it
      // only if it is this release's version.
      if (input.forceUpdate !== undefined) {
        const current = normalizeSupport(await db.selectFrom("release_support").selectAll()
          .where("channel", "=", DEFAULT_CHANNEL).where("platform", "=", release.platform).executeTakeFirst());
        const patch = input.forceUpdate
          ? { minSupportedVersion: release.version }
          : current.minSupportedVersion === release.version ? { minSupportedVersion: "" } : null;
        if (patch) {
          const written = await writeReleaseSupport({ channel: DEFAULT_CHANNEL, platform: release.platform, patch, audit, request });
          if (!written.ok) return reply.code(400).send(written);
        }
      }
      return { ok: true, id: release.id };
    },
  );
}
