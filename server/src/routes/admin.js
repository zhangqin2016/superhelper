import { z } from "zod";
import { zodBody, okResponse } from "../openapi.js";
import { db } from "../db.js";
import { config } from "../config.js";
import { timingSafeEqualText, createAdminSessionToken, verifyAdminSessionToken } from "../services/security.js";
import { registerAdminAuditRoutes } from "./admin/audit.js";
import { registerAdminBillingRoutes } from "./admin/billing.js";
import { registerAdminConfigGroupRoutes } from "./admin/config-groups.js";
import { registerAdminConfigProfileRoutes } from "./admin/config-profiles.js";
import { registerAdminContactRoutes } from "./admin/contacts.js";
import { registerAdminDeviceRoutes } from "./admin/devices.js";
import { registerAdminDiagnosticsRoutes } from "./admin/diagnostics.js";
import { registerAdminEnterpriseRoutes } from "./admin/enterprise.js";
import { registerAdminRuntimePackRoutes } from "./admin/runtime-packs.js";
import { registerAdminLicenseRoutes } from "./admin/licenses.js";
import { registerAdminModelProviderRoutes } from "./admin/model-providers.js";
import { registerAdminReleaseRoutes } from "./admin/releases.js";
import { registerAdminSummaryRoutes } from "./admin/summary.js";
import { registerAdminSystemRoutes } from "./admin/system.js";
import { registerAdminSkillPackageRoutes } from "./admin/skill-packages.js";
import { registerAdminUsageRoutes } from "./admin/usage.js";
import { registerAdminUserRoutes } from "./admin/users.js";
import { registerAdminWorkspaceAppRoutes } from "./admin/workspace-apps.js";
import { registerAdminWishRoutes } from "./admin/wishes.js";

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

function assertAdmin(request, reply) {
  if (config.adminToken) {
    const auth = request.headers.authorization || "";
    if (auth === `Bearer ${config.adminToken}`) return true;
  }
  const session = request.cookies?.lily_admin_session;
  if (session && verifyAdminSessionToken(session)) return true;
  reply.code(401).send({ ok: false, code: "ADMIN_UNAUTHORIZED" });
  return false;
}

async function audit(request, action, targetType, targetId = null, metadata = {}) {
  try {
    await db
      .insertInto("audit_logs")
      .values({
        actor: config.adminEmail || "admin",
        action,
        target_type: targetType,
        target_id: targetId,
        ip: request.ip || null,
        user_agent: request.headers["user-agent"] || null,
        metadata: JSON.stringify(metadata || {}),
      })
      .execute();
  } catch (error) {
    request.log.warn({ error }, "audit log write failed");
  }
}

export async function adminRoutes(app) {
  app.post(
    "/api/admin/login",
    {
      schema: {
        tags: ["admin:auth"],
        summary: "Authenticate an admin and set a session cookie",
        description: "Validates admin credentials and, on success, sets the lily_admin_session cookie.",
        body: zodBody(loginSchema),
        response: { 200: okResponse() },
      },
    },
    async (request, reply) => {
    const input = loginSchema.parse(request.body);
    if (
      !timingSafeEqualText(input.email, config.adminEmail) ||
      !config.adminPassword ||
      !timingSafeEqualText(input.password, config.adminPassword)
    ) {
      return reply.code(401).send({ ok: false, code: "INVALID_LOGIN" });
    }

    reply.setCookie("lily_admin_session", createAdminSessionToken(), {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      maxAge: 60 * 60 * 24 * 7,
    });
    return { ok: true };
  });

  app.addHook("preHandler", async (request, reply) => {
    if (!request.url.startsWith("/api/admin/")) return;
    if (request.url === "/api/admin/login") return;
    if (!assertAdmin(request, reply)) return reply;
  });

  registerAdminSummaryRoutes(app);
  registerAdminSystemRoutes(app, { audit });

  registerAdminLicenseRoutes(app, { audit });
  registerAdminUserRoutes(app);
  registerAdminDeviceRoutes(app, { audit });
  registerAdminUsageRoutes(app);
  registerAdminDiagnosticsRoutes(app);
  registerAdminContactRoutes(app);
  registerAdminReleaseRoutes(app, { audit });
  registerAdminRuntimePackRoutes(app, { audit });
  registerAdminSkillPackageRoutes(app, { audit });
  registerAdminWorkspaceAppRoutes(app, { audit });
  registerAdminWishRoutes(app, { audit });
  registerAdminModelProviderRoutes(app, { audit });
  registerAdminConfigGroupRoutes(app, { audit });
  registerAdminConfigProfileRoutes(app, { audit });
  registerAdminAuditRoutes(app);
  registerAdminBillingRoutes(app, { audit });
  registerAdminEnterpriseRoutes(app, { audit });
}
