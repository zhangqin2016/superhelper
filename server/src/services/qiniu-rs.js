import crypto from "node:crypto";

/**
 * Qiniu object management (list / move), signed with the stored storage
 * credentials (getQiniuConfig). Used to archive old installers: a move to
 * archive/ is reversible, a delete is not, so nothing here deletes.
 */
// Overridable for a private deployment's region endpoints (and tests).
const rsHost = () => process.env.QINIU_RS_HOST || "https://rs.qiniuapi.com";
const rsfHost = () => process.env.QINIU_RSF_HOST || "https://rsf.qiniuapi.com";

const b64url = (value) => Buffer.from(value).toString("base64").replace(/\+/g, "-").replace(/\//g, "_");
const entry = (bucket, key) => b64url(`${bucket}:${key}`);

export function qboxAuthorization(config, pathWithQuery, body = "") {
  const sign = crypto.createHmac("sha1", config.secretKey).update(`${pathWithQuery}\n${body}`).digest("base64").replace(/\+/g, "-").replace(/\//g, "_");
  return `QBox ${config.accessKey}:${sign}`;
}

async function call(config, host, pathWithQuery, { method = "POST", fetchImpl = fetch } = {}) {
  const response = await fetchImpl(`${host}${pathWithQuery}`, {
    method,
    headers: { Authorization: qboxAuthorization(config, pathWithQuery), "Content-Type": "application/x-www-form-urlencoded" },
    signal: AbortSignal.timeout(20_000),
  });
  const text = await response.text();
  let json = {};
  try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text.slice(0, 200) }; }
  return { ok: response.ok, status: response.status, json };
}

/** All keys under a prefix (paged). */
export async function listObjects(config, prefix, deps = {}) {
  const keys = [];
  let marker = "";
  for (let page = 0; page < 20; page += 1) {
    const query = `/list?bucket=${encodeURIComponent(config.bucket)}&prefix=${encodeURIComponent(prefix)}&limit=1000${marker ? `&marker=${encodeURIComponent(marker)}` : ""}`;
    const result = await call(config, rsfHost(), query, deps);
    if (!result.ok) throw Object.assign(new Error(`qiniu list failed: ${result.status}`), { code: "QINIU_LIST_FAILED" });
    for (const item of result.json.items || []) keys.push(String(item.key));
    marker = result.json.marker || "";
    if (!marker) break;
  }
  return keys;
}

/** Move one object; never overwrites an existing destination. */
export async function moveObject(config, fromKey, toKey, deps = {}) {
  const result = await call(config, rsHost(), `/move/${entry(config.bucket, fromKey)}/${entry(config.bucket, toKey)}/force/false`, deps);
  // 612: source already gone — e.g. a retry after a partial run; the caller decides.
  return { ok: result.ok, status: result.status, missing: result.status === 612, exists: result.status === 614 };
}
