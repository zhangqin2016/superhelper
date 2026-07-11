import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import { z } from "zod";
import { config } from "./config.js";

// OpenAPI tag groups. Every route's `schema.tags` MUST be one of these so the
// Swagger UI stays organised by surface + resource. See docs/api-documentation-standard.md.
export const OPENAPI_TAGS = [
  { name: "public:health", description: "Liveness probe" },
  { name: "public:auth", description: "User account authentication" },
  { name: "public:account", description: "User account entitlements" },
  { name: "public:billing", description: "User billing and products" },
  { name: "public:catalog", description: "Public skill/app catalog" },
  { name: "public:contacts", description: "Public contact / support requests" },
  { name: "public:releases", description: "Public app release feed" },
  { name: "public:runtime-packs", description: "Public runtime-pack artifacts" },
  { name: "public:apps", description: "Public workspace-app downloads" },
  { name: "public:client-config", description: "Client runtime configuration" },
  { name: "public:devices", description: "Device registration & key rotation" },
  { name: "public:licenses", description: "License activation & status" },
  { name: "public:skills", description: "Public skill packages" },
  { name: "public:telemetry", description: "Usage / skill / diagnostics reporting" },
  { name: "public:wishes", description: "Public wish pool and account-backed support" },
  { name: "admin:auth", description: "Admin authentication" },
  { name: "admin:billing", description: "Admin billing products and pricing" },
  { name: "admin:summary", description: "Admin dashboard summary" },
  { name: "admin:users", description: "Admin account user operations" },
  { name: "admin:audit", description: "Admin audit log" },
  { name: "admin:config-groups", description: "Admin device/config groups" },
  { name: "admin:config-profiles", description: "Admin config profiles" },
  { name: "admin:contacts", description: "Admin support contacts" },
  { name: "admin:devices", description: "Admin device management" },
  { name: "admin:diagnostics", description: "Admin runtime diagnostics" },
  { name: "admin:licenses", description: "Admin license management" },
  { name: "admin:model-providers", description: "Admin model provider config" },
  { name: "admin:releases", description: "Admin app releases" },
  { name: "admin:runtime-packs", description: "Admin runtime packs" },
  { name: "admin:skill-packages", description: "Admin skill packages" },
  { name: "admin:system", description: "Admin system settings" },
  { name: "admin:usage", description: "Admin usage analytics" },
  { name: "admin:workspace-apps", description: "Admin workspace-app catalog" },
  { name: "admin:wishes", description: "Admin wish moderation and delivery status" },
  { name: "gateway:model", description: "Model gateway (LLM proxy)" },
  { name: "gateway:media", description: "Media generation gateway" },
];

// Route schemas are DOCUMENTATION ONLY. Each handler still validates its input
// with Zod (`.parse()`) and Fastify keeps its default JSON serialization, so the
// schemas we attach for Swagger never change request/response behaviour. We make
// that explicit by installing a pass-through validator + serializer: Fastify only
// invokes these when a route declares a schema, so doc'd routes stay doc-only and
// schemaless routes are unaffected.
export function installDocOnlyCompilers(app) {
  app.setValidatorCompiler(() => () => true);
  app.setSerializerCompiler(() => (data) =>
    typeof data === "string" || Buffer.isBuffer(data) ? data : JSON.stringify(data),
  );
}

export async function registerOpenapi(app) {
  await app.register(swagger, {
    openapi: {
      info: {
        title: "Lily Workbench Server API",
        description:
          "License, device, telemetry, catalog, admin and model/media gateway endpoints. " +
          "Request bodies are documented from the routes' Zod schemas; the Zod `.parse()` " +
          "in each handler remains the source of truth for validation.",
        version: config.version || "0.1.0",
      },
      tags: OPENAPI_TAGS,
    },
  });
  await app.register(swaggerUi, {
    routePrefix: "/docs",
    uiConfig: { docExpansion: "list", deepLinking: true },
  });
}

// Convert a Zod schema to a draft-7 JSON Schema for request-body docs (input side,
// so defaults/optionals reflect what a client sends). Returns undefined if the
// schema can't be represented, so a route still documents summary/tags regardless.
export function zodBody(schema) {
  try {
    return z.toJSONSchema(schema, { target: "draft-7", io: "input", unrepresentable: "any" });
  } catch {
    return undefined;
  }
}

// Standard JSON response envelope used across the API: { ok, ... }.
export const okResponse = (extra = {}) => ({
  type: "object",
  properties: { ok: { type: "boolean" }, ...extra },
  required: ["ok"],
  additionalProperties: true,
});
