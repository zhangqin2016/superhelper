import { z } from "zod";
import { zodBody, okResponse } from "../../openapi.js";
import { db } from "../../db.js";
import { publicId } from "../../services/ids.js";
import { requireSignedDeviceRequest, upsertDevice } from "../../services/device-identity.js";
import { usageDateKey } from "../../services/usage-date.js";

const registerDeviceSchema = z.object({
  deviceId: z.string().min(6).max(120),
  fingerprintHash: z.string().max(160).optional().nullable(),
  platform: z.string().max(40).optional().nullable(),
  arch: z.string().max(40).optional().nullable(),
  appVersion: z.string().max(40).optional().nullable(),
  publicKey: z.string().max(2000).optional().nullable(),
  keyAlg: z.string().max(40).optional().nullable(),
});

const usageSchema = z.object({
  deviceId: z.string().min(6).max(120),
  licenseId: z.string().max(80).optional().nullable(),
  fingerprintHash: z.string().max(160).optional().nullable(),
  platform: z.string().max(40).optional().nullable(),
  arch: z.string().max(40).optional().nullable(),
  appVersion: z.string().max(40).optional().nullable(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  model: z.string().min(1).max(120),
  providerID: z.string().max(200).optional().nullable(),
  reportId: z.string().min(1).max(120).optional().nullable(),
  messageCount: z.number().int().min(0).default(0),
  imageCount: z.number().int().min(0).default(0),
  toolCallCount: z.number().int().min(0).default(0),
  pluginCallCount: z.number().int().min(0).default(0),
  inputTokens: z.number().int().min(0).default(0),
  outputTokens: z.number().int().min(0).default(0),
});

const usageSummarySchema = registerDeviceSchema.extend({
  historyDays: z.number().int().min(1).max(90).optional().default(30),
});

const skillEventSchema = registerDeviceSchema.extend({
  licenseId: z.string().max(80).optional().nullable(),
  eventType: z.enum(["install", "update", "uninstall", "enable", "disable"]),
  skillId: z.string().min(1).max(160),
  skillVersion: z.string().max(80).optional().nullable(),
  metadata: z.record(z.any()).optional().default({}),
});

const runtimeDiagnosticSchema = registerDeviceSchema.extend({
  licenseId: z.string().max(80).optional().nullable(),
  claudeVersion: z.string().max(80).optional().nullable(),
  eventType: z.string().max(120).optional().nullable(),
  eventSubtype: z.string().max(120).optional().nullable(),
  normalizedKind: z.string().max(120).optional().nullable(),
  severity: z.enum(["info", "warning", "error"]).default("warning"),
  turnPhase: z.string().max(80).optional().nullable(),
  sessionState: z.string().max(80).optional().nullable(),
  summary: z.string().max(1000).optional().nullable(),
  trace: z.record(z.any()).optional().default({}),
});

export function registerPublicTelemetryRoutes(app) {
  app.post(
    "/api/usage/report",
    {
      schema: {
        tags: ["public:telemetry"],
        summary: "Report daily usage counters",
        description:
          "Upserts per-device, per-day, per-provider/model usage counters. Missing providerID is unknown; reportId deduplicates retries.",
        body: zodBody(usageSchema),
        response: { 200: okResponse() },
      },
    },
    async (request, reply) => {
    const input = usageSchema.parse(request.body);
    await upsertDevice(input);
    if (!(await requireSignedDeviceRequest(request, reply, input))) return;
    await db.transaction().execute(async (trx) => {
      if (input.reportId) {
        const receipt = await trx
          .insertInto("usage_report_receipts")
          .values({ device_id: input.deviceId, report_id: input.reportId })
          .onConflict((oc) => oc.columns(["device_id", "report_id"]).doNothing())
          .returning("report_id")
          .executeTakeFirst();
        if (!receipt) return;
      }
      // Keep old-server/UI totals and provider detail in one receipt transaction.
      for (const table of ["usage_daily", "usage_provider_daily"]) {
        const providerScoped = table === "usage_provider_daily";
        await trx
          .insertInto(table)
          .values({
            usage_date: input.date,
            license_id: input.licenseId || null,
            device_id: input.deviceId,
            ...(providerScoped ? { provider_id: input.providerID || "unknown" } : {}),
            model: input.model,
            message_count: input.messageCount,
            image_count: input.imageCount,
            tool_call_count: input.toolCallCount,
            plugin_call_count: input.pluginCallCount,
            input_tokens: input.inputTokens,
            output_tokens: input.outputTokens,
          })
          .onConflict((oc) =>
            oc.columns(providerScoped
              ? ["usage_date", "device_id", "provider_id", "model"]
              : ["usage_date", "device_id", "model"]).doUpdateSet((eb) => ({
              license_id: input.licenseId || null,
              message_count: eb(`${table}.message_count`, "+", input.messageCount),
              image_count: eb(`${table}.image_count`, "+", input.imageCount),
              tool_call_count: eb(`${table}.tool_call_count`, "+", input.toolCallCount),
              plugin_call_count: eb(`${table}.plugin_call_count`, "+", input.pluginCallCount),
              input_tokens: eb(`${table}.input_tokens`, "+", input.inputTokens),
              output_tokens: eb(`${table}.output_tokens`, "+", input.outputTokens),
              updated_at: new Date(),
            })),
          )
          .execute();
      }
    });
    return reply.send({ ok: true });
  });

  app.post(
    "/api/usage/summary",
    {
      schema: {
        tags: ["public:telemetry"],
        summary: "Get a device's usage summary",
        description:
          "Returns aggregated daily token and message counts for the device over the requested history window.",
        body: zodBody(usageSummarySchema),
        response: {
          200: okResponse({
            deviceId: { type: "string" },
            historyDays: { type: "integer" },
            days: { type: "array", items: { type: "object" } },
            byModel: { type: "array", items: { type: "object" } },
          }),
        },
      },
    },
    async (request, reply) => {
    const input = usageSummarySchema.parse(request.body);
    await upsertDevice(input);
    if (!(await requireSignedDeviceRequest(request, reply, input))) return;
    const historyDays = Math.min(input.historyDays || 30, 90);
    const since = new Date(Date.now() - historyDays * 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10);

    const rows = await db
      .selectFrom("usage_daily")
      .select((eb) => [
        "usage_date",
        eb.fn.sum("input_tokens").as("input_tokens"),
        eb.fn.sum("output_tokens").as("output_tokens"),
        eb.fn.sum("message_count").as("message_count"),
      ])
      .where("device_id", "=", input.deviceId)
      .where("usage_date", ">=", since)
      .groupBy("usage_date")
      .orderBy("usage_date", "desc")
      .execute();

    const byModel = await db
      .selectFrom("usage_provider_breakdown")
      .select(["usage_date", "provider_id", "model", "input_tokens", "output_tokens", "message_count"])
      .where("device_id", "=", input.deviceId)
      .where("usage_date", ">=", since)
      .orderBy("usage_date", "desc")
      .orderBy("provider_id", "asc")
      .orderBy("model", "asc")
      .execute();

    return reply.send({
      ok: true,
      deviceId: input.deviceId,
      historyDays,
      byModel: byModel.map((row) => ({
        date: usageDateKey(row.usage_date),
        providerID: row.provider_id,
        model: row.model,
        inputTokens: Number(row.input_tokens || 0),
        outputTokens: Number(row.output_tokens || 0),
        messageCount: Number(row.message_count || 0),
      })),
      days: rows.map((row) => ({
        date: usageDateKey(row.usage_date),
        inputTokens: Number(row.input_tokens || 0),
        outputTokens: Number(row.output_tokens || 0),
        messageCount: Number(row.message_count || 0),
      })),
    });
  });

  app.post(
    "/api/skills/events",
    {
      schema: {
        tags: ["public:telemetry"],
        summary: "Record a skill lifecycle event",
        description:
          "Stores a skill install/update/uninstall/enable/disable event reported by a device.",
        body: zodBody(skillEventSchema),
        response: { 200: okResponse() },
      },
    },
    async (request, reply) => {
    const input = skillEventSchema.parse(request.body);
    await upsertDevice(input);
    if (!(await requireSignedDeviceRequest(request, reply, input))) return;
    await db
      .insertInto("skill_events")
      .values({
        event_type: input.eventType,
        skill_id: input.skillId,
        skill_version: input.skillVersion || null,
        license_id: input.licenseId || null,
        device_id: input.deviceId,
        app_version: input.appVersion || null,
        metadata: input.metadata || {},
      })
      .execute();
    return reply.send({ ok: true });
  });

  app.post(
    "/api/diagnostics/runtime-traces",
    {
      schema: {
        tags: ["public:telemetry"],
        summary: "Submit a runtime diagnostic trace",
        description:
          "Persists a runtime diagnostic/trace event from a device and returns its generated id.",
        body: zodBody(runtimeDiagnosticSchema),
        response: { 201: okResponse({ id: { type: "string" } }) },
      },
    },
    async (request, reply) => {
    const input = runtimeDiagnosticSchema.parse(request.body);
    await upsertDevice(input);
    if (!(await requireSignedDeviceRequest(request, reply, input))) return;
    const id = publicId("diag");
    await db
      .insertInto("runtime_diagnostics")
      .values({
        id,
        device_id: input.deviceId,
        license_id: input.licenseId || null,
        app_version: input.appVersion || null,
        platform: input.platform || null,
        arch: input.arch || null,
        claude_version: input.claudeVersion || null,
        event_type: input.eventType || null,
        event_subtype: input.eventSubtype || null,
        normalized_kind: input.normalizedKind || null,
        severity: input.severity,
        turn_phase: input.turnPhase || null,
        session_state: input.sessionState || null,
        summary: input.summary || null,
        trace: input.trace || {},
      })
      .execute();
    return reply.code(201).send({ ok: true, id });
  });
}
