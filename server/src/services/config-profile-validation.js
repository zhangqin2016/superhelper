import { config } from "../config.js";
import { buildClientBootstrapPolicy } from "./client-bootstrap.js";
import { getMediaDeliveryMode, getModelDeliveryMode } from "./app-settings.js";
import {
  expandModelProviderMenu,
  isGatewayBaseUrl,
  parseGatewayProvider,
  withGatewayRuntimeConfig,
} from "./client-config.js";

/**
 * What an admin may save in a config profile, and what the admin preview shows.
 *
 * Extracted from routes/admin/config-profiles.js on 2026-09-22: the route file
 * had grown past the hotspot budget, and this half is not routing — it is the
 * contract a stored profile must satisfy plus the projection the preview
 * renders. Both are pure enough to test without a server.
 */

export function invalidConfigProfile(code, message, detail = {}) {
  return { ok: false, code, message, detail };
}

function modelPresetEnv(preset) {
  return preset?.env && typeof preset.env === "object" && !Array.isArray(preset.env) ? preset.env : {};
}

function isExplicitGatewayRoute(value) {
  const text = String(value || "").trim();
  if (!text) return false;
  if (text === "/llm" || text.startsWith("/llm/")) return true;
  try {
    const url = new URL(text);
    return url.pathname === "/llm" || url.pathname.startsWith("/llm/");
  } catch {
    return false;
  }
}

export function validateConfigProfileConfig(config) {
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    return invalidConfigProfile("CONFIG_PROFILE_INVALID_CONFIG", "Config must be a JSON object.");
  }

  const models = config.models;
  if (!models || typeof models !== "object" || Array.isArray(models)) return null;

  const providers = Array.isArray(models.providers) ? models.providers.filter(Boolean) : [];
  const presets = Array.isArray(models.presets) ? models.presets.filter(Boolean) : [];
  const hasProviderDirective = providers.length > 0 || Boolean(models.activeProvider);
  const hasPresetDirective = presets.length > 0 || Boolean(models.activePresetId);

  if (hasProviderDirective && hasPresetDirective) {
    return invalidConfigProfile(
      "CONFIG_PROFILE_MIXED_MODEL_MODES",
      "A delivery rule cannot mix models.providers with models.presets. Use the provider menu form, or keep a fully manual preset profile in a separate rule.",
      {
        providers,
        activeProvider: models.activeProvider || "",
        activePresetId: models.activePresetId || "",
        presetCount: presets.length,
      },
    );
  }

  if (String(models.source || "") === "client-direct") {
    return invalidConfigProfile(
      "CONFIG_PROFILE_CLIENT_DIRECT_NOT_ALLOWED",
      "Admin delivery rules cannot ship client-direct model presets. Configure model providers once, then deliver them by provider menu so keys stay server-side.",
    );
  }

  for (const preset of presets) {
    const env = modelPresetEnv(preset);
    const presetId = String(preset?.id || "");
    const apiKey = String(env.LILY_API_KEY || "").trim();
    const baseUrl = String(env.LILY_API_BASE_URL || "").trim();
    const gatewayProvider = String(env.LILY_GATEWAY_PROVIDER || "").trim();

    if (apiKey === "$LILY_PROVIDER_KEY") {
      return invalidConfigProfile(
        "CONFIG_PROFILE_PROVIDER_KEY_PLACEHOLDER_NOT_ALLOWED",
        "Admin delivery rules cannot contain $LILY_PROVIDER_KEY. Use models.providers so the server injects a short-lived gateway token at delivery time.",
        { presetId },
      );
    }

    if (gatewayProvider && baseUrl && !isExplicitGatewayRoute(baseUrl)) {
      return invalidConfigProfile(
        "CONFIG_PROFILE_MIXED_GATEWAY_AND_UPSTREAM_URL",
        "A preset cannot set LILY_GATEWAY_PROVIDER while pointing LILY_API_BASE_URL at an upstream provider URL. Use /llm/<provider> or models.providers.",
        { presetId, gatewayProvider, baseUrl },
      );
    }
  }

  return null;
}

function secretValueKind(value) {
  const text = String(value || "").trim();
  if (!text) return "missing";
  if (text === "$LILY_GATEWAY_TOKEN" || text.startsWith("lilygw.")) return "short_lived_gateway_token";
  if (/^(replace-|your-|example)/i.test(text)) return "placeholder";
  return "long_lived_secret";
}

export function summarizeEffectiveConfig(effectiveConfig) {
  const presets = Array.isArray(effectiveConfig?.models?.presets)
    ? effectiveConfig.models.presets
    : [];
  const runtimeEnv = effectiveConfig?.runtime?.env && typeof effectiveConfig.runtime.env === "object"
    ? effectiveConfig.runtime.env
    : {};
  const modelPresets = presets.map((preset) => {
    const env = preset?.env && typeof preset.env === "object" ? preset.env : {};
    const baseUrl = String(env.LILY_API_BASE_URL || "");
    const providerId = parseGatewayProvider(baseUrl, env);
    const viaGateway = isGatewayBaseUrl(baseUrl, env);
    const keyKind = secretValueKind(env.LILY_API_KEY);
    return {
      id: String(preset?.id || ""),
      label: String(preset?.label || preset?.id || ""),
      model: String(env.LILY_MODEL || env.LILY_MODEL_SONNET || ""),
      baseUrl,
      providerId,
      delivery: viaGateway ? "server_gateway" : "direct",
      keyKind,
      exposesLongLivedSecret: keyKind === "long_lived_secret",
    };
  });
  const runtimeSecretKeys = Object.keys(runtimeEnv).filter((key) => /(KEY|TOKEN|SECRET|PASSWORD)$/i.test(key));
  const longLivedModelKeys = modelPresets.filter((preset) => preset.exposesLongLivedSecret).length;
  return {
    activePresetId: String(effectiveConfig?.models?.activePresetId || ""),
    modelPresets,
    pluginRegistryUrl: String(effectiveConfig?.tools?.pluginRegistryUrl || ""),
    enabledPluginIds: Array.isArray(effectiveConfig?.tools?.enabledPluginIds)
      ? effectiveConfig.tools.enabledPluginIds.map(String)
      : [],
    permissionMode: String(effectiveConfig?.policy?.permissionMode || ""),
    minAppVersion: String(effectiveConfig?.policy?.minAppVersion || ""),
    runtimeSecretKeys,
    riskLevel: longLivedModelKeys || runtimeSecretKeys.length ? "warning" : "ok",
    risks: {
      directModelPresets: modelPresets.filter((preset) => preset.delivery === "direct").length,
      longLivedModelKeys,
      runtimeSecretKeys: runtimeSecretKeys.length,
    },
  };
}

export async function finalizeAdminPreviewEffectiveConfig({
  effectiveConfig,
  input = {},
  request = {},
  options = {},
} = {}) {
  const modelDeliveryMode = options.modelDeliveryMode || await getModelDeliveryMode();
  const mediaDeliveryMode = options.mediaDeliveryMode || await getMediaDeliveryMode();
  const scopedConfig = expandModelProviderMenu(effectiveConfig, {
    deliveryMode: modelDeliveryMode,
    providers: options.providers,
  });
  const bootstrapPolicy = options.bootstrapPolicy || buildClientBootstrapPolicy(request);
  return withGatewayRuntimeConfig(scopedConfig, request, {
    deviceId: input.deviceId || "admin-preview",
    licenseId: input.licenseId || "",
    appVersion: input.appVersion || "admin-preview",
  }, {
    publicBaseUrl: options.publicBaseUrl ?? config.publicBaseUrl,
    policyBaseUrl: options.policyBaseUrl ?? bootstrapPolicy.apiBaseUrl,
    mediaDeliveryMode,
    modelDeliveryMode,
    account: options.account || null,
    mediaContracts: options.mediaContracts,
  });
}
