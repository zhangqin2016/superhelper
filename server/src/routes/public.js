import { publicCatalogRoutes } from "./public/catalog.js";
import { registerPublicClientConfigRoutes } from "./public/client-config.js";
import { registerPublicDeviceRoutes } from "./public/devices.js";
import { registerPublicLicenseRoutes } from "./public/licenses.js";
import { registerPublicTelemetryRoutes } from "./public/telemetry.js";

export async function publicRoutes(app) {
  app.get("/health", async () => ({ ok: true }));
  await app.register(publicCatalogRoutes);
  registerPublicClientConfigRoutes(app);
  registerPublicDeviceRoutes(app);
  registerPublicLicenseRoutes(app);
  registerPublicTelemetryRoutes(app);
}
