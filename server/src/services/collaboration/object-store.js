import { createHmac, randomBytes } from "node:crypto";

const fail = (code = "COLLAB_OBJECT_STORE_UNAVAILABLE") => Object.assign(new Error(code), { code, retryable: code === "COLLAB_OBJECT_STORE_UNAVAILABLE" });
const base64 = (value) => Buffer.from(value).toString("base64").replace(/\+/g, "-").replace(/\//g, "_");
const validKey = (key) => { if (typeof key !== "string" || !/^collaboration\/[a-f0-9]{64}$/.test(key)) throw fail("COLLAB_OBJECT_KEY_INVALID"); return key; };
const ttl = (value, maximum) => Math.max(1, Math.min(maximum, Number.isSafeInteger(value) ? value : maximum));
function httpsBase(value) {
  try { const url = new URL(value); if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) throw fail(); return url.toString().replace(/\/$/, ""); } catch { throw fail(); }
}

/**
 * Explicitly injected COLLAB_QINIU_* settings; never consult the public artifact
 * configuration. Deployment must provision/audit the bucket as private.
 * Policy: https://developer.qiniu.com/kodo/manual/put-policy
 * Hash: https://developer.qiniu.com/dora/api/1297/file-hash-value-qhash
 */
export function createPrivateQiniuObjectStore({ config, fetchImpl = fetch, now = Date.now } = {}) {
  if (!config?.accessKey || !config.secretKey || !config.bucket || config.privateBucket !== true || typeof fetchImpl !== "function") throw fail();
  const privateBaseUrl = httpsBase(config.privateBaseUrl);
  const uploadUrl = httpsBase(config.uploadUrl);
  function deadline(ttlSeconds, maximum) { return Math.floor(Number(now()) / 1000) + ttl(ttlSeconds, maximum); }
  function signedUrl(objectKey, seconds, query = "") {
    const e = deadline(seconds, 300);
    const unsigned = `${privateBaseUrl}/${validKey(objectKey)}?${query ? `${query}&` : ""}e=${e}`;
    return { url: `${unsigned}&token=${config.accessKey}:${base64(createHmac("sha1", config.secretKey).update(unsigned).digest())}`, expiresAt: new Date(e * 1000).toISOString() };
  }
  async function boundedJson(response) {
    const reader = response.body?.getReader();
    if (!reader) throw fail();
    const chunks = []; let size = 0;
    try { for (;;) { const { done, value } = await reader.read(); if (done) break; size += value.byteLength; if (size > 4096) throw fail(); chunks.push(Buffer.from(value)); } }
    finally { await reader.cancel().catch(() => {}); }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  }
  return Object.freeze({
    createObjectKey: () => `collaboration/${randomBytes(32).toString("hex")}`,
    createUploadTicket({ objectKey, ciphertextSize, ttlSeconds = 900 }) {
      if (!Number.isSafeInteger(ciphertextSize) || ciphertextSize < 1 || ciphertextSize > 1024 ** 3) throw fail("COLLAB_OBJECT_SIZE_INVALID");
      const expiry = deadline(ttlSeconds, 900);
      const policy = { scope: `${config.bucket}:${validKey(objectKey)}`, deadline: expiry, insertOnly: 1, forceInsertOnly: true, fsizeMin: ciphertextSize, fsizeLimit: ciphertextSize, mimeLimit: "application/octet-stream" };
      const encoded = base64(JSON.stringify(policy));
      const signature = base64(createHmac("sha1", config.secretKey).update(encoded).digest());
      return { objectKey, token: `${config.accessKey}:${signature}:${encoded}`, uploadUrl, expiresAt: new Date(expiry * 1000).toISOString() };
    },
    createDownloadTicket({ objectKey, ttlSeconds = 300 }) { return signedUrl(objectKey, ttlSeconds); },
    async head({ objectKey }) {
      validKey(objectKey);
      try {
        const options = { redirect: "error", signal: AbortSignal.timeout(5000) };
        const head = await fetchImpl(signedUrl(objectKey, 60).url, { ...options, method: "HEAD" });
        if (!head.ok) throw fail();
        const hashResponse = await fetchImpl(signedUrl(objectKey, 60, "qhash/sha256").url, { ...options, method: "GET" });
        if (!hashResponse.ok) throw fail();
        const hash = await boundedJson(hashResponse);
        const length = head.headers.get("content-length");
        const size = Number(length);
        const etag = String(head.headers.get("etag") || "").replace(/^"|"$/g, "");
        if (!length || !Number.isSafeInteger(size) || size < 1 || hash.fsize !== size || !/^[0-9a-f]{64}$/.test(hash.hash) || !etag || etag.length > 200) throw fail();
        return { objectKey, ciphertextSize: size, ciphertextSha256: hash.hash, etag, mimeType: String(head.headers.get("content-type") || "").split(";")[0].trim() };
      } catch { throw fail(); } // Provider exceptions can contain signed URLs.
    },
  });
}
