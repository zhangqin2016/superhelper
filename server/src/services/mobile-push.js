import crypto from "node:crypto";
import { config } from "../config.js";

/**
 * Reaching a paired phone whose page is closed or asleep.
 *
 * The relay hands a phone the desktop's frames while its page is connected.
 * When it is not — the screen locked, the app in the background — two frames
 * are worth waking someone for: a turn ended, and the desktop waits on its
 * user (a permission, a plan, a question). Those become a Web Push
 * notification to the pairing's subscriptions. The notification carries no
 * conversation content; tapping it opens the phone page, which reconnects and
 * shows the rest.
 *
 * Reach is the browser's push service's: Apple (installed web app on iOS
 * 16.4+), Mozilla and Microsoft are reachable from the service; Google's (FCM,
 * which Chrome on Android uses) is not reachable from mainland China, so such a
 * subscription fails and is counted, never retried in a loop.
 *
 * Keys (VAPID) are generated once and kept in app settings, the private half
 * encrypted. Every failure is contained: a push that cannot be sent changes
 * nothing about the relay.
 */

export const VAPID_SETTING = "mobile_web_push_vapid";
const RATE_MS = 20_000; // at most one notification per pairing and kind in this window
const MAX_FAILURES = 5; // a subscription that keeps failing is dropped

/** Pure: which notification a desktop→phone frame calls for, or null. */
export function pushKindForFrame(frame) {
  if (!frame || typeof frame !== "object") return null;
  if (frame.type === "turn.ended") {
    if (frame.status === "completed") return "done";
    if (frame.status === "failed" || frame.status === "stalled") return "failed";
    return null; // interrupted: the user stopped it
  }
  if (frame.type === "prompts.updated" && Array.isArray(frame.prompts) && frame.prompts.length) return "attention";
  return null;
}

const MESSAGES = Object.freeze({
  done: { title: "Lily：任务完成了", body: "电脑上的任务已完成，点开查看结果。" },
  failed: { title: "Lily：任务没有完成", body: "电脑上的任务出错或中断了，点开查看。" },
  attention: { title: "Lily 需要你确认", body: "电脑上的任务在等你批准或回答，点开处理。" },
});

/** Pure: the notification payload for a kind — no conversation content. */
export function pushPayload(kind) {
  const message = MESSAGES[kind];
  if (!message) return null;
  return { ...message, kind, url: "/m/pair", tag: `lily-${kind}` };
}

// Loaded on first use: the relay imports this module, and must not gain a
// database or library dependency at import time.
const deps = () => Promise.all([import("../db.js"), import("./app-settings.js"), import("./security.js"), import("web-push")])
  .then(([dbModule, settings, security, webPush]) => ({ db: dbModule.db, settings, security, webPush: webPush.default || webPush }));

let vapidCache = null;

/** The public key a phone subscribes with; generated on first use. */
export async function vapidPublicKey() {
  return (await vapid()).publicKey;
}

async function vapid() {
  if (vapidCache) return vapidCache;
  const { settings, security, webPush } = await deps();
  const saved = await settings.getAppSetting(VAPID_SETTING, null).catch(() => null);
  if (saved?.publicKey && saved?.privateKeyEncrypted) {
    vapidCache = { publicKey: saved.publicKey, privateKey: security.decryptSecret(saved.privateKeyEncrypted) };
    return vapidCache;
  }
  const keys = webPush.generateVAPIDKeys();
  await settings.setAppSetting(VAPID_SETTING, { publicKey: keys.publicKey, privateKeyEncrypted: security.encryptSecret(keys.privateKey), createdAt: new Date().toISOString() });
  vapidCache = keys;
  return vapidCache;
}

const lastSent = new Map(); // `${grantId}:${kind}` → ms

/** Store (or refresh) a phone's subscription for its pairing. */
export async function saveSubscription({ grantId, mobileDeviceId, subscription }) {
  const endpoint = String(subscription?.endpoint || "");
  const p256dh = String(subscription?.keys?.p256dh || "");
  const auth = String(subscription?.keys?.auth || "");
  if (!/^https:\/\//.test(endpoint) || !p256dh || !auth) return { ok: false, code: "PUSH_SUBSCRIPTION_INVALID" };
  const { db } = await deps();
  await db.insertInto("mobile_push_subscriptions")
    .values({ id: `mps_${crypto.randomUUID()}`, grant_id: grantId, mobile_device_id: mobileDeviceId, endpoint, p256dh, auth })
    .onConflict((oc) => oc.column("endpoint").doUpdateSet({ grant_id: grantId, mobile_device_id: mobileDeviceId, p256dh, auth, failures: 0 }))
    .execute();
  return { ok: true };
}

/** A pairing that ended takes its subscriptions with it. */
export async function removeGrantSubscriptions(grantId) {
  const { db } = await deps();
  await db.deleteFrom("mobile_push_subscriptions").where("grant_id", "=", String(grantId || "")).execute();
  return { ok: true };
}

export async function removeSubscription({ grantId, endpoint }) {
  const { db } = await deps();
  await db.deleteFrom("mobile_push_subscriptions").where("grant_id", "=", grantId).where("endpoint", "=", String(endpoint || "")).execute();
  return { ok: true };
}

/**
 * A frame the desktop sent while no phone page of `grantId` was connected.
 * Fire-and-forget from the relay; resolves to what happened (for tests/logs).
 */
export async function notifyUndelivered(grantId, frame, { now = Date.now(), send = null } = {}) {
  const kind = pushKindForFrame(frame);
  if (!kind || !grantId) return { sent: 0, reason: "not_notable" };
  const key = `${grantId}:${kind}`;
  if (now - (lastSent.get(key) || 0) < RATE_MS) return { sent: 0, reason: "rate_limited" };
  lastSent.set(key, now);
  try {
    const { db, webPush } = await deps();
    const subs = await db.selectFrom("mobile_push_subscriptions").selectAll().where("grant_id", "=", grantId).execute();
    if (!subs.length) return { sent: 0, reason: "no_subscription" };
    const keys = await vapid();
    const subject = config.webBaseUrl || "https://www.lilywb.cn";
    const payload = JSON.stringify(pushPayload(kind));
    const deliver = send || ((sub, body, options) => webPush.sendNotification(sub, body, options));
    let sent = 0;
    for (const sub of subs) {
      try {
        await deliver({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, payload, {
          TTL: 3600, urgency: kind === "attention" ? "high" : "normal", topic: kind,
          vapidDetails: { subject, publicKey: keys.publicKey, privateKey: keys.privateKey },
          timeout: 8000,
        });
        sent += 1;
        await db.updateTable("mobile_push_subscriptions").set({ last_sent_at: new Date(now), failures: 0 }).where("id", "=", sub.id).execute();
      } catch (err) {
        const gone = err?.statusCode === 404 || err?.statusCode === 410;
        if (gone || sub.failures + 1 >= MAX_FAILURES) await db.deleteFrom("mobile_push_subscriptions").where("id", "=", sub.id).execute();
        else await db.updateTable("mobile_push_subscriptions").set({ failures: sub.failures + 1 }).where("id", "=", sub.id).execute();
      }
    }
    return { sent, reason: sent ? "sent" : "failed" };
  } catch {
    return { sent: 0, reason: "error" }; // never the relay's problem
  }
}

export function resetPushStateForTests() {
  lastSent.clear();
  vapidCache = null;
}
