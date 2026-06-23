import { z } from "zod";
import { zodBody, okResponse } from "../../openapi.js";
import {
  requireSignedDeviceRequest,
  setDevicePublicKey,
  trialPayload,
  upsertDevice,
  upsertDevicePublicKey,
} from "../../services/device-identity.js";

export const registerDeviceSchema = z.object({
  deviceId: z.string().min(6).max(120),
  fingerprintHash: z.string().max(160).optional().nullable(),
  platform: z.string().max(40).optional().nullable(),
  arch: z.string().max(40).optional().nullable(),
  appVersion: z.string().max(40).optional().nullable(),
  publicKey: z.string().max(2000).optional().nullable(),
  keyAlg: z.string().max(40).optional().nullable(),
});

const rotateDeviceKeySchema = registerDeviceSchema.extend({
  newPublicKey: z.string().min(80).max(2000),
  newKeyAlg: z.string().max(40).optional().nullable(),
});

export function registerPublicDeviceRoutes(app) {
  app.post(
    "/api/devices/register",
    {
      schema: {
        tags: ["public:devices"],
        summary: "Register or upsert a device",
        description: "Upserts the device record and public key, returning trial status.",
        body: zodBody(registerDeviceSchema),
        response: { 200: okResponse({ trial: { type: "object" } }) },
      },
    },
    async (request, reply) => {
    const input = registerDeviceSchema.parse(request.body);
    const device = await upsertDevice(input);
    await upsertDevicePublicKey(input);
    return reply.send({ ok: true, trial: trialPayload(device) });
  });

  app.post(
    "/api/devices/rotate-key",
    {
      schema: {
        tags: ["public:devices"],
        summary: "Rotate a device's public key",
        description: "Verifies the signed request then replaces the device's public key.",
        body: zodBody(rotateDeviceKeySchema),
        response: {
          200: okResponse({
            deviceId: { type: "string" },
            keyAlg: { type: "string" },
          }),
        },
      },
    },
    async (request, reply) => {
    const input = rotateDeviceKeySchema.parse(request.body);
    await upsertDevice(input);
    if (!(await requireSignedDeviceRequest(request, reply, input))) return;
    await setDevicePublicKey(input.deviceId, input.newPublicKey, input.newKeyAlg || "ed25519");
    return reply.send({ ok: true, deviceId: input.deviceId, keyAlg: input.newKeyAlg || "ed25519" });
  });
}
