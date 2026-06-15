import { db } from "../../db.js";
import { config } from "../../config.js";
import { buildWorkspaceAppCatalog } from "../../services/workspace-apps.js";

function requestBaseUrl(request) {
  const configured = String(config.publicBaseUrl || "").trim().replace(/\/+$/, "");
  if (configured) return configured;
  const forwardedProto = String(request.headers["x-forwarded-proto"] || "").split(",")[0].trim();
  const proto = forwardedProto || request.protocol || "http";
  const host = String(request.headers["x-forwarded-host"] || request.headers.host || request.hostname || "")
    .split(",")[0]
    .trim();
  return host ? `${proto}://${host}`.replace(/\/+$/, "") : "";
}

export function registerPublicWorkspaceAppRoutes(app) {
  app.get("/api/apps/catalog", async (request) => {
    const channel = String(request.query?.channel || "stable").trim() || "stable";
    const rows = await db
      .selectFrom("workspace_apps")
      .selectAll()
      .where("enabled", "=", true)
      .where("channel", "=", channel)
      .orderBy("created_at", "desc")
      .limit(500)
      .execute();

    const baseUrl = requestBaseUrl(request);
    return buildWorkspaceAppCatalog(rows, { catalogUrl: `${baseUrl}/api/apps/catalog` });
  });
}
