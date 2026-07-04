"use strict";

function stringValue(value) {
  return String(value || "").trim();
}

function safeUrlSummary(rawBaseUrl) {
  const raw = stringValue(rawBaseUrl);
  if (!raw) return { baseUrl: "", host: "", path: "", relative: false, invalid: false };
  if (raw.startsWith("/")) {
    const pathOnly = raw.split(/[?#]/)[0] || "/";
    return { baseUrl: pathOnly, host: "", path: pathOnly, relative: true, invalid: false };
  }
  try {
    const u = new URL(raw);
    const pathOnly = u.pathname || "/";
    return {
      baseUrl: `${u.protocol}//${u.host}${pathOnly}`,
      host: u.host,
      path: pathOnly,
      relative: false,
      invalid: false,
    };
  } catch {
    return { baseUrl: "invalid-url", host: "", path: "", relative: false, invalid: true };
  }
}

function gatewayProviderFromPath(pathname) {
  const parts = String(pathname || "").split("/").filter(Boolean);
  if (parts[0] !== "llm") return "";
  const candidate = parts[1] || "";
  if (!candidate || candidate === "v1" || candidate === "messages") return "";
  return candidate;
}

function keyKind(apiKey) {
  const key = stringValue(apiKey);
  if (!key) return "missing";
  if (key === "$LILY_GATEWAY_TOKEN") return "gateway-placeholder";
  if (/^lilygw\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(key)) return "gateway-token";
  if (/^(sk-|sk_|ak-|ak_|AIza|ya29\.|xox[baprs]-)/i.test(key)) return "provider-key";
  return "configured-secret";
}

function classifyModelRoute(lilyEnv = {}) {
  const rawBaseUrl = stringValue(lilyEnv.LILY_OPENCODE_BASE_URL || lilyEnv.LILY_API_BASE_URL);
  const apiKey = stringValue(lilyEnv.LILY_OPENCODE_API_KEY || lilyEnv.LILY_API_KEY);
  const providerMarker = stringValue(lilyEnv.LILY_GATEWAY_PROVIDER);
  const model = stringValue(lilyEnv.LILY_OPENCODE_MODEL || lilyEnv.LILY_MODEL);
  const protocol = stringValue(lilyEnv.LILY_OPENCODE_PROTOCOL);
  const url = safeUrlSummary(rawBaseUrl);
  const providerFromPath = gatewayProviderFromPath(url.path);
  const kind = keyKind(apiKey);
  const markers = [];
  const warnings = [];

  if (providerMarker) markers.push("LILY_GATEWAY_PROVIDER");
  if (providerFromPath || /^\/llm(?:\/|$)/.test(url.path)) markers.push("llm-path");
  if (kind === "gateway-placeholder" || kind === "gateway-token") markers.push(kind);

  let route = "unconfigured";
  if (url.invalid) {
    route = "invalid";
    warnings.push("invalid-model-base-url");
  } else if (providerMarker || providerFromPath || /^\/llm(?:\/|$)/.test(url.path) || kind === "gateway-placeholder" || kind === "gateway-token") {
    route = "gateway";
  } else if (rawBaseUrl || apiKey) {
    route = "direct";
  }

  if (route === "gateway" && kind === "provider-key") warnings.push("gateway-route-has-provider-key-shape");
  if (route === "direct" && (kind === "gateway-placeholder" || kind === "gateway-token")) {
    warnings.push("direct-route-has-gateway-token-shape");
  }
  if (route === "direct" && !rawBaseUrl) warnings.push("direct-route-missing-base-url");
  if (route === "gateway" && !providerMarker && !providerFromPath) warnings.push("gateway-provider-not-explicit");

  return {
    route,
    isGateway: route === "gateway",
    provider: providerMarker || providerFromPath || "",
    model,
    protocol,
    baseUrl: url.baseUrl,
    baseHost: url.host,
    basePath: url.path,
    baseUrlRelative: Boolean(url.relative),
    keyKind: kind,
    markers,
    warnings,
  };
}

module.exports = {
  classifyModelRoute,
  safeUrlSummary,
  keyKind,
};
