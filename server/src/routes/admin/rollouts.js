import { z } from "zod";
import { sql } from "kysely";
import { db } from "../../db.js";
import { publicId } from "../../services/ids.js";
import { zodBody, okResponse } from "../../openapi.js";
import { DEFAULT_CHANNEL, offerRelease } from "../../services/release-offer.js";
import { compareVersions } from "../../services/release-versions.js";
import { ROLLOUT_ACTIONS, transitionRollout } from "../../services/release-rollouts.js";
import { baselineFor, judgeHealth, versionHealth } from "../../services/release-health.js";
import { RELEASE_CHANNELS, normalizeSupport, supportPolicyError } from "../../services/release-support.js";
import { AUTO_PAUSE_SETTING, loadAutoPause, normalizeAutoPause } from "../../services/rollout-guard.js";
import { getAppSetting, setAppSetting } from "../../services/app-settings.js";
import { LEGACY_NOTICE_SETTING, clearLegacyNoticeCache, legacyNoticeHits, normalizeLegacyNotice } from "../../services/legacy-client-notice.js";

const createRolloutSchema = z.object({
  channel: z.enum(["stable", "beta"]).optional(),
  // Omitted: a draft that reaches no one until started.
  percent: z.number().int().min(1).max(100).optional(),
  notes: z.string().max(2000).optional().nullable(),
});
const updateRolloutSchema = z.object({
  action: z.enum(ROLLOUT_ACTIONS),
  percent: z.number().int().min(1).max(100).optional(),
  reason: z.string().max(500).optional().nullable(),
});

const ACTIVE = ["rolling", "paused"];

async function otherActive(rollout) {
  return db.selectFrom("release_rollouts").select(["id", "version"])
    .where("channel", "=", rollout.channel)
    .where("platform", "=", rollout.platform)
    .where("state", "in", ACTIVE)
    .where("id", "!=", rollout.id)
    .executeTakeFirst();
}

export function registerAdminRolloutRoutes(app, { audit }) {
  app.get(
    "/api/admin/rollouts",
    {
      schema: {
        tags: ["admin:releases"],
        summary: "Release rollouts by platform",
        description: "Per platform on the stable channel: the version everyone is offered, the rollout in progress with its reach and health against the previous version, and recent rollouts.",
        response: { 200: okResponse({ platforms: { type: "array", items: { type: "object", additionalProperties: true } }, autoPause: { type: "object", additionalProperties: true }, legacyNotice: { type: "object", additionalProperties: true } }) },
      },
    },
    async () => {
      const autoPause = await loadAutoPause();
      const [releases, rollouts, health, adoption, supportRows, funnelRows] = await Promise.all([
        db.selectFrom("releases").selectAll().where("enabled", "=", true).execute(),
        db.selectFrom("release_rollouts").selectAll().orderBy("created_at", "desc").execute(),
        versionHealth({ windowHours: autoPause.windowHours }),
        db.selectFrom("devices")
          .select([sql`platform || '-' || arch`.as("platform"), "app_version", sql`count(*)::int`.as("devices")])
          .where("last_seen_at", ">", sql`now() - interval '7 days'`)
          .groupBy([sql`platform || '-' || arch`, "app_version"])
          .execute(),
        db.selectFrom("release_support").selectAll().execute().catch(() => []),
        db.selectFrom("update_events").select(["platform", "to_version", "stage", sql`count(*)::int`.as("devices")])
          .groupBy(["platform", "to_version", "stage"]).execute().catch(() => []),
      ]);
      const funnelFor = (platform, version) => Object.fromEntries(funnelRows
        .filter((row) => row.platform === platform && row.to_version === version)
        .map((row) => [row.stage, row.devices]));
      const platforms = [...new Set(releases.map((r) => r.platform))].sort();
      const legacyNotice = { ...normalizeLegacyNotice(await getAppSetting(LEGACY_NOTICE_SETTING, null).catch(() => null)), hits: legacyNoticeHits() };
      return {
        autoPause,
        legacyNotice,
        platforms: platforms.map((platform) => {
          const own = releases.filter((r) => r.platform === platform);
          const allRollouts = rollouts.filter((r) => r.platform === platform);
          const ownRollouts = allRollouts.filter((r) => r.channel === DEFAULT_CHANNEL);
          const supportRow = supportRows.find((row) => row.platform === platform && row.channel === DEFAULT_CHANNEL) || null;
          const support = normalizeSupport(supportRow);
          // What an anonymous device (the download page) and everyone gets.
          const full = offerRelease({ releases: own, rollouts: allRollouts, support: supportRow }).release;
          const active = ownRollouts.find((r) => ACTIVE.includes(r.state)) || null;
          const betaActive = allRollouts.find((r) => r.channel === "beta" && ACTIVE.includes(r.state)) || null;
          const belowMinimum = support.minSupportedVersion
            ? adoption.filter((row) => row.platform === platform && row.app_version && compareVersions(row.app_version, support.minSupportedVersion) < 0).reduce((sum, row) => sum + row.devices, 0)
            : 0;
          const activeWeek = adoption.filter((row) => row.platform === platform).reduce((sum, row) => sum + row.devices, 0);
          const onVersion = (version) => adoption.filter((row) => row.platform === platform && row.app_version === version).reduce((sum, row) => sum + row.devices, 0);
          const withHealth = (rollout) => {
            if (!rollout) return null;
            const candidate = health.get(`${platform}@${rollout.version}`) || null;
            const baseline = baselineFor(health, platform, rollout.version);
            return {
              ...rollout,
              installed: onVersion(rollout.version),
              funnel: funnelFor(platform, rollout.version),
              health: { ...judgeHealth(candidate, baseline, autoPause), candidate, baseline },
            };
          };
          return {
            platform,
            full: full ? { id: full.id, version: full.version, installed: onVersion(full.version) } : null,
            active: withHealth(active),
            betaActive: withHealth(betaActive),
            support: { ...support, belowMinimum, betaOverride: Boolean(supportRows.find((row) => row.platform === platform && row.channel === "beta")) },
            activeWeek,
            // Published but offered to no one yet: what "start" acts on.
            drafts: allRollouts.filter((r) => r.state === "draft").map((r) => ({ ...r, immutableFeed: Boolean(own.find((rel) => rel.id === r.release_id)?.immutable_feed) })),
            halted: ownRollouts.filter((r) => r.state === "halted").slice(0, 3),
            recent: ownRollouts.slice(0, 8),
          };
        }),
      };
    },
  );

  app.post(
    "/api/admin/releases/:id/rollout",
    {
      schema: {
        tags: ["admin:releases"],
        summary: "Create a rollout for a release",
        description: "Creates the release's stable-channel rollout: a draft when percent is omitted, a staged rollout below 100, complete at 100.",
        body: zodBody(createRolloutSchema),
        response: { 201: okResponse({ id: { type: "string" }, state: { type: "string" } }) },
      },
    },
    async (request, reply) => {
      const input = createRolloutSchema.parse(request.body || {});
      const release = await db.selectFrom("releases").selectAll().where("id", "=", request.params.id).executeTakeFirst();
      if (!release) return reply.code(404).send({ ok: false, code: "RELEASE_NOT_FOUND" });
      const channel = input.channel || DEFAULT_CHANNEL;
      const existing = await db.selectFrom("release_rollouts").select("id").where("release_id", "=", release.id).where("channel", "=", channel).executeTakeFirst();
      if (existing) return reply.code(409).send({ ok: false, code: "ROLLOUT_EXISTS", id: existing.id, message: "This release already has a rollout; act on it instead." });
      const draft = { id: publicId("rol"), release_id: release.id, platform: release.platform, version: release.version, channel, state: "draft", percent: 0, notes: input.notes || null, created_by: "admin" };
      let row = draft;
      if (input.percent !== undefined) {
        const decided = transitionRollout({ ...draft, immutable_feed: release.immutable_feed }, { action: "start", percent: input.percent }, { otherActive: await otherActive(draft) });
        if (!decided.ok) return reply.code(400).send(decided);
        row = { ...draft, ...decided.patch };
      }
      await db.insertInto("release_rollouts").values(row).execute();
      await audit(request, "rollout.create", "release_rollout", row.id, { release: release.id, version: release.version, platform: release.platform, state: row.state, percent: row.percent });
      return reply.code(201).send({ ok: true, id: row.id, state: row.state });
    },
  );

  app.patch(
    "/api/admin/rollouts/:id",
    {
      schema: {
        tags: ["admin:releases"],
        summary: "Advance, pause, resume, halt, reopen or complete a rollout",
        description: "Applies one state-machine action. The percentage only widens; stopping is pause or halt.",
        body: zodBody(updateRolloutSchema),
        response: { 200: okResponse({ id: { type: "string" }, state: { type: "string" }, percent: { type: "number" } }) },
      },
    },
    async (request, reply) => {
      const input = updateRolloutSchema.parse(request.body || {});
      const rollout = await db.selectFrom("release_rollouts").selectAll().where("id", "=", request.params.id).executeTakeFirst();
      if (!rollout) return reply.code(404).send({ ok: false, code: "ROLLOUT_NOT_FOUND" });
      const release = await db.selectFrom("releases").select(["immutable_feed"]).where("id", "=", rollout.release_id).executeTakeFirst();
      const decided = transitionRollout({ ...rollout, immutable_feed: Boolean(release?.immutable_feed) }, input, { otherActive: await otherActive(rollout) });
      if (!decided.ok) return reply.code(400).send(decided);
      await db.updateTable("release_rollouts").set({ ...decided.patch, updated_at: new Date() }).where("id", "=", rollout.id).execute();
      clearLegacyNoticeCache(); // what is offered changed
      await audit(request, `rollout.${input.action}`, "release_rollout", rollout.id, {
        version: rollout.version, platform: rollout.platform, from: { state: rollout.state, percent: rollout.percent }, to: decided.patch, reason: input.reason || null,
      });
      return { ok: true, id: rollout.id, state: decided.patch.state, percent: decided.patch.percent ?? rollout.percent };
    },
  );
}

const supportSchema = z.object({
  minSupportedVersion: z.string().max(40).optional().nullable(),
  blockedVersions: z.array(z.string().max(40)).max(50).optional(),
  mandateDeadline: z.string().max(40).optional().nullable(),
  reason: z.string().max(500).optional().nullable(),
});

/** Write one channel × platform support policy; shared by the route and the release-row shortcut. */
export async function writeReleaseSupport({ channel, platform, patch, audit, request }) {
  const current = normalizeSupport(await db.selectFrom("release_support").selectAll()
    .where("channel", "=", channel).where("platform", "=", platform).executeTakeFirst());
  const next = {
    minSupportedVersion: patch.minSupportedVersion === undefined ? current.minSupportedVersion : String(patch.minSupportedVersion || "").trim(),
    blockedVersions: patch.blockedVersions === undefined ? current.blockedVersions : [...new Set(patch.blockedVersions.map((v) => String(v).trim()).filter(Boolean))],
    mandateDeadline: patch.mandateDeadline === undefined ? current.mandateDeadline : String(patch.mandateDeadline || "").trim(),
  };
  const error = supportPolicyError(next);
  if (error) return { ok: false, code: "RELEASE_SUPPORT_INVALID", message: error };
  await db.insertInto("release_support").values({
    channel, platform,
    min_supported_version: next.minSupportedVersion || null,
    blocked_versions: JSON.stringify(next.blockedVersions),
    mandate_deadline: next.mandateDeadline ? new Date(next.mandateDeadline) : null,
    updated_by: "admin", updated_at: new Date(),
  }).onConflict((oc) => oc.columns(["channel", "platform"]).doUpdateSet({
    min_supported_version: next.minSupportedVersion || null,
    blocked_versions: JSON.stringify(next.blockedVersions),
    mandate_deadline: next.mandateDeadline ? new Date(next.mandateDeadline) : null,
    updated_by: "admin", updated_at: new Date(),
  })).execute();
  clearLegacyNoticeCache(); // the old-client notice follows the floor at once
  await audit(request, "release_support.update", "release_support", `${channel}:${platform}`, { from: current, to: next, reason: patch.reason || null });
  return { ok: true, support: next };
}

export function registerAdminReleaseSupportRoutes(app, { audit }) {
  app.patch(
    "/api/admin/release-support/:channel/:platform",
    {
      schema: {
        tags: ["admin:releases"],
        summary: "Change what a channel × platform still supports (fields left out keep their value)",
        description: "Minimum supported version (clients below must update), blocked versions (never offered; clients on one move to a newer version when one exists), and an optional deadline after which the mandate cannot be postponed.",
        body: zodBody(supportSchema),
        response: { 200: okResponse({ support: { type: "object", additionalProperties: true } }) },
      },
    },
    async (request, reply) => {
      const channel = String(request.params.channel || "");
      if (!RELEASE_CHANNELS.includes(channel)) return reply.code(400).send({ ok: false, code: "RELEASE_CHANNEL_UNKNOWN", message: `Channel must be one of ${RELEASE_CHANNELS.join(", ")}.` });
      const result = await writeReleaseSupport({ channel, platform: String(request.params.platform || ""), patch: supportSchema.parse(request.body || {}), audit, request });
      if (!result.ok) return reply.code(400).send(result);
      return result;
    },
  );
}

const autoPauseSchema = z.object({
  enabled: z.boolean(),
  minDevices: z.number().int().min(5).max(10_000).optional(),
  worseRatio: z.number().min(1.1).max(10).optional(),
  windowHours: z.number().int().min(1).max(168).optional(),
});

export function registerAdminReleaseSettingsRoutes(app, { audit }) {
  app.patch(
    "/api/admin/release-settings/auto-pause",
    {
      schema: {
        tags: ["admin:releases"],
        summary: "Turn rollout auto-pause on or off and set its thresholds",
        description: "A rolling version whose error rate per active device is at least worseRatio times the previous version's, with at least minDevices on both, is paused automatically when enabled.",
        body: zodBody(autoPauseSchema),
        response: { 200: okResponse({ autoPause: { type: "object", additionalProperties: true }, legacyNotice: { type: "object", additionalProperties: true } }) },
      },
    },
    async (request) => {
      const input = autoPauseSchema.parse(request.body || {});
      const before = await loadAutoPause();
      const next = normalizeAutoPause({ ...before, ...input });
      await setAppSetting(AUTO_PAUSE_SETTING, next);
      await audit(request, "release_settings.auto_pause", "app_setting", AUTO_PAUSE_SETTING, { from: before, to: next });
      return { ok: true, autoPause: next };
    },
  );

  const legacyNoticeSchema = z.object({
    enabled: z.boolean(),
    licenseIds: z.array(z.string().max(80)).max(500).optional(),
    deviceIds: z.array(z.string().max(120)).max(500).optional(),
  });
  app.patch(
    "/api/admin/release-settings/legacy-notice",
    {
      schema: {
        tags: ["admin:releases"],
        summary: "Answer chats from clients below the minimum supported version with how to update",
        description: "When enabled, a chat request through the model gateway from a device below its platform's minimum supported version gets a normal assistant reply saying how to update (no provider call, no billing) — only when an installable release reaches the floor. licenseIds/deviceIds restrict it to a trial scope; empty = every device below the floor.",
        body: zodBody(legacyNoticeSchema),
        response: { 200: okResponse({ legacyNotice: { type: "object", additionalProperties: true } }) },
      },
    },
    async (request) => {
      const input = legacyNoticeSchema.parse(request.body || {});
      const before = normalizeLegacyNotice(await getAppSetting(LEGACY_NOTICE_SETTING, null));
      const next = normalizeLegacyNotice({ ...before, ...input });
      await setAppSetting(LEGACY_NOTICE_SETTING, next);
      clearLegacyNoticeCache(); // a change takes effect on the next request, not after the cache
      await audit(request, "release_settings.legacy_notice", "app_setting", LEGACY_NOTICE_SETTING, { from: before, to: next });
      return { ok: true, legacyNotice: next };
    },
  );
}
