import { config } from "../config.js";
import { db } from "../db.js";
import { decryptSecret, encryptSecret } from "./security.js";

const QINIU_CONFIG_KEY = "qiniu_config";
const SMS_CONFIG_KEY = "aliyun_sms_config";
const PAYMENT_CONFIG_KEY = "payment_config";

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

// Chat model delivery mode. Gateway is the product default: model keys stay on
// the server and clients receive only short-lived /llm/<provider> tokens.
// Direct mode is deliberately env-gated so an old DB value cannot silently keep
// shipping long-lived provider keys to clients after the server default changes.
export async function getModelDeliveryMode() {
  if (config.modelConfigDeliveryMode !== "direct") return "gateway";
  let value = await getAppSetting("model_delivery_mode", null);
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      // bare string
    }
  }
  return value === "direct" ? "direct" : "gateway";
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

export function envAliyunSmsConfig() {
  return {
    accessKeyId: config.smsAliyunAccessKeyId,
    accessKeySecret: config.smsAliyunAccessKeySecret,
    signName: config.smsAliyunSignName,
    templateLogin: config.smsAliyunTemplateLogin,
    region: config.smsAliyunRegion || "cn-hangzhou",
  };
}

export function normalizeAliyunSmsConfig(value, fallback = envAliyunSmsConfig()) {
  const raw = value && typeof value === "object" ? value : {};
  const encryptedSecret = String(raw.accessKeySecretEncrypted || "").trim();
  return {
    accessKeyId: String(raw.accessKeyId || fallback.accessKeyId || "").trim(),
    accessKeySecret: encryptedSecret
      ? decryptSecret(encryptedSecret)
      : String(raw.accessKeySecret || fallback.accessKeySecret || "").trim(),
    signName: String(raw.signName || fallback.signName || "").trim(),
    templateLogin: String(raw.templateLogin || raw.templateCode || fallback.templateLogin || "").trim(),
    region: String(raw.region || fallback.region || "cn-hangzhou").trim(),
  };
}

export async function getAliyunSmsConfig() {
  return normalizeAliyunSmsConfig(await getAppSetting(SMS_CONFIG_KEY, null));
}

export async function getAliyunSmsAdminSettings() {
  const sms = await getAliyunSmsConfig();
  return {
    accessKeyId: sms.accessKeyId,
    signName: sms.signName,
    templateLogin: sms.templateLogin,
    region: sms.region,
    hasAccessKeySecret: Boolean(sms.accessKeySecret),
  };
}

export async function setAliyunSmsConfig(input) {
  const current = await getAliyunSmsConfig();
  const nextPlain = normalizeAliyunSmsConfig({
    accessKeyId: input.accessKeyId,
    accessKeySecret: input.accessKeySecret || current.accessKeySecret,
    signName: input.signName,
    templateLogin: input.templateLogin,
    region: input.region,
  }, current);
  await setAppSetting(SMS_CONFIG_KEY, {
    accessKeyId: nextPlain.accessKeyId,
    accessKeySecretEncrypted: encryptSecret(nextPlain.accessKeySecret),
    signName: nextPlain.signName,
    templateLogin: nextPlain.templateLogin,
    region: nextPlain.region,
  });
  return nextPlain;
}

function boolValue(value, fallback = false) {
  if (typeof value === "boolean") return value;
  if (value === "true") return true;
  if (value === "false") return false;
  return Boolean(fallback);
}

export function normalizePaymentConfig(value, fallback = {}) {
  const raw = value && typeof value === "object" ? value : {};
  const rawAlipay = raw.alipay && typeof raw.alipay === "object" ? raw.alipay : {};
  const rawWechat = raw.wechat && typeof raw.wechat === "object" ? raw.wechat : {};
  const fallbackAlipay = fallback.alipay && typeof fallback.alipay === "object" ? fallback.alipay : {};
  const fallbackWechat = fallback.wechat && typeof fallback.wechat === "object" ? fallback.wechat : {};
  const alipayPrivateEncrypted = String(rawAlipay.privateKeyEncrypted || "").trim();
  const wechatApiV3Encrypted = String(rawWechat.apiV3KeyEncrypted || "").trim();
  const wechatPrivateEncrypted = String(rawWechat.privateKeyEncrypted || "").trim();
  return {
    fakePaymentsEnabled: boolValue(raw.fakePaymentsEnabled, fallback.fakePaymentsEnabled ?? false),
    alipay: {
      enabled: boolValue(rawAlipay.enabled, fallbackAlipay.enabled ?? false),
      appId: String(rawAlipay.appId || fallbackAlipay.appId || "").trim(),
      merchantId: String(rawAlipay.merchantId || fallbackAlipay.merchantId || "").trim(),
      publicKey: String(rawAlipay.publicKey || fallbackAlipay.publicKey || "").trim(),
      privateKey: alipayPrivateEncrypted
        ? decryptSecret(alipayPrivateEncrypted)
        : String(rawAlipay.privateKey || fallbackAlipay.privateKey || "").trim(),
      notifyUrl: String(rawAlipay.notifyUrl || fallbackAlipay.notifyUrl || "").trim(),
      returnUrl: String(rawAlipay.returnUrl || fallbackAlipay.returnUrl || "").trim(),
      sandbox: boolValue(rawAlipay.sandbox, fallbackAlipay.sandbox ?? false),
    },
    wechat: {
      enabled: boolValue(rawWechat.enabled, fallbackWechat.enabled ?? false),
      appId: String(rawWechat.appId || fallbackWechat.appId || "").trim(),
      mchId: String(rawWechat.mchId || fallbackWechat.mchId || "").trim(),
      certSerialNo: String(rawWechat.certSerialNo || fallbackWechat.certSerialNo || "").trim(),
      apiV3Key: wechatApiV3Encrypted
        ? decryptSecret(wechatApiV3Encrypted)
        : String(rawWechat.apiV3Key || fallbackWechat.apiV3Key || "").trim(),
      privateKey: wechatPrivateEncrypted
        ? decryptSecret(wechatPrivateEncrypted)
        : String(rawWechat.privateKey || fallbackWechat.privateKey || "").trim(),
      notifyUrl: String(rawWechat.notifyUrl || fallbackWechat.notifyUrl || "").trim(),
      sandbox: boolValue(rawWechat.sandbox, fallbackWechat.sandbox ?? false),
    },
  };
}

export async function getPaymentConfig() {
  return normalizePaymentConfig(await getAppSetting(PAYMENT_CONFIG_KEY, null));
}

export async function getPaymentAdminSettings() {
  const payment = await getPaymentConfig();
  return {
    fakePaymentsEnabled: payment.fakePaymentsEnabled,
    alipay: {
      enabled: payment.alipay.enabled,
      appId: payment.alipay.appId,
      merchantId: payment.alipay.merchantId,
      publicKey: payment.alipay.publicKey,
      notifyUrl: payment.alipay.notifyUrl,
      returnUrl: payment.alipay.returnUrl,
      sandbox: payment.alipay.sandbox,
      hasPrivateKey: Boolean(payment.alipay.privateKey),
    },
    wechat: {
      enabled: payment.wechat.enabled,
      appId: payment.wechat.appId,
      mchId: payment.wechat.mchId,
      certSerialNo: payment.wechat.certSerialNo,
      notifyUrl: payment.wechat.notifyUrl,
      sandbox: payment.wechat.sandbox,
      hasApiV3Key: Boolean(payment.wechat.apiV3Key),
      hasPrivateKey: Boolean(payment.wechat.privateKey),
    },
  };
}

export async function setPaymentConfig(input = {}) {
  const current = await getPaymentConfig();
  const nextPlain = normalizePaymentConfig({
    fakePaymentsEnabled: input.fakePaymentsEnabled,
    alipay: {
      enabled: input.alipay?.enabled,
      appId: input.alipay?.appId,
      merchantId: input.alipay?.merchantId,
      publicKey: input.alipay?.publicKey,
      privateKey: input.alipay?.privateKey || current.alipay.privateKey,
      notifyUrl: input.alipay?.notifyUrl,
      returnUrl: input.alipay?.returnUrl,
      sandbox: input.alipay?.sandbox,
    },
    wechat: {
      enabled: input.wechat?.enabled,
      appId: input.wechat?.appId,
      mchId: input.wechat?.mchId,
      certSerialNo: input.wechat?.certSerialNo,
      apiV3Key: input.wechat?.apiV3Key || current.wechat.apiV3Key,
      privateKey: input.wechat?.privateKey || current.wechat.privateKey,
      notifyUrl: input.wechat?.notifyUrl,
      sandbox: input.wechat?.sandbox,
    },
  }, current);
  await setAppSetting(PAYMENT_CONFIG_KEY, {
    fakePaymentsEnabled: nextPlain.fakePaymentsEnabled,
    alipay: {
      enabled: nextPlain.alipay.enabled,
      appId: nextPlain.alipay.appId,
      merchantId: nextPlain.alipay.merchantId,
      publicKey: nextPlain.alipay.publicKey,
      privateKeyEncrypted: encryptSecret(nextPlain.alipay.privateKey),
      notifyUrl: nextPlain.alipay.notifyUrl,
      returnUrl: nextPlain.alipay.returnUrl,
      sandbox: nextPlain.alipay.sandbox,
    },
    wechat: {
      enabled: nextPlain.wechat.enabled,
      appId: nextPlain.wechat.appId,
      mchId: nextPlain.wechat.mchId,
      certSerialNo: nextPlain.wechat.certSerialNo,
      apiV3KeyEncrypted: encryptSecret(nextPlain.wechat.apiV3Key),
      privateKeyEncrypted: encryptSecret(nextPlain.wechat.privateKey),
      notifyUrl: nextPlain.wechat.notifyUrl,
      sandbox: nextPlain.wechat.sandbox,
    },
  });
  return nextPlain;
}

export function paymentProviderOptions(payment) {
  const settings = payment || {};
  return [
    { id: "wechat", label: "微信", enabled: Boolean(settings.wechat?.enabled) },
    { id: "alipay", label: "支付宝", enabled: Boolean(settings.alipay?.enabled) },
  ];
}
