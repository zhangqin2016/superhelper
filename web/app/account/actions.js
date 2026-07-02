"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { userApiPost } from "../../lib/user-api";

function text(formData, key) {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

function actionFormData(first, second) {
  return second instanceof FormData ? second : first;
}

function safeAccountNext(value, fallback = "/account/billing") {
  if (!value || !value.startsWith("/account/")) return fallback;
  if (value.startsWith("//")) return fallback;
  return value;
}

async function webDeviceId() {
  const store = await cookies();
  const existing = store.get("lily_web_device_id")?.value || "";
  if (existing) return existing;
  const id = `web_${crypto.randomUUID()}`;
  store.set("lily_web_device_id", id, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 60 * 24 * 365,
  });
  return id;
}

function devicePayload(deviceId) {
  return {
    deviceId,
    platform: "web",
    arch: "browser",
    appVersion: "web",
  };
}

export async function sendAccountSmsAction(_previousState, formData) {
  try {
    const phone = text(formData, "phone");
    const deviceId = await webDeviceId();
    const result = await userApiPost("/api/auth/sms/send", {
      phone,
      purpose: "login",
      deviceId,
    });
    return {
      ok: true,
      message: result.devCode ? `验证码已发送。开发验证码：${result.devCode}` : "验证码已发送。",
      phone,
    };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : "验证码发送失败。", phone: text(formData, "phone") };
  }
}

export async function loginAccountAction(_previousState, formData) {
  let nextUrl = safeAccountNext(text(formData, "next"));
  try {
    const phone = text(formData, "phone");
    const code = text(formData, "code");
    const deviceId = await webDeviceId();
    const result = await userApiPost("/api/auth/sms/login", {
      ...devicePayload(deviceId),
      phone,
      code,
    });
    if (!result.webSessionToken) return { ok: false, message: "登录态创建失败。", phone };
    const store = await cookies();
    store.set("lily_user_session", result.webSessionToken, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      maxAge: 60 * 60 * 24 * 7,
    });
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : "登录失败。", phone: text(formData, "phone") };
  }
  redirect(nextUrl);
}

export async function createBillingOrderAction(previousStateOrFormData, maybeFormData) {
  const formData = actionFormData(previousStateOrFormData, maybeFormData);
  const productId = text(formData, "productId");
  const payProvider = text(formData, "payProvider") || "wechat";
  let nextUrl = "";
  try {
    if (!productId) return { ok: false, message: "请选择要购买的商品。" };
    const result = await userApiPost("/api/billing/orders", {
      productId,
      payProvider,
    });
    nextUrl = `/account/orders?created=${encodeURIComponent(result.order?.id || "")}`;
  } catch (error) {
    if (error instanceof Error && /USER_LOGIN_REQUIRED|WEB_SESSION/.test(error.message)) {
      nextUrl = "/account/login?next=/account/billing";
    } else {
      return { ok: false, message: error instanceof Error ? error.message : "创建订单失败。" };
    }
  }
  redirect(nextUrl);
}

export async function mockPayBillingOrderAction(previousStateOrFormData, maybeFormData) {
  const formData = actionFormData(previousStateOrFormData, maybeFormData);
  const orderId = text(formData, "orderId");
  let nextUrl = "/account/entitlements?paid=1";
  try {
    await userApiPost(`/api/billing/orders/${encodeURIComponent(orderId)}/mock-pay`, {});
  } catch (error) {
    if (error instanceof Error && /USER_LOGIN_REQUIRED|WEB_SESSION/.test(error.message)) {
      nextUrl = "/account/login?next=/account/orders";
    } else {
      nextUrl = `/account/orders?error=${encodeURIComponent(error instanceof Error ? error.message : "支付失败")}`;
    }
  }
  redirect(nextUrl);
}

export async function logoutAccountAction() {
  const store = await cookies();
  try {
    await userApiPost("/api/auth/session/logout", {});
  } catch {
    // Local cookie removal still completes logout from the website if the API is unavailable.
  }
  store.delete("lily_user_session");
  redirect("/account/login");
}
