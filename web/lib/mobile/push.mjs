// Web Push on the phone: register the service worker, subscribe with the
// service's key, hand the subscription to the service for this pairing.
// Every step can be unavailable (browser, iOS outside the installed app,
// denied permission); each answers with why, never throws.

export function pushSupport(env = globalThis) {
  const nav = env.navigator;
  if (!nav?.serviceWorker || !env.PushManager || !env.Notification) return { supported: false, reason: "unsupported" };
  const ua = nav.userAgent || "";
  const ios = /iPhone|iPad|iPod/i.test(ua);
  const standalone = env.matchMedia?.("(display-mode: standalone)").matches || nav.standalone === true;
  // iOS delivers web push only to a web app added to the home screen.
  if (ios && !standalone) return { supported: false, reason: "ios_needs_install" };
  if (env.Notification.permission === "denied") return { supported: false, reason: "denied" };
  return { supported: true, permission: env.Notification.permission };
}

function keyBytes(base64url) {
  const padded = `${base64url}${"=".repeat((4 - (base64url.length % 4)) % 4)}`.replace(/-/g, "+").replace(/_/g, "/");
  return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
}

export async function registerWorker(env = globalThis) {
  try { return await env.navigator.serviceWorker.register("/m/sw.js", { scope: "/m/" }); } catch { return null; }
}

/** Already subscribed on this phone? */
export async function currentSubscription(env = globalThis) {
  try {
    const reg = await env.navigator.serviceWorker.getRegistration("/m/");
    return reg ? await reg.pushManager.getSubscription() : null;
  } catch { return null; }
}

/** Ask, subscribe, tell the service. `client` is the relay client (authorizedPost). */
export async function enablePush(client, env = globalThis) {
  const support = pushSupport(env);
  if (!support.supported) return { ok: false, reason: support.reason };
  const permission = await env.Notification.requestPermission();
  if (permission !== "granted") return { ok: false, reason: "denied" };
  const reg = await registerWorker(env);
  if (!reg) return { ok: false, reason: "worker_failed" };
  const key = await client.authorizedPost("/api/mobile/push/key");
  if (!key.ok || !key.json?.publicKey) return { ok: false, reason: "no_key" };
  let subscription;
  try {
    subscription = (await reg.pushManager.getSubscription())
      || await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(key.json.publicKey) });
  } catch {
    return { ok: false, reason: "subscribe_failed" }; // e.g. the browser's push service is unreachable
  }
  const saved = await client.authorizedPost("/api/mobile/push/subscribe", { subscription: subscription.toJSON() });
  return saved.ok ? { ok: true } : { ok: false, reason: "save_failed" };
}

export async function disablePush(client, env = globalThis) {
  const subscription = await currentSubscription(env);
  if (!subscription) return { ok: true };
  const endpoint = subscription.endpoint;
  try { await subscription.unsubscribe(); } catch { /* already gone */ }
  await client.authorizedPost("/api/mobile/push/unsubscribe", { endpoint });
  return { ok: true };
}
