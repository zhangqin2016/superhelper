import { getAliyunSmsConfig } from "./app-settings.js";

let cachedClient = null;
let cachedClientKey = "";

export function aliyunSmsConfigured(settings = {}) {
  return Boolean(
    settings.accessKeyId &&
      settings.accessKeySecret &&
      settings.signName &&
      settings.templateLogin,
  );
}

export function aliyunPhoneNumber(phoneE164) {
  const value = String(phoneE164 || "").trim();
  if (value.startsWith("+86") && /^(\+86)1[3-9]\d{9}$/.test(value)) return value.slice(3);
  return value.replace(/^\+/, "");
}

async function createAliyunClient(settings) {
  const clientKey = [
    settings.accessKeyId,
    settings.accessKeySecret,
    settings.region,
  ].join("\n");
  if (cachedClient && cachedClientKey === clientKey) return cachedClient;
  const [smsMod, openApiMod] = await Promise.all([
    import("@alicloud/dysmsapi20170525"),
    import("@alicloud/openapi-client"),
  ]);
  const SmsClient = smsMod.default?.default || smsMod.default || smsMod.Client;
  const OpenApi = openApiMod.default || openApiMod;
  const openApiConfig = new OpenApi.Config({
    accessKeyId: settings.accessKeyId,
    accessKeySecret: settings.accessKeySecret,
    regionId: settings.region,
    endpoint: "dysmsapi.aliyuncs.com",
  });
  cachedClient = new SmsClient(openApiConfig);
  cachedClientKey = clientKey;
  return cachedClient;
}

export async function sendLoginSms({ phoneE164, code, requestId = "" } = {}) {
  const settings = await getAliyunSmsConfig();
  if (!aliyunSmsConfigured(settings)) {
    return {
      ok: true,
      provider: "aliyun",
      skipped: true,
      requestId,
      message: "ALIYUN_SMS_NOT_CONFIGURED",
    };
  }

  try {
    const smsMod = await import("@alicloud/dysmsapi20170525");
    const SendSmsRequest = smsMod.SendSmsRequest || smsMod.default?.SendSmsRequest;
    const client = await createAliyunClient(settings);
    const response = await client.sendSms(new SendSmsRequest({
      phoneNumbers: aliyunPhoneNumber(phoneE164),
      signName: settings.signName,
      templateCode: settings.templateLogin,
      templateParam: JSON.stringify({ code: String(code || "") }),
    }));
    const body = response?.body || {};
    if (body.code && body.code !== "OK") {
      return {
        ok: false,
        provider: "aliyun",
        code: body.code,
        message: body.message || "ALIYUN_SMS_SEND_FAILED",
        requestId: body.requestId || requestId,
      };
    }
    return {
      ok: true,
      provider: "aliyun",
      requestId: body.requestId || requestId,
      bizId: body.bizId || "",
    };
  } catch (error) {
    return {
      ok: false,
      provider: "aliyun",
      code: "ALIYUN_SMS_SEND_FAILED",
      message: error?.message || String(error),
      requestId,
    };
  }
}
