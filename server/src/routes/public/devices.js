import { z } from "zod";
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
  app.post("/api/devices/register", async (request, reply) => {
    const input = registerDeviceSchema.parse(request.body);
    const device = await upsertDevice(input);
    await upsertDevicePublicKey(input);
    return reply.send({ ok: true, trial: trialPayload(device) });
  });

  app.post("/api/devices/rotate-key", async (request, reply) => {
    const input = rotateDeviceKeySchema.parse(request.body);
    await upsertDevice(input);
    if (!(await requireSignedDeviceRequest(request, reply, input))) return;
    await setDevicePublicKey(input.deviceId, input.newPublicKey, input.newKeyAlg || "ed25519");
    return reply.send({ ok: true, deviceId: input.deviceId, keyAlg: input.newKeyAlg || "ed25519" });
  });
}
