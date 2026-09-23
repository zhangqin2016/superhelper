// The answer of GET /api/admin/session: small, and shaped so that a different
// service answering on the same address (it happened: Open WebUI) is never
// taken for a valid admin session.
export const ADMIN_SESSION_PATH = "/api/admin/session";

export function isAdminSessionPayload(value) {
  return Boolean(value && typeof value === "object" && value.ok === true && value.service === "lily-admin" && value.role === "admin");
}

export async function readAdminSessionResponse(response) {
  if (!response?.ok) return null;
  const contentType = response.headers.get("content-type") || "";
  if (!contentType.toLowerCase().includes("application/json")) return null;
  const json = await response.json().catch(() => null);
  return isAdminSessionPayload(json) ? json : null;
}

// A router prefetch only fetches; the navigation that follows is checked. The
// check is a courtesy redirect, not the boundary — every page read carries the
// credential and the API refuses it on its own.
export function isPrefetchRequest(headers) {
  const get = (name) => String(headers?.get?.(name) || "").toLowerCase();
  return get("next-router-prefetch") === "1" || get("purpose") === "prefetch" || get("sec-purpose").includes("prefetch");
}

export function isAdminSummaryPayload(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return [
    "licenses",
    "activeLicenses",
    "devices",
    "activeDevicesToday",
    "todayMessages",
    "todayTokens",
  ].every((key) => typeof value[key] === "number") && Array.isArray(value.models) && Array.isArray(value.trend);
}

export async function readAdminSummaryResponse(response) {
  if (!response?.ok) return null;
  const contentType = response.headers.get("content-type") || "";
  if (!contentType.toLowerCase().includes("application/json")) return null;
  const json = await response.json().catch(() => null);
  return isAdminSummaryPayload(json) ? json : null;
}

export function adminCredentialHeaders({ token = "", session = "" } = {}) {
  if (token) return { Authorization: `Bearer ${token}` };
  if (session) return { Cookie: `lily_admin_session=${encodeURIComponent(session)}` };
  return null;
}
