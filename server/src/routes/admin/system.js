import { z } from "zod";
import { config } from "../../config.js";
import { db, pool } from "../../db.js";
import { getMediaDeliveryMode, getModelDeliveryMode, getQiniuAdminSettings, getQiniuConfig, setAppSetting, setQiniuConfig } from "../../services/app-settings.js";
import { ensureEnvManagedConfigProfile } from "../../services/client-config.js";
import { listModelGatewayProviders } from "../../services/model-gateway/providers.js";
import { signLicensePayload } from "../../services/security.js";
import { zodBody, okResponse } from "../../openapi.js";

const updateSettingsSchema = z.object({
  licenseTrialDays: z.number().int().min(0).max(3650),
  mediaDeliveryMode: z.enum(["direct", "gateway"]).optional(),
  modelDeliveryMode: z.enum(["direct", "gateway"]).optional(),
  qiniu: z.object({
    publicBaseUrl: z.string().url().max(400),
    accessKey: z.string().max(200),
    secretKey: z.string().max(200).optional().nullable(),
    bucket: z.string().min(1).max(120),
    uploadUrl: z.string().url().max(400),
  }).optional(),
});

function healthCheck(name, ok, detail = "", meta = {}) {
  return {
    name,
    ok: Boolean(ok),
    detail: String(detail || ""),
    ...meta,
  };
}

async function checkUpdateManifest(qiniu) {
  const url = `${qiniu.publicBaseUrl.replace(/\/+$/, "")}/app/updates/latest.json`;
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
  const qiniu = await getQiniuConfig();

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

  checks.push(await checkUpdateManifest(qiniu));

  const gatewayProviders = Object.values(listModelGatewayProviders()).map((provider) => ({
    id: provider.id,
    type: provider.type,
    baseUrl: provider.baseUrl,
    model: provider.model || "",
    models: provider.models || [],
    hasApiKey: Boolean(provider.apiKey),
    ready: Boolean(provider.baseUrl && provider.apiKey),
  }));
  const readyGatewayProviders = gatewayProviders.filter((provider) => provider.ready).length;
  checks.push(healthCheck(
    "model_gateway",
    !config.modelGatewayEnabled || readyGatewayProviders > 0,
    config.modelGatewayEnabled
      ? `${readyGatewayProviders}/${gatewayProviders.length} providers ready`
      : "gateway disabled",
    {
      enabled: Boolean(config.modelGatewayEnabled),
      providers: gatewayProviders,
    },
  ));
  checks.push(healthCheck(
    "config_delivery",
    true,
    "client config endpoint available",
    {
      endpoint: "/api/client/config",
      pluginRegistryUrl: "/api/skills/registry",
    },
  ));

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
      qiniuPublicBaseUrl: qiniu.publicBaseUrl,
      allowUnsignedLicenses: config.allowUnsignedLicenses,
      modelGatewayEnabled: config.modelGatewayEnabled,
      modelGatewayDefaultProvider: config.modelGatewayDefaultProvider,
      modelGatewayTokenTtlSeconds: config.modelGatewayTokenTtlSeconds,
    },
    checks,
  };
}

export function registerAdminSystemRoutes(app, { audit }) {
  app.get(
    "/api/admin/health",
    {
      schema: {
        tags: ["admin:system"],
        summary: "Run system health checks",
        description: "Probes the database, license keys/signing, update manifest and model gateway, returning per-check status.",
        response: {
          200: okResponse({
            status: { type: "string" },
            checkedAt: { type: "string" },
            runtime: { type: "object" },
            checks: { type: "array", items: { type: "object" } },
          }),
        },
      },
    },
    async () => {
    return buildAdminHealth();
  });

  app.get(
    "/api/admin/settings",
    {
      schema: {
        tags: ["admin:system"],
        summary: "Get system settings",
        description: "Returns the license trial days, model/media delivery modes and Qiniu storage settings.",
        response: { 200: okResponse({ settings: { type: "object" } }) },
      },
    },
    async () => {
    const row = await db
      .selectFrom("app_settings")
      .select("value")
      .where("key", "=", "license_trial_days")
      .executeTakeFirst();
    const days = Number(row?.value ?? 3);
    return {
      settings: {
        licenseTrialDays: Number.isFinite(days) ? days : 3,
        modelDeliveryMode: await getModelDeliveryMode(),
        mediaDeliveryMode: await getMediaDeliveryMode(),
        qiniu: await getQiniuAdminSettings(),
      },
    };
  });

  app.patch(
    "/api/admin/settings",
    {
      schema: {
        tags: ["admin:system"],
        summary: "Update system settings",
        description: "Updates license trial days, delivery modes and Qiniu config; writes an audit log entry.",
        body: zodBody(updateSettingsSchema),
        response: { 200: okResponse({ settings: { type: "object" } }) },
      },
    },
    async (request) => {
    const input = updateSettingsSchema.parse(request.body);
    await setAppSetting("license_trial_days", input.licenseTrialDays);
    if (input.mediaDeliveryMode) {
      await setAppSetting("media_delivery_mode", input.mediaDeliveryMode);
    }
    if (input.modelDeliveryMode) {
      await setAppSetting("model_delivery_mode", input.modelDeliveryMode);
      // Rebuild the env-managed default profile so chat presets switch
      // direct/gateway immediately.
      await ensureEnvManagedConfigProfile();
    }
    let qiniu = null;
    if (input.qiniu) {
      qiniu = await setQiniuConfig(input.qiniu);
    }
    await audit(request, "settings.update", "settings", "license_trial_days", {
      licenseTrialDays: input.licenseTrialDays,
      qiniuUpdated: Boolean(input.qiniu),
    });
    return {
      ok: true,
      settings: {
        licenseTrialDays: input.licenseTrialDays,
        qiniu: qiniu ? await getQiniuAdminSettings() : undefined,
      },
    };
  });
}
