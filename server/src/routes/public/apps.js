import { z } from "zod";
import { db } from "../../db.js";
import { config } from "../../config.js";
import { buildWorkspaceAppCatalog, newestWorkspaceApps } from "../../services/workspace-apps.js";
import { planRank, planAllows } from "../../services/entitlements.js";
import { requireSignedDeviceRequest } from "../../services/device-identity.js";
import { zodBody, okResponse } from "../../openapi.js";

const downloadSchema = z.object({
  deviceId: z.string().min(6).max(120),
  channel: z.string().min(1).max(40).default("stable"),
});

// Resolve the access tier of the requesting device from its active, non-expired
// license binding. Unknown / unbound / anonymous → "free", so a caller only ever
// sees apps their plan reaches. This drives catalog VISIBILITY (defense in
// depth); the hard gate is the entitlement check at download time, so an
// unsigned device-id header here can at most reveal app metadata, not unlock it.
async function resolveViewerPlan(deviceId) {
  const id = String(deviceId || "").trim();
  if (!id) return "free";
  const rows = await db
    .selectFrom("license_devices")
    .innerJoin("licenses", "licenses.id", "license_devices.license_id")
    .select(["licenses.plan as plan", "licenses.expires_at as expires_at"])
    .where("license_devices.device_id", "=", id)
    .where("license_devices.status", "=", "active")
    .where("licenses.status", "=", "active")
    .execute();
  const now = Date.now();
  let best = "free";
  for (const row of rows) {
    if (new Date(row.expires_at).getTime() <= now) continue;
    if (planRank(row.plan) > planRank(best)) best = row.plan;
  }
  return best;
}

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
  app.get("/api/apps/catalog", {
    schema: {
      tags: ["public:apps"],
      summary: "List the workspace-app catalog",
      description: "Returns enabled workspace apps for a channel, scoped to the viewer's plan.",
      response: { 200: { type: "object", additionalProperties: true } },
    },
  }, async (request) => {
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
    const viewerPlan = await resolveViewerPlan(request.headers["x-lily-device-id"]);
    return buildWorkspaceAppCatalog(rows, { catalogUrl: `${baseUrl}/api/apps/catalog`, viewerPlan });
  });

  // The hard gate: resolve a gated app's artifact URL only for a signed device
  // whose active license reaches the app's min_plan. This is the single point of
  // entitlement enforcement at acquisition time. On the current public bucket it
  // returns the public URL after the check; switching gated artifacts to a private
  // bucket later only changes what this handler RETURNS (a signed, expiring URL) —
  // the client contract is unchanged.
  app.post("/api/apps/:appId/download", {
    schema: {
      tags: ["public:apps"],
      summary: "Resolve a workspace app's download URL",
      description:
        "Enforces license entitlement for a signed device and returns the app's artifact download URL.",
      body: zodBody(downloadSchema),
      response: {
        200: okResponse({
          app: { type: "object", additionalProperties: true },
        }),
      },
    },
  }, async (request, reply) => {
    const appId = String(request.params?.appId || "").trim();
    if (!appId) return reply.code(400).send({ ok: false, code: "APP_ID_REQUIRED" });
    let input;
    try {
      input = downloadSchema.parse(request.body || {});
    } catch {
      return reply.code(400).send({ ok: false, code: "INVALID_REQUEST" });
    }
    if (!(await requireSignedDeviceRequest(request, reply, input))) return;

    const rows = await db
      .selectFrom("workspace_apps")
      .selectAll()
      .where("app_id", "=", appId)
      .where("channel", "=", input.channel)
      .where("enabled", "=", true)
      .orderBy("created_at", "desc")
      .limit(50)
      .execute();
    const app = newestWorkspaceApps(rows).find((row) => row.app_id === appId);
    if (!app) return reply.code(404).send({ ok: false, code: "APP_NOT_FOUND" });

    const viewerPlan = await resolveViewerPlan(input.deviceId);
    if (!planAllows(viewerPlan, app.min_plan)) {
      return reply.code(403).send({ ok: false, code: "NOT_ENTITLED", requiredPlan: String(app.min_plan || "free") });
    }

    return reply.send({
      ok: true,
      app: {
        id: app.app_id,
        version: app.version,
        downloadUrl: app.artifact_url,
        sha256: String(app.sha256 || "").toLowerCase(),
        sizeBytes: Number(app.size_bytes || 0) || null,
        minPlan: String(app.min_plan || "free"),
      },
    });
  });
}
