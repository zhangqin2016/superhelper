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
