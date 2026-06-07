import { sha256 } from "./security.js";
import { signModelGatewayToken } from "./model-gateway/auth.js";

export const DEFAULT_EFFECTIVE_CONFIG = {
  schemaVersion: 1,
  models: {
    source: "packaged",
    activePresetId: "",
    presets: [],
  },
  tools: {
    pluginRegistryUrl: "/api/plugins/registry",
    enabledPluginIds: [],
  },
  policy: {
    permissionMode: "default",
    minAppVersion: "",
  },
  runtime: {
    env: {},
  },
};

function plainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

export function deepMerge(base, override) {
  const result = { ...plainObject(base) };
  for (const [key, value] of Object.entries(plainObject(override))) {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      result[key] = deepMerge(result[key], value);
    } else {
      result[key] = value;
    }
  }
  return result;
}

export function rolloutAllows(profile, deviceId) {
  const percent = Number(profile.rollout_percent ?? 100);
  if (!Number.isFinite(percent)) return true;
  if (percent <= 0) return false;
  if (percent >= 100) return true;
  const hash = sha256(`${profile.id}:${deviceId}`).slice(0, 8);
  const bucket = Number.parseInt(hash, 16) % 100;
  return bucket < percent;
}

function requestBaseUrl(request) {
  const forwardedProto = String(request.headers["x-forwarded-proto"] || "").split(",")[0].trim();
  const proto = forwardedProto || request.protocol || "http";
  const host = String(request.headers["x-forwarded-host"] || request.headers.host || request.hostname || "")
    .split(",")[0]
    .trim();
  return host ? `${proto}://${host}`.replace(/\/+$/, "") : "";
}

export function parseGatewayProvider(baseUrl, env = {}) {
  const explicit = String(env.LILY_GATEWAY_PROVIDER || "").trim();
  if (explicit) return explicit;
  try {
    const parsed = new URL(baseUrl, "https://lily.local");
    const parts = parsed.pathname.split("/").filter(Boolean);
    if (parts[0] === "llm" && parts[1] && parts[1] !== "v1" && parts[1] !== "messages") return parts[1];
  } catch {
    // Direct model URL validation is handled on the client; an invalid URL just means no gateway provider was inferred.
  }
  return "";
}

export function isGatewayBaseUrl(baseUrl, env = {}) {
  if (env.LILY_GATEWAY_PROVIDER) return true;
  try {
    const parsed = new URL(baseUrl, "https://lily.local");
    return parsed.pathname.split("/").filter(Boolean)[0] === "llm";
  } catch {
    return false;
  }
}

export function withGatewayRuntimeConfig(effectiveConfig, request, input, options = {}) {
  const configCopy = JSON.parse(JSON.stringify(effectiveConfig || {}));
  const presets = configCopy?.models?.presets;
  if (!Array.isArray(presets)) return configCopy;
  const configuredBaseUrl = String(options.publicBaseUrl || "").trim().replace(/\/+$/, "");
  const base = configuredBaseUrl || requestBaseUrl(request);
  for (const preset of presets) {
    const env = preset?.env && typeof preset.env === "object" ? preset.env : null;
    if (!env) continue;
    const baseUrl = String(env.LILY_API_BASE_URL || "").trim();
    if (!isGatewayBaseUrl(baseUrl, env)) continue;
    const providerId = parseGatewayProvider(baseUrl, env);
    if (baseUrl.startsWith("/") && base) env.LILY_API_BASE_URL = `${base}${baseUrl}`;
    if (!String(env.LILY_API_KEY || "").trim() || env.LILY_API_KEY === "$LILY_GATEWAY_TOKEN") {
      env.LILY_API_KEY = signModelGatewayToken({
        deviceId: input.deviceId,
        licenseId: input.licenseId || "",
        providerId,
      });
    }
  }
  return configCopy;
}
