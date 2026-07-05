import geoip from "geoip-lite";
import { isIP } from "node:net";

function firstHeader(headers = {}, names = []) {
  for (const name of names) {
    const value = headers[name] ?? headers[name.toLowerCase()];
    if (Array.isArray(value)) return String(value[0] || "").trim();
    if (value) return String(value).split(",")[0].trim();
  }
  return "";
}

function normalizeIp(value = "") {
  let ip = String(value || "").trim();
  if (!ip) return "";
  if (ip.startsWith("[") && ip.includes("]")) ip = ip.slice(1, ip.indexOf("]"));
  if (ip.startsWith("::ffff:")) ip = ip.slice("::ffff:".length);
  if (ip.includes(":") && ip.includes(".") && !isIP(ip)) ip = ip.slice(ip.lastIndexOf(":") + 1);
  return isIP(ip) ? ip : "";
}

export function requestIpCandidates(requestLike = {}) {
  const headers = requestLike.headers || {};
  const candidates = [];
  const forwarded = headers["x-forwarded-for"] ?? headers["X-Forwarded-For"];
  if (forwarded) {
    for (const part of String(Array.isArray(forwarded) ? forwarded[0] : forwarded).split(",")) {
      const ip = normalizeIp(part);
      if (ip) candidates.push(ip);
    }
  }
  for (const value of [
    firstHeader(headers, ["x-real-ip", "x-client-ip", "fastly-client-ip", "cf-connecting-ip"]),
    requestLike.ip,
  ]) {
    const ip = normalizeIp(value);
    if (ip) candidates.push(ip);
  }
  return [...new Set(candidates)];
}

export function countryFromRequestIp(requestLike = {}) {
  for (const ip of requestIpCandidates(requestLike)) {
    const country = String(geoip.lookup(ip)?.country || "").trim().toUpperCase();
    if (country) return { country, ip };
  }
  return { country: "", ip: "" };
}
