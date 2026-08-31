import { createHash, randomUUID } from "node:crypto";
import { runCollaborationCommand } from "./command-runner.js";

const error = (code, retryable = false) => Object.assign(new Error(code), { code, retryable });
const unavailable = () => error("COLLAB_OBJECT_UNAVAILABLE");
const transitions = {
  initiated: ["uploading", "expired", "aborted"], uploading: ["uploaded", "aborted", "expired", "rejected"],
  uploaded: ["verified", "rejected", "aborted", "expired"], verified: ["bound", "aborted", "expired", "revoked"],
  bound: ["revoked", "expired", "deleted"], aborted: ["deleted"], rejected: ["deleted"], revoked: ["deleted"], expired: ["deleted"],
};
export function canTransitionObject(from, to) { return Boolean(transitions[from]?.includes(to)); }
function requiredId(value) {
  if (typeof value !== "string" || !value.trim() || value.length > 200 || /[\x00-\x1f\x7f]/.test(value)) throw error("COLLAB_OBJECT_METADATA_INVALID");
  return value.trim();
}
function identity(account) { return { userId: requiredId(account?.userId ?? account?.user_id ?? account?.id), deviceId: requiredId(account?.deviceId ?? account?.device_id) }; }
function sha(value) { if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) throw error("COLLAB_OBJECT_METADATA_INVALID"); return value; }
export function normalizeObjectInput(input = {}) {
  const purpose = input.purpose ?? "attachment";
  if (!["attachment", "workspace"].includes(purpose)) throw error("COLLAB_OBJECT_METADATA_INVALID");
  const size = input.ciphertextSize;
  if (!Number.isSafeInteger(size) || size < 1 || size > (purpose === "workspace" ? 256 * 1024 ** 2 : 1024 ** 3)) throw error("COLLAB_OBJECT_SIZE_INVALID");
  const name = input.originalName;
  const mimeType = input.mimeType;
  if (typeof name !== "string" || !name || name.length > 200 || /[\\/\x00-\x1f\x7f]/.test(name) || name === "." || name === ".." || typeof mimeType !== "string" || !/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i.test(mimeType) || mimeType.length > 100) throw error("COLLAB_OBJECT_METADATA_INVALID");
  const expiresAt = input.expiresAt == null ? null : new Date(input.expiresAt);
  if (expiresAt && !Number.isFinite(expiresAt.getTime())) throw error("COLLAB_OBJECT_METADATA_INVALID");
  return { conversationId: requiredId(input.conversationId), purpose, ciphertextSize: size, ciphertextSha256: sha(input.ciphertextSha256), mimeType, originalName: name, expiresAt: expiresAt?.toISOString() ?? null };
}
function keyContext(object) {
  return { objectId: object.id, ownerUserId: object.owner_user_id, conversationId: object.conversation_id, scopeType: object.scope_type, organizationId: object.organization_id, purpose: object.purpose };
}
function checked(decision) { if (!decision?.ok) throw error(decision?.code || "COLLAB_OBJECT_UNAVAILABLE"); return decision; }

/** Optional object domain: absence of keys/store affects attachments only. */
export function createCollaborationObjectService({ repository, keyBroker, objectStore, now = Date.now, createId = (prefix) => `${prefix}_${randomUUID()}` } = {}) {
  if (!repository?.database) throw new TypeError("An object repository is required.");
  function requireKeys() { if (!keyBroker?.wrap || !keyBroker?.unwrap) throw error("COLLAB_OBJECT_KEK_UNAVAILABLE"); }
  function requireStore() { if (!objectStore?.head || !objectStore?.createUploadTicket || !objectStore?.createDownloadTicket) throw error("COLLAB_OBJECT_STORE_UNAVAILABLE", true); }
  const owner = (trx, account, objectId) => repository.authorizeObject(trx, { account, objectId, action: "owner" });
  async function credentials(account, objectId) {
    return repository.withTransaction(async (trx) => {
      const { object } = checked(await owner(trx, account, objectId));
      if (object.state !== "uploading" || new Date(object.orphan_expires_at).getTime() <= Number(now())) throw unavailable();
      const deadline = Math.min(new Date(object.orphan_expires_at).getTime(), object.expires_at ? new Date(object.expires_at).getTime() : Infinity);
      const ttlSeconds = Math.min(900, Math.floor((deadline - Number(now())) / 1000));
      if (ttlSeconds < 1) throw unavailable();
      try { return { objectId, state: object.state, upload: await objectStore.createUploadTicket({ objectKey: object.object_key, ciphertextSize: Number(object.ciphertext_size), ttlSeconds }) }; }
      catch { throw error("COLLAB_OBJECT_STORE_UNAVAILABLE", true); }
    });
  }
  async function terminal({ account: rawAccount, clientCommandId, objectId: rawObjectId }, targetState) {
    const account = identity(rawAccount); const objectId = requiredId(rawObjectId);
    return runCollaborationCommand({ account, clientCommandId, commandType: `object.${targetState === "aborted" ? "abort" : "revoke"}`, input: { objectId }, database: repository.database,
      authorize: ({ trx }) => owner(trx, account, objectId),
      project: async ({ trx, authorization }) => {
        const current = authorization.object;
        const response = { objectId, state: targetState };
        if (current.state === targetState) return { noEvent: true, event: {}, response, project: async () => {} };
        if (targetState === "revoked" && current.state !== "bound" || !canTransitionObject(current.state, targetState)) throw unavailable();
        const recipients = targetState === "revoked" ? await repository.conversations.activeConversationMemberIds(trx, current.conversation_id) : [account.userId];
        return { event: { id: requiredId(createId("evt")), conversationId: null, type: `object.${targetState}`, payload: { objectId, conversationId: current.conversation_id, scopeType: current.scope_type, organizationId: current.organization_id } }, recipientUserIds: recipients, response,
          project: async ({ trx: projection }) => {
            await repository.transition(projection, objectId, current.state, targetState, targetState === "revoked" ? { revoked_at: new Date(Number(now())) } : {});
            await repository.queueCleanup(projection, objectId, targetState);
          },
        };
      },
    });
  }
  return Object.freeze({
    async init({ account: rawAccount, clientCommandId, dek, ...raw } = {}) {
      requireKeys(); requireStore();
      const account = identity(rawAccount); const metadata = normalizeObjectInput(raw);
      if (metadata.expiresAt && (new Date(metadata.expiresAt).getTime() <= Number(now()) || new Date(metadata.expiresAt).getTime() > Number(now()) + 365 * 86_400_000)) throw error("COLLAB_OBJECT_METADATA_INVALID");
      if (!(Buffer.isBuffer(dek) || dek instanceof Uint8Array) || dek.length !== 32) throw error("COLLAB_OBJECT_KEY_INVALID");
      const objectId = requiredId(createId("obj"));
      // One-way intent binds retries to the same client-generated random key;
      // the DEK itself never enters command input, receipt or event payloads.
      const input = { ...metadata, keyIntent: createHash("sha256").update(dek).digest("hex") };
      const temporary = Buffer.from(dek);
      try {
        const response = await runCollaborationCommand({ account, clientCommandId, commandType: "object.init", input, database: repository.database,
          authorize: ({ trx }) => repository.lockConversation(trx, { account, conversationId: metadata.conversationId, action: "send" }),
          prepare: ({ authorization }) => {
            const conversation = authorization.context.conversation;
            const object = { ...metadata, objectId, ownerUserId: account.userId, scopeType: conversation.scopeType, organizationId: conversation.organizationId, objectKey: objectStore.createObjectKey() };
            return { object, envelope: keyBroker.wrap({ ...object, dek: temporary }) };
          },
          project: ({ preparation }) => ({ event: { id: requiredId(createId("evt")), conversationId: null, type: "object.initiated", payload: { objectId } }, recipientUserIds: [account.userId], response: { objectId },
            project: async ({ trx }) => { await repository.insertObject(trx, preparation.object, preparation.envelope); await repository.transition(trx, objectId, "initiated", "uploading"); },
          }),
        });
        return credentials(account, response.objectId);
      } finally { temporary.fill(0); }
    },
    async complete({ account: rawAccount, clientCommandId, objectId: rawObjectId, etag, ciphertextSize, ciphertextSha256 } = {}) {
      requireStore();
      const account = identity(rawAccount); const objectId = requiredId(rawObjectId);
      if (typeof etag !== "string" || !etag || etag.length > 200 || !Number.isSafeInteger(ciphertextSize) || ciphertextSize < 1) throw error("COLLAB_OBJECT_METADATA_INVALID");
      const input = { objectId, etag, ciphertextSize, ciphertextSha256: sha(ciphertextSha256) };
      const initial = await repository.withTransaction(async (trx) => checked(await owner(trx, account, objectId)));
      let head = null;
      if (initial.object.state === "uploading") {
        try { head = await objectStore.head({ objectKey: initial.object.object_key }); } catch { throw error("COLLAB_OBJECT_STORE_UNAVAILABLE", true); }
      }
      return runCollaborationCommand({ account, clientCommandId, commandType: "object.complete", input, database: repository.database,
        authorize: ({ trx }) => owner(trx, account, objectId),
        project: ({ authorization }) => {
          const current = authorization.object;
          if (current.state === "verified" || current.state === "bound") {
            if (current.ciphertext_sha256 !== ciphertextSha256 || Number(current.ciphertext_size) !== ciphertextSize || current.provider_etag !== etag) throw unavailable();
            return { noEvent: true, event: {}, response: { objectId, state: "verified" }, project: async () => {} };
          }
          if (current.state !== "uploading" || new Date(current.orphan_expires_at).getTime() <= Number(now())) throw unavailable();
          const valid = head && head.objectKey === current.object_key && head.ciphertextSize === ciphertextSize && ciphertextSize === Number(current.ciphertext_size) && head.ciphertextSha256 === ciphertextSha256 && ciphertextSha256 === current.ciphertext_sha256 && head.etag === etag && head.mimeType === "application/octet-stream";
          const state = valid ? "verified" : "rejected";
          return { event: { id: requiredId(createId("evt")), conversationId: null, type: `object.${state}`, payload: { objectId } }, recipientUserIds: [account.userId], response: { objectId, state }, responseCode: valid ? "OK" : "COLLAB_OBJECT_VERIFICATION_FAILED",
            project: async ({ trx }) => {
              if (valid) { await repository.transition(trx, objectId, "uploading", "uploaded", { provider_etag: etag }); await repository.transition(trx, objectId, "uploaded", "verified", { verified_at: new Date(Number(now())) }); }
              else { await repository.transition(trx, objectId, "uploading", "rejected"); await repository.queueCleanup(trx, objectId, "verification-failed"); }
            },
          };
        },
      });
    },
    abort: (input) => terminal(input, "aborted"),
    revoke: (input) => terminal(input, "revoked"),
    async bindToMessage({ trx, account: rawAccount, conversationId, messageId, objectIds, purpose = "attachment" }) {
      if (trx?.isTransaction !== true) throw error("COLLAB_OBJECT_TRANSACTION_REQUIRED");
      if (!trx || !Array.isArray(objectIds) || objectIds.length === 0 || new Set(objectIds).size !== objectIds.length || !["attachment", "workspace"].includes(purpose)) throw error("COLLAB_OBJECT_METADATA_INVALID");
      return repository.bindObjects(trx, { account: identity(rawAccount), conversationId: requiredId(conversationId), messageId: requiredId(messageId), objectIds: objectIds.map(requiredId), purpose });
    },
    async downloadTicket({ account: rawAccount, objectId: rawObjectId, clientCommandId = createId("ticket") } = {}) {
      requireKeys(); requireStore();
      const account = identity(rawAccount); const objectId = requiredId(rawObjectId);
      await runCollaborationCommand({ account, clientCommandId, commandType: "object.download-ticket", input: { objectId }, database: repository.database,
        authorize: ({ trx }) => repository.authorizeObject(trx, { account, objectId, action: "download" }),
        project: () => ({ event: { id: requiredId(createId("evt")), conversationId: null, type: "object.download_authorized", payload: { objectId } }, recipientUserIds: [account.userId], response: { objectId }, project: async () => {} }),
      });
      // Capabilities never enter a receipt. Even a replay obtains fresh locked
      // permission, since revocation may have committed after the audit event.
      return repository.withTransaction(async (trx) => {
        const { object } = checked(await repository.authorizeObject(trx, { account, objectId, action: "download" }));
        const envelope = await repository.findKey(trx, objectId);
        if (!envelope) throw unavailable();
        const remainingSeconds = object.expires_at ? Math.floor((new Date(object.expires_at).getTime() - Number(now())) / 1000) : 300;
        if (remainingSeconds < 1) throw unavailable();
        const dek = keyBroker.unwrap({ ...keyContext(object), ...envelope });
        try {
          const ticket = await objectStore.createDownloadTicket({ objectKey: object.object_key, ttlSeconds: Math.min(300, remainingSeconds) });
          return { objectId, ...ticket, dek, ciphertextSize: Number(object.ciphertext_size), ciphertextSha256: object.ciphertext_sha256 };
        } catch { dek.fill(0); throw error("COLLAB_OBJECT_STORE_UNAVAILABLE", true); }
      });
    },
  });
}
