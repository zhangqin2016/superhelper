import { db } from "../../db.js";
import { config } from "../../config.js";
import { buildSkillRegistry } from "../../services/skill-packages.js";

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

export function registerPublicSkillRoutes(app) {
  app.get(
    "/api/skills/registry",
    {
      schema: {
        tags: ["public:skills"],
        summary: "Get the public skill registry",
        description:
          "Returns enabled skill packages for the requested channel as a signed skill registry.",
        querystring: {
          type: "object",
          properties: { channel: { type: "string", default: "stable" } },
        },
      },
    },
    async (request) => {
    const channel = String(request.query?.channel || "stable").trim() || "stable";
    const rows = await db
      .selectFrom("skill_packages")
      .selectAll()
      .where("enabled", "=", true)
      .where("channel", "=", channel)
      .orderBy("created_at", "desc")
      .limit(500)
      .execute();

    const baseUrl = requestBaseUrl(request);
    return buildSkillRegistry(rows, { registryUrl: `${baseUrl}/api/skills/registry` });
  });
}
