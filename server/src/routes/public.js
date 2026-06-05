import { z } from "zod";
import { db } from "../db.js";
import { publicId } from "../services/ids.js";
import { hashLicenseKey, signLicensePayload } from "../services/security.js";

const registerDeviceSchema = z.object({
  deviceId: z.string().min(6).max(120),
  fingerprintHash: z.string().max(160).optional().nullable(),
  platform: z.string().max(40).optional().nullable(),
  arch: z.string().max(40).optional().nullable(),
  appVersion: z.string().max(40).optional().nullable(),
});

const activateSchema = registerDeviceSchema.extend({
  licenseKey: z.string().min(8).max(120),
});

const usageSchema = z.object({
  deviceId: z.string().min(6).max(120),
  licenseId: z.string().max(80).optional().nullable(),
  fingerprintHash: z.string().max(160).optional().nullable(),
  platform: z.string().max(40).optional().nullable(),
  arch: z.string().max(40).optional().nullable(),
  appVersion: z.string().max(40).optional().nullable(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  model: z.string().min(1).max(120),
  messageCount: z.number().int().min(0).default(0),
  imageCount: z.number().int().min(0).default(0),
  toolCallCount: z.number().int().min(0).default(0),
  pluginCallCount: z.number().int().min(0).default(0),
  inputTokens: z.number().int().min(0).default(0),
  outputTokens: z.number().int().min(0).default(0),
});

const pluginEventSchema = registerDeviceSchema.extend({
  licenseId: z.string().max(80).optional().nullable(),
  eventType: z.enum(["install", "update", "uninstall", "enable", "disable"]),
  pluginId: z.string().min(1).max(160),
  pluginVersion: z.string().max(80).optional().nullable(),
  metadata: z.record(z.any()).optional().default({}),
});

const runtimeDiagnosticSchema = registerDeviceSchema.extend({
  licenseId: z.string().max(80).optional().nullable(),
  claudeVersion: z.string().max(80).optional().nullable(),
  eventType: z.string().max(120).optional().nullable(),
  eventSubtype: z.string().max(120).optional().nullable(),
  normalizedKind: z.string().max(120).optional().nullable(),
  severity: z.enum(["info", "warning", "error"]).default("warning"),
  turnPhase: z.string().max(80).optional().nullable(),
  sessionState: z.string().max(80).optional().nullable(),
  summary: z.string().max(1000).optional().nullable(),
  trace: z.record(z.any()).optional().default({}),
});

const contactRequestSchema = z.object({
  name: z.string().min(1).max(120),
  email: z.string().email().max(160),
  company: z.string().max(160).optional().nullable(),
  phone: z.string().max(80).optional().nullable(),
  subject: z.string().max(160).optional().nullable(),
  message: z.string().min(8).max(4000),
  source: z.string().max(80).optional().nullable(),
});

async function getTrialDays() {
  const row = await db
    .selectFrom("app_settings")
    .select("value")
    .where("key", "=", "license_trial_days")
    .executeTakeFirst();
  const parsed = Number(row?.value ?? 3);
  if (!Number.isFinite(parsed)) return 3;
  return Math.max(0, Math.min(3650, Math.trunc(parsed)));
}

function addDays(date, days) {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000);
}

function trialPayload(device) {
  const endsAt = device?.trial_ends_at ? new Date(device.trial_ends_at) : null;
  const expiresAt = endsAt && Number.isFinite(endsAt.getTime()) ? endsAt.toISOString() : "";
  return {
    enabled: Boolean(expiresAt),
    valid: Boolean(expiresAt && endsAt.getTime() > Date.now()),
    expiresAt,
  };
}

async function upsertDevice(input) {
  const existing = await db
    .selectFrom("devices")
    .selectAll()
    .where("id", "=", input.deviceId)
    .executeTakeFirst();
  const trialDays = existing ? 0 : await getTrialDays();
  const firstSeenAt = new Date();
  const trialEndsAt = trialDays > 0 ? addDays(firstSeenAt, trialDays) : null;

  await db
    .insertInto("devices")
    .values({
      id: input.deviceId,
      fingerprint_hash: input.fingerprintHash || null,
      platform: input.platform || null,
      arch: input.arch || null,
      app_version: input.appVersion || null,
      ...(trialEndsAt ? { trial_ends_at: trialEndsAt } : {}),
    })
    .onConflict((oc) =>
      oc.column("id").doUpdateSet({
        fingerprint_hash: input.fingerprintHash || null,
        platform: input.platform || null,
        arch: input.arch || null,
        app_version: input.appVersion || null,
        last_seen_at: new Date(),
      }),
    )
    .execute();

  return db
    .selectFrom("devices")
    .selectAll()
    .where("id", "=", input.deviceId)
    .executeTakeFirst();
}

export async function publicRoutes(app) {
  app.get("/health", async () => ({ ok: true }));

  app.post("/api/devices/register", async (request, reply) => {
    const input = registerDeviceSchema.parse(request.body);
    const device = await upsertDevice(input);
    return reply.send({ ok: true, trial: trialPayload(device) });
  });

  app.post("/api/licenses/activate", async (request, reply) => {
    const input = activateSchema.parse(request.body);
    await upsertDevice(input);

    const license = await db
      .selectFrom("licenses")
      .selectAll()
      .where("license_key_hash", "=", hashLicenseKey(input.licenseKey))
      .executeTakeFirst();

    if (!license) return reply.code(404).send({ ok: false, code: "LICENSE_NOT_FOUND" });
    if (license.status !== "active") return reply.code(403).send({ ok: false, code: "LICENSE_DISABLED" });
    if (new Date(license.expires_at).getTime() <= Date.now()) {
      return reply.code(403).send({ ok: false, code: "LICENSE_EXPIRED" });
    }

    const existingBinding = await db
      .selectFrom("license_devices")
      .selectAll()
      .where("license_id", "=", license.id)
      .where("device_id", "=", input.deviceId)
      .executeTakeFirst();

    if (existingBinding?.status === "disabled") {
      return reply.code(403).send({ ok: false, code: "DEVICE_DISABLED" });
    }

    if (!existingBinding) {
      const count = await db
        .selectFrom("license_devices")
        .select((eb) => eb.fn.count("id").as("count"))
        .where("license_id", "=", license.id)
        .where("status", "=", "active")
        .executeTakeFirst();
      if (Number(count?.count || 0) >= license.seats) {
        return reply.code(403).send({ ok: false, code: "SEAT_LIMIT_REACHED" });
      }
      await db
        .insertInto("license_devices")
        .values({
          id: publicId("ldev"),
          license_id: license.id,
          device_id: input.deviceId,
        })
        .execute();
    } else {
      await db
        .updateTable("license_devices")
        .set({ last_seen_at: new Date() })
        .where("id", "=", existingBinding.id)
        .execute();
    }

    const payload = {
      licenseId: license.id,
      deviceId: input.deviceId,
      plan: license.plan,
      features: license.features || [],
      expiresAt: new Date(license.expires_at).toISOString(),
    };

    return reply.send({
      ok: true,
      license: {
        ...payload,
        signature: signLicensePayload(payload),
      },
    });
  });

  app.post("/api/licenses/verify", async (request, reply) => {
    const input = z.object({
      deviceId: z.string().min(6).max(120),
      licenseId: z.string().min(3).max(80),
      fingerprintHash: z.string().max(160).optional().nullable(),
      platform: z.string().max(40).optional().nullable(),
      arch: z.string().max(40).optional().nullable(),
      appVersion: z.string().max(40).optional().nullable(),
    }).parse(request.body);
    const device = await upsertDevice(input);

    const license = await db
      .selectFrom("licenses")
      .selectAll()
      .where("id", "=", input.licenseId)
      .executeTakeFirst();
    if (!license) return reply.code(404).send({ ok: false, code: "LICENSE_NOT_FOUND" });
    if (license.status !== "active") return reply.code(403).send({ ok: false, code: "LICENSE_DISABLED" });
    if (new Date(license.expires_at).getTime() <= Date.now()) {
      return reply.code(403).send({ ok: false, code: "LICENSE_EXPIRED" });
    }

    const binding = await db
      .selectFrom("license_devices")
      .selectAll()
      .where("license_id", "=", input.licenseId)
      .where("device_id", "=", input.deviceId)
      .executeTakeFirst();
    if (!binding) return reply.code(403).send({ ok: false, code: "DEVICE_NOT_ACTIVATED" });
    if (binding.status !== "active") return reply.code(403).send({ ok: false, code: "DEVICE_DISABLED" });

    await db
      .updateTable("license_devices")
      .set({ last_seen_at: new Date() })
      .where("id", "=", binding.id)
      .execute();

    return reply.send({
      ok: true,
      trial: trialPayload(device),
      license: {
        licenseId: license.id,
        deviceId: input.deviceId,
        customer: license.customer_name || license.id,
        plan: license.plan,
        features: license.features || [],
        expiresAt: new Date(license.expires_at).toISOString(),
      },
    });
  });

  app.post("/api/usage/report", async (request, reply) => {
    const input = usageSchema.parse(request.body);
    await upsertDevice(input);
    await db
      .insertInto("usage_daily")
      .values({
        usage_date: input.date,
        license_id: input.licenseId || null,
        device_id: input.deviceId,
        model: input.model,
        message_count: input.messageCount,
        image_count: input.imageCount,
        tool_call_count: input.toolCallCount,
        plugin_call_count: input.pluginCallCount,
        input_tokens: input.inputTokens,
        output_tokens: input.outputTokens,
      })
      .onConflict((oc) =>
        oc.columns(["usage_date", "device_id", "model"]).doUpdateSet((eb) => ({
          license_id: input.licenseId || null,
          message_count: eb("usage_daily.message_count", "+", input.messageCount),
          image_count: eb("usage_daily.image_count", "+", input.imageCount),
          tool_call_count: eb("usage_daily.tool_call_count", "+", input.toolCallCount),
          plugin_call_count: eb("usage_daily.plugin_call_count", "+", input.pluginCallCount),
          input_tokens: eb("usage_daily.input_tokens", "+", input.inputTokens),
          output_tokens: eb("usage_daily.output_tokens", "+", input.outputTokens),
          updated_at: new Date(),
        })),
      )
      .execute();
    return reply.send({ ok: true });
  });

  const usageSummarySchema = registerDeviceSchema.extend({
    historyDays: z.number().int().min(1).max(90).optional().default(30),
  });

  app.post("/api/usage/summary", async (request, reply) => {
    const input = usageSummarySchema.parse(request.body);
    await upsertDevice(input);
    const historyDays = Math.min(input.historyDays || 30, 90);
    const since = new Date(Date.now() - historyDays * 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10);

    const rows = await db
      .selectFrom("usage_daily")
      .select((eb) => [
        "usage_date",
        eb.fn.sum("input_tokens").as("input_tokens"),
        eb.fn.sum("output_tokens").as("output_tokens"),
        eb.fn.sum("message_count").as("message_count"),
      ])
      .where("device_id", "=", input.deviceId)
      .where("usage_date", ">=", since)
      .groupBy("usage_date")
      .orderBy("usage_date", "desc")
      .execute();

    return reply.send({
      ok: true,
      deviceId: input.deviceId,
      historyDays,
      days: rows.map((row) => ({
        date: String(row.usage_date).slice(0, 10),
        inputTokens: Number(row.input_tokens || 0),
        outputTokens: Number(row.output_tokens || 0),
        messageCount: Number(row.message_count || 0),
      })),
    });
  });

  app.post("/api/plugins/events", async (request, reply) => {
    const input = pluginEventSchema.parse(request.body);
    await upsertDevice(input);
    await db
      .insertInto("plugin_events")
      .values({
        event_type: input.eventType,
        plugin_id: input.pluginId,
        plugin_version: input.pluginVersion || null,
        license_id: input.licenseId || null,
        device_id: input.deviceId,
        app_version: input.appVersion || null,
        metadata: input.metadata || {},
      })
      .execute();
    return reply.send({ ok: true });
  });

  app.post("/api/diagnostics/runtime-traces", async (request, reply) => {
    const input = runtimeDiagnosticSchema.parse(request.body);
    await upsertDevice(input);
    const id = publicId("diag");
    await db
      .insertInto("runtime_diagnostics")
      .values({
        id,
        device_id: input.deviceId,
        license_id: input.licenseId || null,
        app_version: input.appVersion || null,
        platform: input.platform || null,
        arch: input.arch || null,
        claude_version: input.claudeVersion || null,
        event_type: input.eventType || null,
        event_subtype: input.eventSubtype || null,
        normalized_kind: input.normalizedKind || null,
        severity: input.severity,
        turn_phase: input.turnPhase || null,
        session_state: input.sessionState || null,
        summary: input.summary || null,
        trace: input.trace || {},
      })
      .execute();
    return reply.code(201).send({ ok: true, id });
  });

  async function createContactRequest(request, reply) {
    const input = contactRequestSchema.parse(request.body);
    const id = publicId("contact");
    await db
      .insertInto("contact_requests")
      .values({
        id,
        name: input.name,
        email: input.email,
        company: input.company || null,
        phone: input.phone || null,
        subject: input.subject || null,
        message: input.message,
        source: input.source || null,
        ip: request.ip || null,
        user_agent: request.headers["user-agent"] || null,
      })
      .execute();
    return reply.code(201).send({ ok: true, id });
  }

  app.post("/api/contact-requests", createContactRequest);
  app.post("/api/contact", createContactRequest);

  app.get("/api/releases/latest", async (request) => {
    const platform = String(request.query?.platform || "");
    const currentVersion = String(request.query?.version || "");
    const release = await db
      .selectFrom("releases")
      .selectAll()
      .where("platform", "=", platform)
      .where("enabled", "=", true)
      .orderBy("created_at", "desc")
      .executeTakeFirst();

    if (!release) return { hasUpdate: false };
    return {
      hasUpdate: release.version !== currentVersion,
      version: release.version,
      platform: release.platform,
      url: release.url,
      sha256: release.sha256,
      sizeBytes: Number(release.size_bytes || 0),
      notes: release.notes || "",
      force: release.force_update,
    };
  });

  app.get("/api/releases", async (request) => {
    const platform = String(request.query?.platform || "").trim();
    let query = db
      .selectFrom("releases")
      .selectAll()
      .where("enabled", "=", true)
      .orderBy("created_at", "desc");
    if (platform) query = query.where("platform", "=", platform);
    const releases = await query.limit(50).execute();
    return {
      releases: releases.map((release) => ({
        id: release.id,
        version: release.version,
        platform: release.platform,
        url: release.url,
        sha256: release.sha256,
        sizeBytes: Number(release.size_bytes || 0),
        notes: release.notes || "",
        force: release.force_update,
        createdAt: release.created_at,
      })),
    };
  });

  app.get("/api/plugins", async () => {
    const plugins = await db
      .selectFrom("plugins")
      .selectAll()
      .where("enabled", "=", true)
      .orderBy("created_at", "desc")
      .execute();
    return {
      plugins: plugins.map((plugin) => ({
        id: plugin.id,
        name: plugin.name,
        version: plugin.version,
        type: plugin.type,
        description: plugin.description || "",
        manifestUrl: plugin.manifest_url,
        sha256: plugin.sha256 || "",
        enabled: plugin.enabled,
      })),
    };
  });

  app.get("/api/plugins/registry", async (request) => {
    const baseUrl = `${request.protocol}://${request.hostname}`;
    const plugins = await db
      .selectFrom("plugins")
      .selectAll()
      .where("enabled", "=", true)
      .where("type", "=", "skill")
      .where("sha256", "is not", null)
      .orderBy("created_at", "desc")
      .execute();

    return {
      schemaVersion: 1,
      publisher: "Lily Workbench",
      registryUrl: `${baseUrl}/api/plugins/registry`,
      updatedAt: new Date().toISOString(),
      categories: [
        { id: "office", label: "Office" },
        { id: "dev", label: "Engineering" },
        { id: "pm", label: "Product" },
        { id: "marketing", label: "Marketing" },
        { id: "security", label: "Security" },
      ],
      skills: plugins.map((plugin) => ({
        id: plugin.id,
        name: plugin.name,
        description: plugin.description || "",
        latestVersion: plugin.version,
        sourceType: "zip",
        downloadUrl: plugin.manifest_url,
        sha256: plugin.sha256,
        category: "dev",
        categoryLabel: "Engineering",
        publisher: "Lily Workbench",
        changelog: plugin.description || "",
      })),
    };
  });
}
