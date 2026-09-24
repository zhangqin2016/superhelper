import { z } from "zod";
import { sql } from "kysely";
import { db } from "../../db.js";
import { zodBody, okResponse } from "../../openapi.js";
import { getAppSetting, getQiniuConfig, setAppSetting } from "../../services/app-settings.js";
import { offerRelease } from "../../services/release-offer.js";
import { ARCHIVE_SETTING, archiveCandidates, normalizeArchiveSettings, objectsForRelease } from "../../services/release-archive.js";
import { listObjects, moveObject } from "../../services/qiniu-rs.js";

const ARCHIVE_PREFIX = "archive/";

async function loadArchiveSettings() {
  return normalizeArchiveSettings(await getAppSetting(ARCHIVE_SETTING, null).catch(() => null));
}

/** The candidates as the server sees them now — never what a page last showed. */
async function currentCandidates({ withObjects }) {
  const [settings, releases, rollouts, supportRows, qiniu] = await Promise.all([
    loadArchiveSettings(),
    db.selectFrom("releases").selectAll().execute(),
    db.selectFrom("release_rollouts").selectAll().execute().catch(() => []),
    db.selectFrom("release_support").selectAll().where("channel", "=", "stable").execute().catch(() => []),
    getQiniuConfig(),
  ]);
  const platforms = [...new Set(releases.map((r) => r.platform))];
  const fullByPlatform = new Map();
  for (const platform of platforms) {
    const support = supportRows.find((row) => row.platform === platform) || null;
    const full = offerRelease({ releases: releases.filter((r) => r.platform === platform && r.enabled), rollouts: rollouts.filter((r) => r.platform === platform), support }).release;
    if (full) fullByPlatform.set(platform, full.version);
  }
  const minimumByPlatform = new Map(supportRows.filter((row) => row.min_supported_version).map((row) => [row.platform, row.min_supported_version]));
  const candidates = archiveCandidates({ releases, rollouts, fullByPlatform, minimumByPlatform, olderThanDays: settings.olderThanDays, now: Date.now() });
  const configured = Boolean(qiniu.accessKey && qiniu.secretKey && qiniu.bucket);
  if (!withObjects || !configured || !candidates.length) return { settings, candidates, configured, qiniu, fullByPlatform };
  // A storage listing that fails leaves the candidates visible and says why;
  // nothing is archived from a partial picture of what exists.
  try {
    const stableKeysByPlatform = new Map();
    for (const platform of new Set(candidates.map((c) => c.platform))) {
      stableKeysByPlatform.set(platform, await listObjects(qiniu, `app/auto-updates/${platform}/stable/`));
    }
    const withKeys = [];
    for (const release of candidates) {
      const feedKeys = await listObjects(qiniu, `app/auto-updates/${release.platform}/releases/${release.version}/`);
      withKeys.push({ ...release, objects: objectsForRelease(release, { publicBaseUrl: qiniu.publicBaseUrl, stableKeys: stableKeysByPlatform.get(release.platform) || [], feedKeys }) });
    }
    return { settings, candidates: withKeys, configured, qiniu, fullByPlatform };
  } catch (error) {
    return { settings, candidates: candidates.map((c) => ({ ...c, objects: [] })), configured, qiniu, fullByPlatform, storageError: error?.message || String(error) };
  }
}

const archiveSchema = z.object({ releaseIds: z.array(z.string().max(80)).min(1).max(500) });
const archiveSettingsSchema = z.object({ olderThanDays: z.number().int().min(7).max(3650) });

export function registerAdminReleaseArchiveRoutes(app, { audit }) {
  app.get(
    "/api/admin/release-archive/preview",
    {
      schema: {
        tags: ["admin:releases"],
        summary: "Old installers that may be archived, with the objects each would move",
        description: "Candidates: releases older than the retention period that are not offered to anyone, not newer than the full version, not in a pending rollout and not the minimum supported version. Nothing moves until confirmed.",
        response: { 200: okResponse({ settings: { type: "object", additionalProperties: true }, configured: { type: "boolean" }, storageError: { type: "string" }, candidates: { type: "array", items: { type: "object", additionalProperties: true } }, archived: { type: "array", items: { type: "object", additionalProperties: true } } }) },
      },
    },
    async () => {
      const { settings, candidates, configured, storageError } = await currentCandidates({ withObjects: true });
      const versions = candidates.map((c) => c.version);
      const active = versions.length ? await db.selectFrom("devices")
        .select([sql`platform || '-' || arch`.as("platform"), "app_version", sql`count(*)::int`.as("devices")])
        .where("last_seen_at", ">", sql`now() - interval '7 days'`).where("app_version", "in", versions)
        .groupBy([sql`platform || '-' || arch`, "app_version"]).execute() : [];
      const archived = await db.selectFrom("releases").select(["id", "version", "platform", "archived_at", "archived_objects"]).where("archived_at", "is not", null).orderBy("archived_at", "desc").limit(50).execute();
      return {
        ok: true,
        settings,
        configured,
        storageError: storageError || "",
        candidates: candidates.map((c) => ({
          id: c.id, version: c.version, platform: c.platform, created_at: c.created_at, objects: c.objects || [],
          activeDevices: active.filter((row) => row.platform === c.platform && row.app_version === c.version).reduce((sum, row) => sum + row.devices, 0),
        })),
        archived,
      };
    },
  );

  app.post(
    "/api/admin/release-archive",
    {
      schema: {
        tags: ["admin:releases"],
        summary: "Archive confirmed old installers",
        description: "Moves each confirmed candidate's objects under archive/ (reversible; nothing is deleted) and disables the release. Candidates are recomputed server-side: an id that is no longer a candidate is skipped.",
        body: zodBody(archiveSchema),
        response: { 200: okResponse({ results: { type: "array", items: { type: "object", additionalProperties: true } } }) },
      },
    },
    async (request, reply) => {
      const { releaseIds } = archiveSchema.parse(request.body || {});
      const { candidates, configured, qiniu, storageError } = await currentCandidates({ withObjects: true });
      if (!configured) return reply.code(400).send({ ok: false, code: "QINIU_NOT_CONFIGURED", message: "Object storage credentials are not configured (Config → Object storage)." });
      if (storageError) return reply.code(502).send({ ok: false, code: "QINIU_LIST_FAILED", message: `Could not list the stored objects, so nothing was archived: ${storageError}` });
      const wanted = new Set(releaseIds);
      const results = [];
      for (const release of candidates.filter((c) => wanted.has(c.id))) {
        const moved = [];
        const failed = [];
        for (const key of release.objects) {
          const result = await moveObject(qiniu, key, `${ARCHIVE_PREFIX}${key}`);
          if (result.ok) moved.push(key);
          else if (!result.missing) failed.push({ key, status: result.status });
        }
        if (moved.length) {
          await db.updateTable("releases").set({ archived_at: new Date(), archived_objects: JSON.stringify(moved), enabled: false }).where("id", "=", release.id).execute();
        }
        await audit(request, "release.archive", "release", release.id, { version: release.version, platform: release.platform, moved, failed });
        results.push({ id: release.id, version: release.version, platform: release.platform, moved: moved.length, failed });
      }
      const skipped = releaseIds.filter((id) => !candidates.some((c) => c.id === id));
      return { ok: true, results, skipped };
    },
  );

  app.post(
    "/api/admin/release-archive/:id/restore",
    {
      schema: {
        tags: ["admin:releases"],
        summary: "Restore an archived release",
        description: "Moves the release's archived objects back to their original keys and re-enables it.",
        response: { 200: okResponse({ restored: { type: "number" } }) },
      },
    },
    async (request, reply) => {
      const release = await db.selectFrom("releases").selectAll().where("id", "=", request.params.id).executeTakeFirst();
      if (!release?.archived_at) return reply.code(404).send({ ok: false, code: "RELEASE_NOT_ARCHIVED" });
      const qiniu = await getQiniuConfig();
      const keys = Array.isArray(release.archived_objects) ? release.archived_objects : [];
      let restored = 0;
      const failed = [];
      for (const key of keys) {
        const result = await moveObject(qiniu, `${ARCHIVE_PREFIX}${key}`, key);
        if (result.ok) restored += 1;
        else if (!result.missing) failed.push({ key, status: result.status });
      }
      if (!failed.length) await db.updateTable("releases").set({ archived_at: null, archived_objects: "[]", enabled: true }).where("id", "=", release.id).execute();
      await audit(request, "release.restore", "release", release.id, { version: release.version, platform: release.platform, restored, failed });
      if (failed.length) return reply.code(502).send({ ok: false, code: "RESTORE_PARTIAL", restored, failed });
      return { ok: true, restored };
    },
  );

  app.patch(
    "/api/admin/release-settings/archive",
    {
      schema: {
        tags: ["admin:releases"],
        summary: "Set how old an unused installer must be before it can be archived",
        body: zodBody(archiveSettingsSchema),
        response: { 200: okResponse({ settings: { type: "object", additionalProperties: true } }) },
      },
    },
    async (request) => {
      const input = archiveSettingsSchema.parse(request.body || {});
      const next = normalizeArchiveSettings(input);
      await setAppSetting(ARCHIVE_SETTING, next);
      await audit(request, "release_settings.archive", "app_setting", ARCHIVE_SETTING, next);
      return { ok: true, settings: next };
    },
  );
}
