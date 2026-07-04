const DEFAULT_CHINA_BASE_URL = "https://lilych.lilywb.cn";
const DEFAULT_UAE_BASE_URL = "https://lilyuae.lilywb.cn";
const DEFAULT_TTL_SECONDS = 6 * 60 * 60;

function firstHeader(headers = {}, names = []) {
  for (const name of names) {
    const value = headers[name] ?? headers[name.toLowerCase()];
    if (Array.isArray(value)) return String(value[0] || "").trim();
    if (value) return String(value).split(",")[0].trim();
  }
  return "";
}

function normalizeHost(value = "") {
  return String(value || "").trim().toLowerCase().replace(/^https?:\/\//, "").split("/")[0].split(":")[0];
}

function normalizeCountry(value = "") {
  return String(value || "").trim().toUpperCase();
}

function normalizeRegion(value = "") {
  const region = String(value || "").trim().toLowerCase();
  if (["ae", "are", "uae", "emirates", "overseas"].includes(region)) return "uae";
  if (["cn", "china", "domestic"].includes(region)) return "china";
  return "";
}

export function resolveClientRegion(requestLike = {}) {
  const headers = requestLike.headers || {};
  const explicitRegion = normalizeRegion(firstHeader(headers, ["x-lily-region", "x-client-region"]));
  if (explicitRegion) return explicitRegion;

  const host = normalizeHost(
    firstHeader(headers, ["x-forwarded-host", "host", ":authority"]) || requestLike.hostname,
  );
  if (host === "lilyuae.lilywb.cn") return "uae";

  const country = normalizeCountry(firstHeader(headers, [
    "cf-ipcountry",
    "x-vercel-ip-country",
    "x-country-code",
    "x-client-country",
  ]));
  if (["AE", "ARE", "UAE"].includes(country)) return "uae";
  return "china";
}

function normalizeBaseUrl(value, fallback) {
  return String(value || fallback || "").trim().replace(/\/+$/, "");
}

export function buildClientBootstrapPolicy(requestLike = {}, options = {}) {
  const region = resolveClientRegion(requestLike);
  const chinaBaseUrl = normalizeBaseUrl(options.chinaBaseUrl || process.env.CLIENT_BOOTSTRAP_CHINA_BASE_URL, DEFAULT_CHINA_BASE_URL);
  const uaeBaseUrl = normalizeBaseUrl(options.uaeBaseUrl || process.env.CLIENT_BOOTSTRAP_UAE_BASE_URL, DEFAULT_UAE_BASE_URL);
  const baseUrl = region === "uae" ? uaeBaseUrl : chinaBaseUrl;
  const ttlSeconds = Number(options.ttlSeconds || process.env.CLIENT_BOOTSTRAP_TTL_SECONDS || DEFAULT_TTL_SECONDS);
  const features = region === "uae"
    ? {
        accountLogin: false,
        purchase: false,
        licenseActivation: true,
        usage: true,
        modelDirect: false,
        account: false,
        billing: false,
      }
    : {
        accountLogin: true,
        purchase: true,
        licenseActivation: true,
        usage: true,
        modelDirect: false,
        account: true,
        billing: true,
      };

  return {
    ok: true,
    schemaVersion: 1,
    configVersion: "runtime-policy-2026-07-uae-gateway",
    region,
    gatewayBaseUrl: baseUrl,
    apiBaseUrl: baseUrl,
    modelGatewayBaseUrl: `${baseUrl}/llm`,
    features,
    routing: {
      modelMode: "gateway",
      releaseChannel: "domestic",
      skillRegistry: "default",
    },
    ttlSeconds,
    expiresAt: new Date(Date.now() + ttlSeconds * 1000).toISOString(),
  };
}

export function clientFeatureEnabled(requestLike = {}, featureName) {
  const policy = buildClientBootstrapPolicy(requestLike);
  return policy.features?.[featureName] !== false;
}
