import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const fail = (code) => Object.assign(new Error(code), { code, retryable: false });
const algorithm = "aes-256-gcm";
function aad(context, kekVersion) {
  const values = [context.objectId, context.ownerUserId, context.conversationId, context.scopeType, context.organizationId ?? null, context.purpose];
  if (values.some((value, i) => i !== 4 && (typeof value !== "string" || !value || value.length > 200))) throw fail("COLLAB_OBJECT_KEY_INVALID");
  if (!["personal", "organization"].includes(context.scopeType) || (context.scopeType === "organization") !== (typeof context.organizationId === "string" && context.organizationId.length > 0)) throw fail("COLLAB_OBJECT_KEY_INVALID");
  return Buffer.from(JSON.stringify(["lily-object-dek", 1, kekVersion, ...values]));
}

/** Independent object KEKs only. No config lookup, logs, or message-key fallback. */
export function createCollaborationObjectKeyBroker({ currentKekVersion, kekByVersion } = {}) {
  const keys = new Map();
  for (const [rawVersion, rawKey] of kekByVersion instanceof Map ? kekByVersion : Object.entries(kekByVersion || {})) {
    const version = Number(rawVersion);
    if (!Number.isSafeInteger(version) || version < 1 || !(Buffer.isBuffer(rawKey) || rawKey instanceof Uint8Array) || rawKey.length !== 32) throw fail("COLLAB_OBJECT_KEK_UNAVAILABLE");
    keys.set(version, Buffer.from(rawKey));
  }
  const version = Number(currentKekVersion);
  if (!keys.has(version)) throw fail("COLLAB_OBJECT_KEK_UNAVAILABLE");
  return Object.freeze({
    wrap({ dek, ...context }) {
      if (!(Buffer.isBuffer(dek) || dek instanceof Uint8Array) || dek.length !== 32) throw fail("COLLAB_OBJECT_KEY_INVALID");
      const temporary = Buffer.from(dek);
      try {
        const nonce = randomBytes(12);
        const cipher = createCipheriv(algorithm, keys.get(version), nonce);
        cipher.setAAD(aad(context, version));
        const encrypted = Buffer.concat([cipher.update(temporary), cipher.final()]);
        return { wrappedDek: Buffer.concat([nonce, cipher.getAuthTag(), encrypted]), kekVersion: version, algorithm };
      } finally { temporary.fill(0); }
    },
    unwrap({ wrappedDek, kekVersion, algorithm: suppliedAlgorithm, ...context }) {
      const kek = keys.get(Number(kekVersion));
      if (!kek) throw fail("COLLAB_OBJECT_KEK_UNAVAILABLE");
      try {
        if (suppliedAlgorithm !== algorithm || !Buffer.isBuffer(wrappedDek) || wrappedDek.length !== 60) throw fail("COLLAB_OBJECT_KEY_INVALID");
        const decipher = createDecipheriv(algorithm, kek, wrappedDek.subarray(0, 12));
        decipher.setAAD(aad(context, Number(kekVersion)));
        decipher.setAuthTag(wrappedDek.subarray(12, 28));
        return Buffer.concat([decipher.update(wrappedDek.subarray(28)), decipher.final()]);
      } catch { throw fail("COLLAB_OBJECT_KEY_INVALID"); }
    },
  });
}
