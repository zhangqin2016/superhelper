import { z } from "zod";
import { sql } from "kysely";
import { db, pool } from "../db.js";
import { config } from "../config.js";
import { licenseKey, publicId } from "../services/ids.js";
import { hashLicenseKey, signLicensePayload, timingSafeEqualText } from "../services/security.js";

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

const createLicenseSchema = z.object({
  customerName: z.string().max(160).optional().nullable(),
  plan: z.string().min(1).max(40).default("pro"),
  seats: z.number().int().min(1).max(100000).default(1),
  expiresAt: z.string().datetime(),
  features: z.array(z.string()).default(["updates", "plugins", "usage"]),
});

const createReleaseSchema = z.object({
  version: z.string().min(1).max(40),
  platform: z.string().min(1).max(40),
  url: z.string().url(),
  sha256: z.string().min(16).max(160),
  sizeBytes: z.number().int().min(0).optional().nullable(),
  notes: z.string().max(5000).optional().nullable(),
  forceUpdate: z.boolean().default(false),
  enabled: z.boolean().default(true),
});

const createPluginSchema = z.object({
  id: z.string().min(2).max(80),
  name: z.string().min(1).max(120),
  version: z.string().min(1).max(40),
  type: z.enum(["mcp", "skill", "tool"]),
  description: z.string().max(1000).optional().nullable(),
  manifestUrl: z.string().url(),
  sha256: z.string().max(160).optional().nullable(),
  enabled: z.boolean().default(true),
});

const updateLicenseSchema = z.object({
  status: z.enum(["active", "disabled"]).optional(),
  seats: z.number().int().min(1).max(100000).optional(),
  expiresAt: z.string().datetime().optional(),
  plan: z.string().min(1).max(40).optional(),
  customerName: z.string().max(160).optional().nullable(),
  features: z.array(z.string()).optional(),
});

const updateEnabledSchema = z.object({
  enabled: z.boolean(),
});

const updateDeviceBindingSchema = z.object({
  status: z.enum(["active", "disabled"]),
});

const updateSettingsSchema = z.object({
  licenseTrialDays: z.number().int().min(0).max(3650),
});

function assertAdmin(request, reply) {
  if (config.adminToken) {
    const auth = request.headers.authorization || "";
    if (auth === `Bearer ${config.adminToken}`) return true;
  }
  const session = request.cookies?.lily_admin_session;
  if (session && session === config.sessionSecret) return true;
  reply.code(401).send({ ok: false, code: "ADMIN_UNAUTHORIZED" });
  return false;
}

async function audit(request, action, targetType, targetId = null, metadata = {}) {
  try {
    await db
      .insertInto("audit_logs")
      .values({
        actor: config.adminEmail || "admin",
        action,
        target_type: targetType,
        target_id: targetId,
        ip: request.ip || null,
        user_agent: request.headers["user-agent"] || null,
        metadata: JSON.stringify(metadata || {}),
      })
      .execute();
  } catch (error) {
    request.log.warn({ error }, "audit log write failed");
  }
}

function healthCheck(name, ok, detail = "", meta = {}) {
  return {
    name,
    ok: Boolean(ok),
    detail: String(detail || ""),
    ...meta,
  };
}

async function checkUpdateManifest() {
  const url = `${config.qiniuPublicBaseUrl.replace(/\/+$/, "")}/app/updates/latest.json`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetch(url, { signal: controller.signal });
    return healthCheck(
      "update_manifest",
      response.ok,
      response.ok ? "latest.json reachable" : `${response.status} ${response.statusText}`,
      { url },
    );
  } catch (error) {
    return healthCheck("update_manifest", false, error?.message || String(error), { url });
  } finally {
    clearTimeout(timer);
  }
}

async function buildAdminHealth() {
  const checks = [];

  try {
    await pool.query("select 1");
    checks.push(healthCheck("database", true, "database reachable"));
  } catch (error) {
    checks.push(healthCheck("database", false, error?.message || String(error)));
  }

  checks.push(healthCheck(
    "license_private_key",
    Boolean(config.licensePrivateKey),
    config.licensePrivateKey ? "configured" : "missing",
  ));
  checks.push(healthCheck(
    "license_public_key",
    Boolean(config.licensePublicKey),
    config.licensePublicKey ? "configured" : "missing",
  ));

  try {
    const signature = signLicensePayload({ health: "check", issuedAt: new Date().toISOString() });
    checks.push(healthCheck(
      "license_signing",
      Boolean(signature),
      signature?.startsWith("dev.") ? "unsigned development signature" : "signing ok",
      { unsigned: Boolean(signature?.startsWith("dev.")) },
    ));
  } catch (error) {
    checks.push(healthCheck("license_signing", false, error?.message || String(error)));
  }

  checks.push(await checkUpdateManifest());

  const failed = checks.filter((item) => !item.ok);
  const warnings = checks.filter((item) => item.unsigned);
  const status = failed.length ? "error" : warnings.length ? "warning" : "ok";

  return {
    ok: failed.length === 0,
    status,
    checkedAt: new Date().toISOString(),
    runtime: {
      nodeEnv: process.env.NODE_ENV || "development",
      imageTag: process.env.IMAGE_TAG || "",
      packageVersion: process.env.npm_package_version || "",
      qiniuPublicBaseUrl: config.qiniuPublicBaseUrl,
      allowUnsignedLicenses: config.allowUnsignedLicenses,
    },
    checks,
  };
}

export async function adminRoutes(app) {
  app.post("/api/admin/login", async (request, reply) => {
    const input = loginSchema.parse(request.body);
    if (
      !timingSafeEqualText(input.email, config.adminEmail) ||
      !config.adminPassword ||
      !timingSafeEqualText(input.password, config.adminPassword)
    ) {
      return reply.code(401).send({ ok: false, code: "INVALID_LOGIN" });
    }

    reply.setCookie("lily_admin_session", config.sessionSecret, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      maxAge: 60 * 60 * 24 * 7,
    });
    return { ok: true };
  });

  app.addHook("preHandler", async (request, reply) => {
    if (!request.url.startsWith("/api/admin/")) return;
    if (request.url === "/api/admin/login") return;
    if (!assertAdmin(request, reply)) return reply;
  });

  app.get("/api/admin/summary", async () => {
    const today = new Date().toISOString().slice(0, 10);
    const since = new Date(Date.now() - 29 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const [licenses, activeLicenses, devices, activeDevices, todayUsage, models, trend] = await Promise.all([
      db.selectFrom("licenses").select((eb) => eb.fn.count("id").as("count")).executeTakeFirst(),
      db.selectFrom("licenses").select((eb) => eb.fn.count("id").as("count")).where("status", "=", "active").executeTakeFirst(),
      db.selectFrom("devices").select((eb) => eb.fn.count("id").as("count")).executeTakeFirst(),
      db
        .selectFrom("usage_daily")
        .select(() => sql`count(distinct device_id)`.as("count"))
        .where("usage_date", "=", today)
        .executeTakeFirst(),
      db
        .selectFrom("usage_daily")
        .select((eb) => [
          eb.fn.sum("message_count").as("messages"),
          eb.fn.sum("input_tokens").as("input_tokens"),
          eb.fn.sum("output_tokens").as("output_tokens"),
        ])
        .where("usage_date", "=", today)
        .executeTakeFirst(),
      db
        .selectFrom("usage_daily")
        .select((eb) => ["model", eb.fn.sum("message_count").as("messages")])
        .groupBy("model")
        .orderBy("messages", "desc")
        .limit(8)
        .execute(),
      db
        .selectFrom("usage_daily")
        .select((eb) => [
          "usage_date",
          eb.fn.sum("message_count").as("messages"),
          sql`count(distinct device_id)`.as("active_devices"),
        ])
        .where("usage_date", ">=", since)
        .groupBy("usage_date")
        .orderBy("usage_date", "asc")
        .execute(),
    ]);
    return {
      licenses: Number(licenses?.count || 0),
      activeLicenses: Number(activeLicenses?.count || 0),
      devices: Number(devices?.count || 0),
      activeDevicesToday: Number(activeDevices?.count || 0),
      todayMessages: Number(todayUsage?.messages || 0),
      todayTokens: Number(todayUsage?.input_tokens || 0) + Number(todayUsage?.output_tokens || 0),
      models: models.map((row) => ({ model: row.model, messages: Number(row.messages || 0) })),
      trend: trend.map((row) => ({
        date: String(row.usage_date).slice(0, 10),
        messages: Number(row.messages || 0),
        activeDevices: Number(row.active_devices || 0),
      })),
    };
  });

  app.get("/api/admin/health", async () => {
    return buildAdminHealth();
  });

  app.get("/api/admin/settings", async () => {
    const row = await db
      .selectFrom("app_settings")
      .select("value")
      .where("key", "=", "license_trial_days")
      .executeTakeFirst();
    const days = Number(row?.value ?? 3);
    return {
      settings: {
        licenseTrialDays: Number.isFinite(days) ? days : 3,
      },
    };
  });

  app.patch("/api/admin/settings", async (request) => {
    const input = updateSettingsSchema.parse(request.body);
    await db
      .insertInto("app_settings")
      .values({
        key: "license_trial_days",
        value: JSON.stringify(input.licenseTrialDays),
        updated_at: new Date(),
      })
      .onConflict((oc) =>
        oc.column("key").doUpdateSet({
          value: JSON.stringify(input.licenseTrialDays),
          updated_at: new Date(),
        }),
      )
      .execute();
    await audit(request, "settings.update", "settings", "license_trial_days", {
      licenseTrialDays: input.licenseTrialDays,
    });
    return { ok: true, settings: { licenseTrialDays: input.licenseTrialDays } };
  });

  app.get("/api/admin/licenses", async () => {
    return {
      licenses: await db.selectFrom("licenses").selectAll().orderBy("created_at", "desc").limit(200).execute(),
    };
  });

  app.get("/api/admin/licenses/:id", async (request, reply) => {
    const license = await db
      .selectFrom("licenses")
      .selectAll()
      .where("id", "=", request.params.id)
      .executeTakeFirst();
    if (!license) return reply.code(404).send({ ok: false, code: "LICENSE_NOT_FOUND" });
    const [devices, usage] = await Promise.all([
      db
        .selectFrom("license_devices")
        .leftJoin("devices", "devices.id", "license_devices.device_id")
        .select([
          "license_devices.id",
          "license_devices.device_id",
          "license_devices.status",
          "license_devices.activated_at",
          "license_devices.last_seen_at",
          "devices.platform",
          "devices.arch",
          "devices.app_version",
          "devices.trial_ends_at",
        ])
        .where("license_devices.license_id", "=", request.params.id)
        .orderBy("license_devices.last_seen_at", "desc")
        .execute(),
      db
        .selectFrom("usage_daily")
        .select((eb) => [
          eb.fn.sum("message_count").as("messages"),
          eb.fn.sum("image_count").as("images"),
          eb.fn.sum("tool_call_count").as("tool_calls"),
          eb.fn.sum("plugin_call_count").as("plugin_calls"),
          eb.fn.sum("input_tokens").as("input_tokens"),
          eb.fn.sum("output_tokens").as("output_tokens"),
        ])
        .where("license_id", "=", request.params.id)
        .executeTakeFirst(),
    ]);
    return { license, devices, usage };
  });

  app.post("/api/admin/licenses", async (request, reply) => {
    const input = createLicenseSchema.parse(request.body);
    const key = licenseKey();
    const id = publicId("lic");
    await db
      .insertInto("licenses")
      .values({
        id,
        license_key_hash: hashLicenseKey(key),
        customer_name: input.customerName || null,
        plan: input.plan,
        seats: input.seats,
        expires_at: input.expiresAt,
        features: JSON.stringify(input.features),
      })
      .execute();
    await audit(request, "license.create", "license", id, { customerName: input.customerName, plan: input.plan, seats: input.seats });
    return reply.code(201).send({ ok: true, licenseId: id, licenseKey: key });
  });

  app.patch("/api/admin/licenses/:id", async (request) => {
    const input = updateLicenseSchema.parse(request.body);
    const updates = {
      ...(input.status ? { status: input.status } : {}),
      ...(input.seats ? { seats: input.seats } : {}),
      ...(input.expiresAt ? { expires_at: input.expiresAt } : {}),
      ...(input.plan ? { plan: input.plan } : {}),
      ...(input.customerName !== undefined ? { customer_name: input.customerName || null } : {}),
      ...(input.features ? { features: JSON.stringify(input.features) } : {}),
      updated_at: new Date(),
    };
    await db.updateTable("licenses").set(updates).where("id", "=", request.params.id).execute();
    await audit(request, "license.update", "license", request.params.id, updates);
    return { ok: true, id: request.params.id };
  });

  app.get("/api/admin/devices", async () => {
    const devices = await db
      .selectFrom("devices")
      .leftJoin("license_devices", "license_devices.device_id", "devices.id")
      .select([
        "devices.id",
        "devices.platform",
        "devices.arch",
        "devices.app_version",
        "devices.first_seen_at",
        "devices.last_seen_at",
        "devices.trial_ends_at",
        "license_devices.id as license_device_id",
        "license_devices.license_id",
        "license_devices.status as license_status",
      ])
      .orderBy("devices.last_seen_at", "desc")
      .limit(300)
      .execute();
    return { devices };
  });

  app.get("/api/admin/devices/:id", async (request, reply) => {
    const device = await db
      .selectFrom("devices")
      .selectAll()
      .where("id", "=", request.params.id)
      .executeTakeFirst();
    if (!device) return reply.code(404).send({ ok: false, code: "DEVICE_NOT_FOUND" });
    const [licenses, usage] = await Promise.all([
      db
        .selectFrom("license_devices")
        .leftJoin("licenses", "licenses.id", "license_devices.license_id")
        .select([
          "license_devices.id",
          "license_devices.license_id",
          "license_devices.status",
          "license_devices.activated_at",
          "license_devices.last_seen_at",
          "licenses.customer_name",
          "licenses.plan",
          "licenses.expires_at",
        ])
        .where("license_devices.device_id", "=", request.params.id)
        .orderBy("license_devices.last_seen_at", "desc")
        .execute(),
      db
        .selectFrom("usage_daily")
        .selectAll()
        .where("device_id", "=", request.params.id)
        .orderBy("usage_date", "desc")
        .limit(120)
        .execute(),
    ]);
    return { device, licenses, usage };
  });

  app.patch("/api/admin/license-devices/:id", async (request) => {
    const input = updateDeviceBindingSchema.parse(request.body);
    await db
      .updateTable("license_devices")
      .set({ status: input.status, last_seen_at: new Date() })
      .where("id", "=", request.params.id)
      .execute();
    await audit(request, "license_device.update", "license_device", request.params.id, { status: input.status });
    return { ok: true, id: request.params.id };
  });

  app.delete("/api/admin/license-devices/:id", async (request) => {
    await db.deleteFrom("license_devices").where("id", "=", request.params.id).execute();
    await audit(request, "license_device.delete", "license_device", request.params.id);
    return { ok: true, id: request.params.id };
  });

  app.get("/api/admin/usage", async (request) => {
    const days = Math.min(Number(request.query?.days || 30), 120);
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    let query = db
      .selectFrom("usage_daily")
      .selectAll()
      .where("usage_date", ">=", since)
      .orderBy("usage_date", "desc");
    const licenseId = String(request.query?.licenseId || "").trim();
    const deviceId = String(request.query?.deviceId || "").trim();
    const model = String(request.query?.model || "").trim();
    if (licenseId) query = query.where("license_id", "=", licenseId);
    if (deviceId) query = query.where("device_id", "=", deviceId);
    if (model) query = query.where("model", "=", model);
    const usage = await query.limit(1000).execute();
    return { usage };
  });

  app.get("/api/admin/diagnostics", async (request) => {
    const days = Math.min(Number(request.query?.days || 30), 120);
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    let query = db
      .selectFrom("runtime_diagnostics")
      .selectAll()
      .where("created_at", ">=", since)
      .orderBy("created_at", "desc");
    const deviceId = String(request.query?.deviceId || "").trim();
    const kind = String(request.query?.kind || "").trim();
    const severity = String(request.query?.severity || "").trim();
    if (deviceId) query = query.where("device_id", "=", deviceId);
    if (kind) query = query.where("normalized_kind", "=", kind);
    if (severity) query = query.where("severity", "=", severity);
    const [diagnostics, byKind] = await Promise.all([
      query.limit(300).execute(),
      db
        .selectFrom("runtime_diagnostics")
        .select((eb) => [
          "normalized_kind",
          "severity",
          eb.fn.count("id").as("count"),
        ])
        .where("created_at", ">=", since)
        .groupBy(["normalized_kind", "severity"])
        .orderBy("count", "desc")
        .limit(20)
        .execute(),
    ]);
    return {
      diagnostics,
      byKind: byKind.map((row) => ({
        kind: row.normalized_kind || "unknown",
        severity: row.severity || "warning",
        count: Number(row.count || 0),
      })),
    };
  });

  app.get("/api/admin/diagnostics/:id", async (request, reply) => {
    const diagnostic = await db
      .selectFrom("runtime_diagnostics")
      .selectAll()
      .where("id", "=", request.params.id)
      .executeTakeFirst();
    if (!diagnostic) return reply.code(404).send({ ok: false, code: "DIAGNOSTIC_NOT_FOUND" });
    return { diagnostic };
  });

  app.get("/api/admin/contact-requests", async () => ({
    contacts: await db
      .selectFrom("contact_requests")
      .selectAll()
      .orderBy("created_at", "desc")
      .limit(300)
      .execute(),
  }));

  app.get("/api/admin/releases", async () => ({
    releases: await db.selectFrom("releases").selectAll().orderBy("created_at", "desc").limit(200).execute(),
  }));

  app.post("/api/admin/releases", async (request, reply) => {
    const input = createReleaseSchema.parse(request.body);
    const id = publicId("rel");
    await db
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
      })
      .execute();
    await audit(request, "release.create", "release", id, { version: input.version, platform: input.platform });
    return reply.code(201).send({ ok: true, id });
  });

  app.patch("/api/admin/releases/:id", async (request) => {
    const input = updateEnabledSchema.parse(request.body);
    await db.updateTable("releases").set({ enabled: input.enabled }).where("id", "=", request.params.id).execute();
    await audit(request, "release.update", "release", request.params.id, { enabled: input.enabled });
    return { ok: true, id: request.params.id };
  });

  app.get("/api/admin/plugins", async () => ({
    plugins: await db.selectFrom("plugins").selectAll().orderBy("created_at", "desc").limit(200).execute(),
  }));

  app.post("/api/admin/plugins", async (request, reply) => {
    const input = createPluginSchema.parse(request.body);
    await db
      .insertInto("plugins")
      .values({
        id: input.id,
        name: input.name,
        version: input.version,
        type: input.type,
        description: input.description || null,
        manifest_url: input.manifestUrl,
        sha256: input.sha256 || null,
        enabled: input.enabled,
      })
      .onConflict((oc) =>
        oc.column("id").doUpdateSet({
          name: input.name,
          version: input.version,
          type: input.type,
          description: input.description || null,
          manifest_url: input.manifestUrl,
          sha256: input.sha256 || null,
          enabled: input.enabled,
          updated_at: new Date(),
        }),
      )
      .execute();
    await audit(request, "plugin.upsert", "plugin", input.id, { version: input.version, type: input.type, enabled: input.enabled });
    return reply.code(201).send({ ok: true, id: input.id });
  });

  app.patch("/api/admin/plugins/:id", async (request) => {
    const input = updateEnabledSchema.parse(request.body);
    await db
      .updateTable("plugins")
      .set({ enabled: input.enabled, updated_at: new Date() })
      .where("id", "=", request.params.id)
      .execute();
    await audit(request, "plugin.update", "plugin", request.params.id, { enabled: input.enabled });
    return { ok: true, id: request.params.id };
  });

  app.get("/api/admin/audit-logs", async () => ({
    logs: await db.selectFrom("audit_logs").selectAll().orderBy("created_at", "desc").limit(300).execute(),
  }));
}
