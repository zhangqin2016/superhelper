import { config } from "../config.js";
import { db } from "../db.js";

const QINIU_CONFIG_KEY = "qiniu_config";

export function envQiniuConfig() {
  return {
    publicBaseUrl: config.qiniuPublicBaseUrl,
    accessKey: config.qiniuAccessKey,
    secretKey: config.qiniuSecretKey,
    bucket: config.qiniuBucket,
    uploadUrl: config.qiniuUploadUrl,
  };
}

export async function getAppSetting(key, fallback = null) {
  const row = await db
    .selectFrom("app_settings")
    .select("value")
    .where("key", "=", key)
    .executeTakeFirst();
  return row?.value ?? fallback;
}

export async function setAppSetting(key, value) {
  await db
    .insertInto("app_settings")
    .values({
      key,
      value: JSON.stringify(value),
      updated_at: new Date(),
    })
    .onConflict((oc) =>
      oc.column("key").doUpdateSet({
        value: JSON.stringify(value),
        updated_at: new Date(),
      }),
    )
    .execute();
}

// Media (image/video/TTS/vision) delivery mode. "direct" delivers the real
// DashScope key + endpoints to the client (fast, no gateway hop); "gateway"
// keeps the key server-side behind /llm/dashscope-media + a short-lived token.
// Default direct. Stored as a JSON string by setAppSetting, so parse defensively.
export async function getMediaDeliveryMode() {
  let value = await getAppSetting("media_delivery_mode", null);
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      // value was a bare string
    }
  }
  return value === "gateway" ? "gateway" : "direct";
}

export function normalizeQiniuConfig(value, fallback = envQiniuConfig()) {
  const raw = value && typeof value === "object" ? value : {};
  return {
    publicBaseUrl: String(raw.publicBaseUrl || raw.qiniuPublicBaseUrl || fallback.publicBaseUrl || "").trim(),
    accessKey: String(raw.accessKey || raw.qiniuAccessKey || fallback.accessKey || "").trim(),
    secretKey: String(raw.secretKey || raw.qiniuSecretKey || fallback.secretKey || "").trim(),
    bucket: String(raw.bucket || raw.qiniuBucket || fallback.bucket || "").trim(),
    uploadUrl: String(raw.uploadUrl || raw.qiniuUploadUrl || fallback.uploadUrl || "https://upload.qiniup.com").trim(),
  };
}

export async function getQiniuConfig() {
  return normalizeQiniuConfig(await getAppSetting(QINIU_CONFIG_KEY, null));
}

export async function getQiniuAdminSettings() {
  const qiniu = await getQiniuConfig();
  return {
    publicBaseUrl: qiniu.publicBaseUrl,
    accessKey: qiniu.accessKey,
    bucket: qiniu.bucket,
    uploadUrl: qiniu.uploadUrl,
    hasSecretKey: Boolean(qiniu.secretKey),
  };
}

export async function setQiniuConfig(input) {
  const current = await getQiniuConfig();
  const next = normalizeQiniuConfig({
    publicBaseUrl: input.publicBaseUrl,
    accessKey: input.accessKey,
    secretKey: input.secretKey || current.secretKey,
    bucket: input.bucket,
    uploadUrl: input.uploadUrl,
  }, current);
  await setAppSetting(QINIU_CONFIG_KEY, next);
  return next;
}

export async function ensureEnvQiniuConfigSeeded() {
  const existing = await getAppSetting(QINIU_CONFIG_KEY, null);
  if (existing) return false;
  const fromEnv = normalizeQiniuConfig(envQiniuConfig(), {});
  if (!fromEnv.publicBaseUrl && !fromEnv.accessKey && !fromEnv.secretKey && !fromEnv.bucket) {
    return false;
  }
  await setAppSetting(QINIU_CONFIG_KEY, fromEnv);
  return true;
}
