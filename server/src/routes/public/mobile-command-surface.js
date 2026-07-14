import { z } from "zod";
import { zodBody, okResponse } from "../../openapi.js";
import {
  disabledCapability,
  mobileCapabilitiesPayload,
  sendDisabledCapability,
} from "../../services/mobile-command-capabilities.js";
import { createMobileFileTransferService } from "../../services/mobile-command-file-transfer.js";
import { createMobileRemoteSessionService } from "../../services/mobile-command-remote-session.js";

const deviceBase = {
  deviceId: z.string().min(6).max(120),
  fingerprintHash: z.string().max(160).optional().nullable(),
  platform: z.string().max(40).optional().nullable(),
  appVersion: z.string().max(40).optional().nullable(),
};

const remoteSessionSchema = z.object({
  ...deviceBase,
  grantId: z.string().min(6).max(120),
  lilySessionId: z.string().min(1).max(160).optional(),
  clientProtocolVersion: z.number().int().min(1).max(1).default(1),
});
const remoteSessionRefreshSchema = z.object({ ...deviceBase, grantId: z.string().min(6).max(120).optional() });
const permissionRequestSchema = z.object({
  ...deviceBase,
  level: z.enum(["chat", "observe", "control", "clipboard"]).default("chat"),
  reason: z.string().max(240).optional(),
});
const turnCredentialSchema = z.object({ ...deviceBase, generation: z.string().max(120).optional() });
const uploadCreateSchema = z.object({
  ...deviceBase,
  grantId: z.string().min(6).max(120),
  lilySessionId: z.string().min(1).max(160),
  fileName: z.string().min(1).max(240),
  sizeBytes: z.number().int().min(1).max(524288000),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  chunkCount: z.number().int().min(1).max(100000).optional(),
});
const uploadChunkSchema = z.object({ ...deviceBase, bytesBase64: z.string().min(1), sha256: z.string().regex(/^[a-f0-9]{64}$/).optional() });
const uploadCompleteSchema = z.object({ ...deviceBase, sha256: z.string().regex(/^[a-f0-9]{64}$/) });
const artifactRequestSchema = z.object({ ...deviceBase, grantId: z.string().min(6).max(120).optional() });
const pushTokenSchema = z.object({ ...deviceBase, pushToken: z.string().min(16).max(4096).optional(), environment: z.enum(["sandbox", "production"]).optional() });
const diagnosticsSchema = z.object({ ...deviceBase, consent: z.literal(true).optional(), categories: z.array(z.enum(["network", "signaling", "upload", "lifecycle", "app"])).max(8).optional() });

const defaultFileTransfer = createMobileFileTransferService();
const defaultRemoteSessions = createMobileRemoteSessionService();

function remoteSessionHttpStatus(result) {
  if (result.ok) return 200;
  if (result.code === "MC-ERR-PROTOCOL-CLIENT-UPGRADE-REQUIRED") return 426;
  if (result.code === "MC-ERR-PERMISSION-DENIED") return 403;
  if (result.code === "MC-ERR-SESSION-NOT-FOUND") return 404;
  if (result.code === "MC-ERR-SESSION-ENDED") return 410;
  return 400;
}

export function registerMobileCommandSurfaceRoutes(app, { fileTransfer = defaultFileTransfer, remoteSessions = defaultRemoteSessions, capabilityFlags = {} } = {}) {
  function currentCapability(name) {
    return mobileCapabilitiesPayload({ flags: capabilityFlags }).capabilities[name];
  }

  function sendIfConfiguredOff(reply, name) {
    const capability = currentCapability(name);
    if (capability?.enabled !== false || capability.code !== "MC-ERR-CONFIG-FEATURE-DISABLED") return false;
    reply.code(403).send(disabledCapability(name, capability));
    return true;
  }

  app.get(
    "/api/mobile/capabilities",
    {
      schema: {
        tags: ["public:mobile"],
        summary: "Describe Mobile Command capability availability",
        response: { 200: okResponse({ capabilities: { type: "object", additionalProperties: true } }) },
      },
    },
    async () => mobileCapabilitiesPayload({ flags: capabilityFlags }),
  );

  app.post(
    "/api/mobile/sessions",
    { schema: { tags: ["public:mobile"], summary: "Create a Mobile Command remote session", body: zodBody(remoteSessionSchema), response: { 200: okResponse({ remoteSession: { type: "object", additionalProperties: true } }) } } },
    async (request, reply) => {
      if (sendIfConfiguredOff(reply, "remoteSessions")) return;
      const input = remoteSessionSchema.parse(request.body || {});
      const result = remoteSessions.createSession(input);
      if (!result.ok) return reply.code(remoteSessionHttpStatus(result)).send(result);
      return reply.send(result);
    },
  );

  app.post(
    "/api/mobile/sessions/:remoteSessionId/refresh",
    { schema: { tags: ["public:mobile"], summary: "Refresh a Mobile Command remote session", body: zodBody(remoteSessionRefreshSchema), response: { 200: okResponse({ remoteSession: { type: "object", additionalProperties: true } }) } } },
    async (request, reply) => {
      if (sendIfConfiguredOff(reply, "remoteSessions")) return;
      const input = remoteSessionRefreshSchema.parse(request.body || {});
      const result = remoteSessions.refreshSession({ ...input, remoteSessionId: request.params?.remoteSessionId });
      if (!result.ok) return reply.code(remoteSessionHttpStatus(result)).send(result);
      return reply.send(result);
    },
  );

  app.delete(
    "/api/mobile/sessions/:remoteSessionId",
    { schema: { tags: ["public:mobile"], summary: "End a Mobile Command remote session", body: zodBody(remoteSessionRefreshSchema), response: { 200: okResponse({ remoteSession: { type: "object", additionalProperties: true } }) } } },
    async (request, reply) => {
      if (sendIfConfiguredOff(reply, "remoteSessions")) return;
      const input = remoteSessionRefreshSchema.parse(request.body || {});
      const result = remoteSessions.endSession({ ...input, remoteSessionId: request.params?.remoteSessionId });
      if (!result.ok) return reply.code(remoteSessionHttpStatus(result)).send(result);
      return reply.send(result);
    },
  );

  app.post(
    "/api/mobile/sessions/:remoteSessionId/permissions",
    { schema: { tags: ["public:mobile"], summary: "Request observe/control/clipboard permission", body: zodBody(permissionRequestSchema), response: { 501: okResponse({ code: { type: "string" } }) } } },
    async (_request, reply) => sendDisabledCapability(reply, "observeControl"),
  );

  app.post(
    "/api/mobile/sessions/:remoteSessionId/turn-credentials",
    { schema: { tags: ["public:mobile"], summary: "Issue short-lived TURN credentials", body: zodBody(turnCredentialSchema), response: { 501: okResponse({ code: { type: "string" } }) } } },
    async (_request, reply) => sendDisabledCapability(reply, "turnCredentials"),
  );

  app.post(
    "/api/mobile/uploads",
    { schema: { tags: ["public:mobile"], summary: "Create a Mobile Command upload", body: zodBody(uploadCreateSchema), response: { 200: okResponse({ upload: { type: "object", additionalProperties: true } }) } } },
    async (request, reply) => {
      if (sendIfConfiguredOff(reply, "uploads")) return;
      const input = uploadCreateSchema.parse(request.body || {});
      const result = fileTransfer.createUpload({
        ...input,
        idempotencyKey: request.headers?.["idempotency-key"] || request.headers?.["Idempotency-Key"] || input.idempotencyKey || `${input.deviceId}:${input.sha256}`,
      });
      if (!result.ok) return reply.code(result.code === "MC-ERR-UPLOAD-TOO-LARGE" ? 413 : 409).send(result);
      return reply.send(result);
    },
  );

  app.put(
    "/api/mobile/uploads/:uploadId/chunks/:chunkIndex",
    { schema: { tags: ["public:mobile"], summary: "Upload a Mobile Command chunk", body: zodBody(uploadChunkSchema), response: { 200: okResponse({ upload: { type: "object", additionalProperties: true } }) } } },
    async (request, reply) => {
      if (sendIfConfiguredOff(reply, "uploads")) return;
      const input = uploadChunkSchema.parse(request.body || {});
      const result = fileTransfer.putChunk({
        uploadId: request.params?.uploadId,
        chunkIndex: Number(request.params?.chunkIndex),
        bytes: Buffer.from(input.bytesBase64, "base64"),
        sha256: input.sha256,
      });
      if (!result.ok) return reply.code(result.code === "MC-ERR-UPLOAD-CHUNK-HASH-MISMATCH" ? 422 : 409).send(result);
      return reply.send(result);
    },
  );

  app.post(
    "/api/mobile/uploads/:uploadId/complete",
    { schema: { tags: ["public:mobile"], summary: "Complete a Mobile Command upload", body: zodBody(uploadCompleteSchema), response: { 200: okResponse({ upload: { type: "object", additionalProperties: true }, artifact: { type: "object", additionalProperties: true } }) } } },
    async (request, reply) => {
      if (sendIfConfiguredOff(reply, "uploads")) return;
      const input = uploadCompleteSchema.parse(request.body || {});
      const result = fileTransfer.completeUpload({ uploadId: request.params?.uploadId, sha256: input.sha256 });
      if (!result.ok) return reply.code(result.code === "MC-ERR-UPLOAD-FILE-HASH-MISMATCH" ? 422 : 409).send(result);
      return reply.send(result);
    },
  );

  app.get(
    "/api/mobile/uploads/:uploadId",
    { schema: { tags: ["public:mobile"], summary: "Get Mobile Command upload status", response: { 200: okResponse({ upload: { type: "object", additionalProperties: true } }) } } },
    async (request, reply) => {
      if (sendIfConfiguredOff(reply, "uploads")) return;
      const result = fileTransfer.getUpload(request.params?.uploadId);
      if (!result.ok) return reply.code(404).send(result);
      return reply.send(result);
    },
  );

  app.get(
    "/api/mobile/artifacts/:artifactId",
    { schema: { tags: ["public:mobile"], summary: "Resolve a Mobile Command artifact descriptor", response: { 200: okResponse({ artifact: { type: "object", additionalProperties: true } }) } } },
    async (request, reply) => {
      if (sendIfConfiguredOff(reply, "artifacts")) return;
      const result = fileTransfer.getArtifact(request.params?.artifactId);
      if (!result.ok) return reply.code(404).send(result);
      return reply.send(result);
    },
  );

  app.post(
    "/api/mobile/artifacts/:artifactId/download",
    { schema: { tags: ["public:mobile"], summary: "Create a Mobile Command artifact download token", body: zodBody(artifactRequestSchema), response: { 200: okResponse({ artifact: { type: "object", additionalProperties: true }, downloadUrl: { type: "string" }, expiresAt: { type: "number" } }) } } },
    async (request, reply) => {
      if (sendIfConfiguredOff(reply, "artifacts")) return;
      artifactRequestSchema.parse(request.body || {});
      const result = fileTransfer.createArtifactDownload({ artifactId: request.params?.artifactId });
      if (!result.ok) return reply.code(404).send(result);
      return reply.send(result);
    },
  );

  app.get(
    "/api/mobile/artifacts/:artifactId/content",
    { schema: { tags: ["public:mobile"], summary: "Fetch Mobile Command artifact bytes", response: { 501: okResponse({ code: { type: "string" } }) } } },
    async (_request, reply) => sendDisabledCapability(reply, "artifactContent"),
  );

  app.post(
    "/api/mobile/push-token",
    { schema: { tags: ["public:mobile"], summary: "Register a Mobile Command push token", body: zodBody(pushTokenSchema), response: { 501: okResponse({ code: { type: "string" } }) } } },
    async (_request, reply) => sendDisabledCapability(reply, "push"),
  );

  app.delete(
    "/api/mobile/push-token",
    { schema: { tags: ["public:mobile"], summary: "Unregister a Mobile Command push token", body: zodBody(pushTokenSchema), response: { 501: okResponse({ code: { type: "string" } }) } } },
    async (_request, reply) => sendDisabledCapability(reply, "push"),
  );

  app.post(
    "/api/mobile/diagnostics",
    { schema: { tags: ["public:mobile"], summary: "Create a redacted Mobile Command diagnostics bundle", body: zodBody(diagnosticsSchema), response: { 501: okResponse({ code: { type: "string" } }) } } },
    async (_request, reply) => sendDisabledCapability(reply, "diagnostics"),
  );
}
