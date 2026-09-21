const fail = (code = "COLLAB_OBJECT_UNAVAILABLE", retryable = false) => Object.assign(new Error(code), { code, retryable });
export function expiredOrphanRecovery(object,now){
  const expires=new Date(object.orphan_expires_at).getTime();
  const eligible=['uploading','verified'].includes(object.state)||['expired','deleted'].includes(object.state)&&object.cleanup_reason==='orphan-expired';
  if(!eligible||object.task_id||object.bound_message_id||object.shared_workspace_id||object.expires_at!=null
    ||object.orphan_expires_at==null||!Number.isFinite(expires)||!Number.isFinite(Number(now))||expires>Number(now))return null;
  return {objectId:object.id,state:'expired',reason:'orphan-expired',ciphertextSize:Number(object.ciphertext_size),ciphertextSha256:object.ciphertext_sha256};
}

/** Read-only recovery: the upload owner must reauthorize on every attempt.
 * Provider inspection never advances the object state or creates a receipt;
 * the original complete command remains the sole verification transition.
 */
export async function inspectObjectRecovery({ repository, objectStore, account, objectId, now }) {
  return repository.withTransaction(async (trx) => {
    const decision = await repository.authorizeObject(trx, { account, objectId, action: "owner" });
    if (!decision?.ok) throw fail();
    const object = decision.object;
    const expired=expiredOrphanRecovery(object,now());if(expired)return expired;
    if (!["uploading", "verified", "bound"].includes(object.state)) throw fail();
    if (object.state !== "bound" && !(new Date(object.orphan_expires_at).getTime() > Number(now()))) throw fail();
    const result = { objectId, state: object.state, ciphertextSize: Number(object.ciphertext_size), ciphertextSha256: object.ciphertext_sha256, etag: object.provider_etag || null };
    if (object.state !== "uploading") return result;
    const deadline = Math.min(new Date(object.orphan_expires_at).getTime(), object.expires_at ? new Date(object.expires_at).getTime() : Infinity);
    let ttlSeconds = Math.min(900, Math.floor((deadline - Number(now())) / 1000));
    if (ttlSeconds < 1) throw fail();
    if (typeof objectStore?.probe !== "function") throw fail("COLLAB_OBJECT_STORE_UNAVAILABLE", true);
    let head;
    try { head = await objectStore.probe({ objectKey: object.object_key }); }
    catch { throw fail("COLLAB_OBJECT_STORE_UNAVAILABLE", true); }
    // Only an explicit provider 404 proves absence. A network failure above
    // must never cause a new upload after an uncertain multipart completion.
    if (head && (head.objectKey !== object.object_key || head.ciphertextSize !== result.ciphertextSize
      || head.ciphertextSha256 !== result.ciphertextSha256 || head.mimeType !== "application/octet-stream")) throw fail("COLLAB_OBJECT_VERIFICATION_FAILED");
    result.provider = head ? { state: "present", etag: head.etag } : { state: "missing" };
    ttlSeconds = Math.min(900, Math.floor((deadline - Number(now())) / 1000));
    if (ttlSeconds < 1) throw fail();
    try { result.upload = await objectStore.createUploadTicket({ objectKey: object.object_key, ciphertextSize: result.ciphertextSize, ttlSeconds }); }
    catch { throw fail("COLLAB_OBJECT_STORE_UNAVAILABLE", true); }
    return result;
  });
}
