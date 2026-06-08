import { z } from "zod";
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

const pluginEventSchema = registerDeviceSchema.extend({
  licenseId: z.string().max(80).optional().nullable(),
  eventType: z.enum(["install", "update", "uninstall", "enable", "disable"]),
  pluginId: z.string().min(1).max(160),
  pluginVersion: z.string().max(80).optional().nullable(),
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
  app.post("/api/usage/report", async (request, reply) => {
    const input = usageSchema.parse(request.body);
    await upsertDevice(input);
    if (!(await requireSignedDeviceRequest(request, reply, input))) return;
    await db
      .insertInto("usage_daily")
      .values({
        usage_date: input.date,
        license_id: input.licenseId || null,
        device_id: input.deviceId,
        model: input.model,
        message_count: input.messageCount,
        image_count: input.imageCount,
        tool_call_count: input.toolCallCount,
        plugin_call_count: input.pluginCallCount,
        input_tokens: input.inputTokens,
        output_tokens: input.outputTokens,
      })
      .onConflict((oc) =>
        oc.columns(["usage_date", "device_id", "model"]).doUpdateSet((eb) => ({
          license_id: input.licenseId || null,
          message_count: eb("usage_daily.message_count", "+", input.messageCount),
          image_count: eb("usage_daily.image_count", "+", input.imageCount),
          tool_call_count: eb("usage_daily.tool_call_count", "+", input.toolCallCount),
          plugin_call_count: eb("usage_daily.plugin_call_count", "+", input.pluginCallCount),
          input_tokens: eb("usage_daily.input_tokens", "+", input.inputTokens),
          output_tokens: eb("usage_daily.output_tokens", "+", input.outputTokens),
          updated_at: new Date(),
        })),
      )
      .execute();
    return reply.send({ ok: true });
  });

  app.post("/api/usage/summary", async (request, reply) => {
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

    return reply.send({
      ok: true,
      deviceId: input.deviceId,
      historyDays,
      days: rows.map((row) => ({
        date: usageDateKey(row.usage_date),
        inputTokens: Number(row.input_tokens || 0),
        outputTokens: Number(row.output_tokens || 0),
        messageCount: Number(row.message_count || 0),
      })),
    });
  });

  app.post("/api/plugins/events", async (request, reply) => {
    const input = pluginEventSchema.parse(request.body);
    await upsertDevice(input);
    if (!(await requireSignedDeviceRequest(request, reply, input))) return;
    await db
      .insertInto("plugin_events")
      .values({
        event_type: input.eventType,
        plugin_id: input.pluginId,
        plugin_version: input.pluginVersion || null,
        license_id: input.licenseId || null,
        device_id: input.deviceId,
        app_version: input.appVersion || null,
        metadata: input.metadata || {},
      })
      .execute();
    return reply.send({ ok: true });
  });

  app.post("/api/diagnostics/runtime-traces", async (request, reply) => {
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
