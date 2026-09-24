// Which payment providers can take money right now, and their adapters.
//
// "Enabled" in the console is an intention; "ready" means every credential a
// real charge needs is present. Only ready providers are offered to buyers —
// an enabled-but-incomplete provider used to show a 支付宝 button that could
// never complete a payment.

import { config as serverConfig } from "../../config.js";
import { createAlipayGateway } from "./alipay.js";
import { createWechatGateway } from "./wechat.js";

export const NOTIFY_PATHS = Object.freeze({
  alipay: "/api/payments/alipay/notify",
  wechat: "/api/payments/wechat/notify",
});

export const PROVIDER_LABELS = Object.freeze({ alipay: "支付宝", wechat: "微信支付" });

function origin(url) {
  return String(url || "").trim().replace(/\/+$/, "");
}

/** The provider config as the adapters need it, with URLs defaulted from the deployment. */
export function effectiveProviderConfig(provider, payment, { env = process.env } = {}) {
  const api = origin(serverConfig.publicBaseUrl);
  if (provider === "alipay") {
    const a = payment?.alipay || {};
    return {
      ...a,
      notifyUrl: a.notifyUrl || (api ? `${api}${NOTIFY_PATHS.alipay}` : ""),
      // A base: the order page is appended per order.
      returnBase: origin(a.returnUrl) || origin(serverConfig.webBaseUrl),
      gatewayUrl: env.ALIPAY_GATEWAY_URL || "",
    };
  }
  if (provider === "wechat") {
    const w = payment?.wechat || {};
    return {
      ...w,
      notifyUrl: w.notifyUrl || (api ? `${api}${NOTIFY_PATHS.wechat}` : ""),
      returnBase: origin(serverConfig.webBaseUrl),
      baseUrl: env.WECHAT_PAY_BASE_URL || "",
    };
  }
  return null;
}

/** What is missing before a provider can take a real payment ([] = ready). */
export function missingCredentials(provider, payment) {
  const c = effectiveProviderConfig(provider, payment) || {};
  const need = provider === "alipay"
    ? [["appId", "AppId"], ["privateKey", "应用私钥"], ["publicKey", "支付宝公钥"], ["notifyUrl", "异步通知 URL"]]
    : [["appId", "AppId"], ["mchId", "商户号"], ["certSerialNo", "商户证书序列号"], ["privateKey", "商户私钥"], ["apiV3Key", "API v3 Key"], ["platformPublicKey", "微信支付公钥"], ["notifyUrl", "支付通知 URL"]];
  return need.filter(([key]) => !String(c[key] || "").trim()).map(([, label]) => label);
}

/**
 * What the console shows per provider: whether it can take money, what is
 * missing, and the URLs actually in effect (defaults included) — the ones to
 * register at the provider.
 */
export function providerStatus(payment, { env = process.env } = {}) {
  return Object.fromEntries(["alipay", "wechat"].map((p) => {
    const c = effectiveProviderConfig(p, payment, { env }) || {};
    const missing = missingCredentials(p, payment);
    return [p, { enabled: Boolean(payment?.[p]?.enabled), ready: Boolean(payment?.[p]?.enabled) && missing.length === 0, missing, notifyUrl: c.notifyUrl || "", returnBase: c.returnBase || "" }];
  }));
}

export function readyProviders(payment) {
  return ["alipay", "wechat"].filter((p) => payment?.[p]?.enabled && missingCredentials(p, payment).length === 0);
}

export function createGateway(provider, payment, deps = {}) {
  const cfg = effectiveProviderConfig(provider, payment);
  if (provider === "alipay") return createAlipayGateway(cfg, deps);
  if (provider === "wechat") return createWechatGateway(cfg, deps);
  throw Object.assign(new Error("PAYMENT_PROVIDER_UNKNOWN"), { code: "PAYMENT_PROVIDER_UNKNOWN" });
}

/** Fake payments are a development tool; production refuses them whatever the console says. */
export function fakePaymentsAllowed(payment, { env = process.env } = {}) {
  return Boolean(payment?.fakePaymentsEnabled) && env.NODE_ENV !== "production";
}
