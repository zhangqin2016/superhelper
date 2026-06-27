import { z } from "zod";
import { db } from "../../db.js";
import { zodBody, okResponse } from "../../openapi.js";
import { encryptSecret } from "../../services/security.js";
import { ensureEnvManagedConfigProfile } from "../../services/client-config.js";
import {
  listModelGatewayProviders,
  refreshModelGatewayProviders,
} from "../../services/model-gateway/providers.js";

// Operator-managed model gateway providers. The API key is stored encrypted and
// never returned to the browser; the /llm gateway uses it server-side and the
// client only ever gets a short-lived token.
const providerSchema = z.object({
  id: z.string().min(2).max(80).regex(/^[a-z0-9._-]+$/i),
  label: z.string().max(160).optional().default(""),
  type: z.enum(["anthropic", "openai", "vision", "search"]).default("anthropic"),
  baseUrl: z.string().max(400).optional().default(""),
  apiKey: z.string().max(2000).optional(), // omitted/empty on update = keep existing
  defaultModel: z.string().max(160).optional().default(""),
  models: z.array(z.string().max(160)).max(100).optional().default([]),
  headers: z.record(z.string().max(2000)).optional().default({}),
  enabled: z.boolean().default(true),
});

export function registerAdminModelProviderRoutes(app, { audit }) {
  app.get(
    "/api/admin/model-providers",
    {
      schema: {
        tags: ["admin:model-providers"],
        summary: "List model gateway providers",
        description:
          "Lists DB-configured providers (without keys) plus the merged env+DB list the gateway can route.",
        response: {
          200: okResponse({
            providers: { type: "array", items: { type: "object" } },
            gateway: { type: "array", items: { type: "object" } },
          }),
        },
      },
    },
    async () => {
    const rows = await db
      .selectFrom("model_gateway_providers")
      .select([
        "id",
        "label",
        "type",
        "base_url",
        "default_model",
        "models",
        "headers",
        "enabled",
        "updated_at",
        "api_key_encrypted",
      ])
      .orderBy("id", "asc")
      .limit(300)
      .execute();
    const dbIds = new Set(rows.map((row) => String(row.id)));
    // The merged env+DB list the gateway can actually route — this is what the
    // config-profile form should offer as selectable providers. Never leak keys.
    const gateway = Object.values(listModelGatewayProviders()).map((provider) => ({
      id: provider.id,
      label: provider.label || provider.id,
      type: provider.type,
      baseUrl: provider.baseUrl,
      default_model: provider.model || "",
      models: provider.models || [],
      hasApiKey: Boolean(provider.apiKey),
      source: dbIds.has(String(provider.id)) ? "db" : "env",
    }));
    // Never leak the key; expose only whether one is set.
    return {
      providers: rows.map(({ api_key_encrypted, ...row }) => ({
        ...row,
        hasApiKey: Boolean(api_key_encrypted),
      })),
      gateway,
    };
  });

  app.post(
    "/api/admin/model-providers",
    {
      schema: {
        tags: ["admin:model-providers"],
        summary: "Create or update a model gateway provider",
        description:
          "Upserts a provider, encrypting the API key (kept if omitted) and refreshing the gateway.",
        body: zodBody(providerSchema),
        response: { 201: okResponse({ id: { type: "string" } }) },
      },
    },
    async (request, reply) => {
    const input = providerSchema.parse(request.body);
    const existing = await db
      .selectFrom("model_gateway_providers")
      .select("api_key_encrypted")
      .where("id", "=", input.id)
      .executeTakeFirst();
    const apiKeyEncrypted =
      input.apiKey !== undefined && input.apiKey !== ""
        ? encryptSecret(input.apiKey)
        : existing?.api_key_encrypted || "";
    const values = {
      id: input.id,
      label: input.label || input.id,
      type: input.type,
      base_url: input.baseUrl || "",
      api_key_encrypted: apiKeyEncrypted,
      default_model: input.defaultModel || "",
      models: JSON.stringify(input.models || []),
      headers: JSON.stringify(input.headers || {}),
      enabled: input.enabled,
      updated_at: new Date(),
    };
    await db
      .insertInto("model_gateway_providers")
      .values(values)
      .onConflict((oc) =>
        oc.column("id").doUpdateSet({
          label: values.label,
          type: values.type,
          base_url: values.base_url,
          api_key_encrypted: values.api_key_encrypted,
          default_model: values.default_model,
          models: values.models,
          headers: values.headers,
          enabled: values.enabled,
          updated_at: values.updated_at,
        }),
      )
      .execute();
    await refreshModelGatewayProviders();
    await ensureEnvManagedConfigProfile();
    await audit(request, "model_provider.upsert", "model_provider", input.id, {
      type: input.type,
      baseUrl: input.baseUrl || "",
      keyChanged: input.apiKey !== undefined && input.apiKey !== "",
      enabled: input.enabled,
    });
    return reply.code(201).send({ ok: true, id: input.id });
  });

  app.delete(
    "/api/admin/model-providers/:id",
    {
      schema: {
        tags: ["admin:model-providers"],
        summary: "Delete a model gateway provider",
        description: "Deletes a provider and refreshes the gateway provider list.",
        response: { 200: okResponse({ id: { type: "string" } }) },
      },
    },
    async (request) => {
    await db.deleteFrom("model_gateway_providers").where("id", "=", request.params.id).execute();
    await refreshModelGatewayProviders();
    await ensureEnvManagedConfigProfile();
    await audit(request, "model_provider.delete", "model_provider", request.params.id);
    return { ok: true, id: request.params.id };
  });
}
