import { z } from "zod";
import { zodBody, okResponse } from "../../openapi.js";
import { db } from "../../db.js";
import { requireSignedDeviceRequest, upsertDevice } from "../../services/device-identity.js";

export const UPDATE_STAGES = ["download_started", "downloaded", "download_failed", "install_started"];

const updateEventSchema = z.object({
  deviceId: z.string().min(6).max(120),
  fingerprintHash: z.string().max(160).optional().nullable(),
  platform: z.string().max(40).optional().nullable(),
  arch: z.string().max(40).optional().nullable(),
  appVersion: z.string().max(40).optional().nullable(),
  publicKey: z.string().max(2000).optional().nullable(),
  keyAlg: z.string().max(40).optional().nullable(),
  toVersion: z.string().min(1).max(40),
  stage: z.enum(UPDATE_STAGES),
  errorCode: z.string().max(80).optional().nullable(),
});

export function registerPublicUpdateEventRoutes(app) {
  app.post(
    "/api/updates/events",
    {
      schema: {
        tags: ["public:releases"],
        summary: "Report how far an update got on a device",
        description: "One row per device × target version × stage (repeats are ignored), so each rollout can show where updates stall.",
        body: zodBody(updateEventSchema),
        response: { 200: okResponse({}) },
      },
    },
    async (request, reply) => {
      const input = updateEventSchema.parse(request.body);
      await upsertDevice(input);
      if (!(await requireSignedDeviceRequest(request, reply, input))) return;
      await db.insertInto("update_events").values({
        device_id: input.deviceId,
        platform: [input.platform, input.arch].filter(Boolean).join("-") || "unknown",
        from_version: input.appVersion || null,
        to_version: input.toVersion,
        stage: input.stage,
        error_code: input.errorCode || null,
      }).onConflict((oc) => oc.columns(["device_id", "to_version", "stage"]).doNothing()).execute();
      return { ok: true };
    },
  );
}
