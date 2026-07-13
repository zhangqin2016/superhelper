import { countryFromRequestIp } from "./request-geo.js";

function firstHeader(headers = {}, names = []) {
  for (const name of names) {
    const value = headers[name] ?? headers[name.toLowerCase()];
    if (Array.isArray(value)) return String(value[0] || "").trim();
    if (value) return String(value).split(",")[0].trim();
  }
  return "";
}

function normalizeRegion(value = "") {
  const region = String(value || "").trim().toLowerCase();
  if (["cn", "china", "domestic"].includes(region)) return "china";
  if (["ae", "are", "uae", "emirates", "overseas", "global", "intl", "international"].includes(region)) return "overseas";
  return "";
}

function normalizeCountry(value = "") {
  return String(value || "").trim().toUpperCase();
}

function normalizePhone(value = "") {
  const compact = String(value || "").trim().replace(/[\s()-]/g, "");
  if (/^\+861[3-9]\d{9}$/.test(compact)) return compact;
  if (/^1[3-9]\d{9}$/.test(compact)) return `+86${compact}`;
  return "";
}

function smsRegionBypassPhones(env = process.env) {
  return new Set(
    String(env.SMS_REGION_BYPASS_PHONES || "")
      .split(",")
      .map(normalizePhone)
      .filter(Boolean),
  );
}

export function smsRequestAllowedFromRegion(requestLike = {}, options = {}) {
  const phoneE164 = normalizePhone(options.phoneE164 || options.phone || requestLike.body?.phone);
  if (phoneE164 && smsRegionBypassPhones(options.env).has(phoneE164)) {
    return { ok: true, bypass: "phone" };
  }

  const headers = requestLike.headers || {};
  const explicitRegion = normalizeRegion(firstHeader(headers, ["x-lily-region", "x-client-region"]));
  if (explicitRegion === "overseas") return { ok: false, code: "SMS_REGION_BLOCKED" };
  if (explicitRegion === "china") return { ok: true };

  const headerCountry = normalizeCountry(firstHeader(headers, [
    "cf-ipcountry",
    "x-vercel-ip-country",
    "x-country-code",
    "x-client-country",
  ]));
  const country = headerCountry || countryFromRequestIp(requestLike).country;
  if (country && country !== "CN" && country !== "CHN") {
    return { ok: false, code: "SMS_REGION_BLOCKED", country };
  }
  return { ok: true };
}
