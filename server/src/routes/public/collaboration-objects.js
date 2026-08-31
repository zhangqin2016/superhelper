import { z } from "zod";
import { createConfiguredCollaborationObjectService } from "../../services/collaboration/object-config.js";

const id = z.string().min(1).max(200).regex(/^[^\x00-\x20\x7f]+$/);
const command = { deviceId: id.max(120), clientCommandId: id };
const hash = z.string().regex(/^[0-9a-f]{64}$/);
const size = z.number().int().min(1).max(1024 ** 3);
const dek = z.string().length(44).regex(/^[A-Za-z0-9+/]{43}=$/).refine((value) => Buffer.from(value, "base64").toString("base64") === value);
export const objectInitBody = z.object({
  ...command, conversationId: id, purpose: z.enum(["attachment", "workspace"]),
  ciphertextSize: size, ciphertextSha256: hash,
  originalName: z.string().min(1).max(200).regex(/^[^\\/\x00-\x1f\x7f]+$/).refine((value) => value !== "." && value !== ".."),
  mimeType: z.string().min(1).max(100).regex(/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i),
  expiresAt: z.string().datetime({ offset: true }).optional(), dek,
}).strict().refine((value) => value.purpose !== "workspace" || value.ciphertextSize <= 256 * 1024 ** 2);
export const objectCompleteBody = z.object({ ...command, etag: z.string().min(1).max(200), ciphertextSize: size, ciphertextSha256: hash }).strict();
export const objectCommandBody = z.object(command).strict();

const knownErrors = new Set([
  "COLLAB_OBJECT_KEK_UNAVAILABLE", "COLLAB_OBJECT_STORE_UNAVAILABLE", "COLLAB_OBJECT_KEY_INVALID", "COLLAB_OBJECT_METADATA_INVALID",
  "COLLAB_OBJECT_SIZE_INVALID", "COLLAB_OBJECT_UNAVAILABLE", "COLLAB_OBJECT_SHARING_DISABLED", "COLLAB_OBJECT_VERIFICATION_FAILED",
  "COLLAB_COMMAND_IN_PROGRESS", "COLLAB_DEVICE_REVOKED", "COLLAB_CONVERSATION_UNAVAILABLE", "COLLAB_CONVERSATION_FORBIDDEN",
  "COLLAB_ORGANIZATION_ACCESS_REVOKED", "COLLAB_MEMBERSHIP_INACTIVE", "COLLAB_BLOCKED", "COLLAB_AUTHORIZATION_DENIED",
  "COLLAB_FRIENDSHIP_REQUIRED", "COLLAB_PEER_MEMBERSHIP_INACTIVE",
  "IDEMPOTENCY_KEY_REUSED", "COLLAB_TRANSACTION_RETRY", "COLLAB_TRANSACTION_FAILED", "COLLAB_TRANSACTION_RETRY_EXHAUSTED",
]);
// The kernel rethrows native SQLSTATEs after exhausting its bounded retries;
// credential/complete preflight transactions can also throw directly. Match
// only explicit transient codes, never arbitrary provider error text/details.
const transientSqlStates = new Set(["40P01", "40001", "55P03", "57014"]);
function reject(error, request, reply) {
  const transientTransaction = transientSqlStates.has(error?.code);
  const validation = error?.name === "ZodError";
  const tooLarge = error?.code === "FST_ERR_CTP_BODY_TOO_LARGE";
  const parser = typeof error?.code === "string" && error.code.startsWith("FST_ERR_CTP_");
  const code = transientTransaction ? "COLLAB_TRANSACTION_RETRY" : tooLarge ? "COLLAB_OBJECT_REQUEST_TOO_LARGE" : validation || parser ? "COLLAB_OBJECT_METADATA_INVALID"
    : knownErrors.has(error?.code) ? error.code : "COLLAB_OBJECT_REQUEST_FAILED";
  const status = tooLarge ? 413 : ["COLLAB_OBJECT_KEK_UNAVAILABLE", "COLLAB_OBJECT_STORE_UNAVAILABLE", "COLLAB_OBJECT_SHARING_DISABLED", "COLLAB_TRANSACTION_RETRY", "COLLAB_TRANSACTION_FAILED", "COLLAB_TRANSACTION_RETRY_EXHAUSTED", "COLLAB_COMMAND_IN_PROGRESS"].includes(code) ? 503
    : ["COLLAB_OBJECT_UNAVAILABLE", "COLLAB_DEVICE_REVOKED", "COLLAB_CONVERSATION_UNAVAILABLE", "COLLAB_CONVERSATION_FORBIDDEN", "COLLAB_ORGANIZATION_ACCESS_REVOKED", "COLLAB_MEMBERSHIP_INACTIVE", "COLLAB_BLOCKED", "COLLAB_AUTHORIZATION_DENIED", "COLLAB_FRIENDSHIP_REQUIRED", "COLLAB_PEER_MEMBERSHIP_INACTIVE"].includes(code) ? 403 : 400;
  // Never forward arbitrary provider error messages/codes or Zod input/issues.
  return reply.header("Cache-Control", "no-store").code(status).send({ ok: false, code, retryable: transientTransaction || knownErrors.has(code) && error?.retryable === true, requestId: String(request.id || "") });
}

// These are actual Fastify route options, not inert config.redact metadata.
// Silence the request child logger before automatic incoming/access logging;
// an own errorHandler also catches parser errors before the global app logger.
export const objectRouteOptions = Object.freeze({
  logLevel: "silent", bodyLimit: 16 * 1024, errorHandler: reject,
  logSerializers: { req: () => ({ redacted: true }), res: (reply) => ({ statusCode: reply.statusCode }), err: () => ({ code: "COLLAB_OBJECT_REQUEST_FAILED" }) },
});

/** Reuses the parent signature/account/rollout boundary; no standalone auth. */
export function registerCollaborationObjectRoutes({ post, accountFor, database, config = {}, objectService = createConfiguredCollaborationObjectService({ database, config }) }) {
  const route = (path, schema, method) => post(`/api/collaboration/v1/objects/${path}`, schema, async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    let key;
    try {
      const input = schema.parse(request.body);
      const objectId = method === "init" ? undefined : id.parse(request.params?.id);
      // Authenticate the original body before clearing the DEK field; its bytes
      // are covered by the device signature, just like every other input field.
      const account = await accountFor(request, reply, input, database); if (!account) return;
      const { deviceId, ...values } = input;
      if (method === "init") {
        key = Buffer.from(values.dek, "base64");
        delete input.dek; delete request.body.dek;
        values.dek = key;
      }
      const result = await objectService[method]({ account, ...values, ...(objectId ? { objectId } : {}) });
      if (method !== "downloadTicket") return reply.send({ ok: true, requestId: account.requestId, result });
      key = result.dek;
      if (!Buffer.isBuffer(key) || key.length !== 32) throw new Error("Invalid object key result.");
      return reply.send({ ok: true, requestId: account.requestId, result: {
        objectId: result.objectId, url: result.url, expiresAt: result.expiresAt,
        ciphertextSize: result.ciphertextSize, ciphertextSha256: result.ciphertextSha256, dek: key.toString("base64"),
      } });
    } catch (error) { return reject(error, request, reply); }
    finally {
      key?.fill?.(0);
      if (request.body && typeof request.body === "object") delete request.body.dek;
    }
  }, objectRouteOptions);
  route("init", objectInitBody, "init");
  route(":id/complete", objectCompleteBody, "complete");
  route(":id/abort", objectCommandBody, "abort");
  route(":id/revoke", objectCommandBody, "revoke");
  route(":id/download-ticket", objectCommandBody, "downloadTicket");
}
