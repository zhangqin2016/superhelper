import { publicCatalogRoutes } from "./public/catalog.js";
import { registerPublicAccountRoutes } from "./public/account.js";
import { registerPublicAuthRoutes } from "./public/auth.js";
import { registerPublicBillingRoutes } from "./public/billing.js";
import { registerPublicWorkspaceAppRoutes } from "./public/apps.js";
import { registerPublicClientConfigRoutes } from "./public/client-config.js";
import { registerPublicDeviceRoutes } from "./public/devices.js";
import { registerPublicLicenseRoutes } from "./public/licenses.js";
import { registerPublicSkillRoutes } from "./public/skills.js";
import { registerPublicTelemetryRoutes } from "./public/telemetry.js";
import { okResponse } from "../openapi.js";

export async function publicRoutes(app) {
  app.get(
    "/health",
    {
      schema: {
        tags: ["public:health"],
        summary: "Liveness probe",
        response: { 200: okResponse() },
      },
    },
    async () => ({ ok: true }),
  );
  registerPublicAuthRoutes(app);
  registerPublicAccountRoutes(app);
  registerPublicBillingRoutes(app);
  await app.register(publicCatalogRoutes);
  registerPublicWorkspaceAppRoutes(app);
  registerPublicClientConfigRoutes(app);
  registerPublicDeviceRoutes(app);
  registerPublicLicenseRoutes(app);
  registerPublicSkillRoutes(app);
  registerPublicTelemetryRoutes(app);
}
