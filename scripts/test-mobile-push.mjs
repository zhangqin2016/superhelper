#!/usr/bin/env node
// Telling a paired phone, while its page is closed, that a task finished or
// that the desktop waits on its user — and nothing more.
//   - which frames notify: turn.ended completed/failed/stalled, prompts.updated
//     with prompts; never an interrupt (the user stopped it), never an empty list;
//   - the payload carries no conversation content;
//   - the options the service sends with are accepted by the real web-push
//     library (VAPID-signed, aes128gcm-encrypted) — checked without a network;
//   - the phone offers the switch only where web push can work (iPhone only
//     inside the installed app), and its service worker shows and opens;
//   - with a scratch Postgres (LILY_TEST_DATABASE_URL), the server's full
//     mobile e2e: subscribe with the grant token, a delivered frame is not
//     pushed, an undelivered one is, an ended pairing drops its subscriptions.
// [gate: mobile-push]
// Run: node scripts/test-mobile-push.mjs
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

process.env.DATABASE_URL ||= "postgres://user:pass@localhost:5432/lily_push_unit";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const requireServer = createRequire(path.join(ROOT, "server/package.json"));
const webPush = requireServer("web-push");
const { pushKindForFrame, pushPayload } = await import(pathToFileURL(path.join(ROOT, "server/src/services/mobile-push.js")).href);
const { pushSupport } = await import(pathToFileURL(path.join(ROOT, "web/lib/mobile/push.mjs")).href);

let checks = 0;
const check = async (name, fn) => { await fn(); checks += 1; console.log(`ok - ${name}`); };

await check("only a finished task or a waiting desktop notifies", () => {
  assert.equal(pushKindForFrame({ type: "turn.ended", status: "completed", text: "答案" }), "done");
  assert.equal(pushKindForFrame({ type: "turn.ended", status: "failed" }), "failed");
  assert.equal(pushKindForFrame({ type: "turn.ended", status: "stalled" }), "failed");
  assert.equal(pushKindForFrame({ type: "turn.ended", status: "interrupted" }), null, "the user stopped it: no alarm");
  assert.equal(pushKindForFrame({ type: "prompts.updated", prompts: [{ requestId: "p" }] }), "attention");
  assert.equal(pushKindForFrame({ type: "prompts.updated", prompts: [] }), null, "the last card answered is not news");
  for (const type of ["assistant.delta", "assistant.final", "turn.started", "tool.started", "session.context", "todos.updated"]) {
    assert.equal(pushKindForFrame({ type, text: "x" }), null, type);
  }
});

await check("the notification says to look, never what was said", () => {
  for (const kind of ["done", "failed", "attention"]) {
    const payload = pushPayload(kind);
    assert.deepEqual(Object.keys(payload).sort(), ["body", "kind", "tag", "title", "url"]);
    assert.equal(payload.url, "/m/pair");
  }
  const frame = { type: "turn.ended", status: "completed", text: "机密：客户名单在 D:\\\\clients.xlsx" };
  assert.doesNotMatch(JSON.stringify(pushPayload(pushKindForFrame(frame))), /机密|clients/, "frame text never enters the payload");
  assert.equal(pushPayload("nope"), null);
});

await check("the real web-push library accepts the service's send options (VAPID + aes128gcm)", () => {
  const keys = webPush.generateVAPIDKeys();
  const ecdh = crypto.createECDH("prime256v1"); ecdh.generateKeys();
  const sub = { endpoint: "https://web.push.apple.com/QOfake", keys: { p256dh: ecdh.getPublicKey().toString("base64url"), auth: crypto.randomBytes(16).toString("base64url") } };
  // The same options notifyUndelivered passes (services/mobile-push.js).
  const details = webPush.generateRequestDetails(sub, JSON.stringify(pushPayload("attention")), {
    TTL: 3600, urgency: "high", topic: "attention",
    vapidDetails: { subject: "https://www.lilywb.cn", publicKey: keys.publicKey, privateKey: keys.privateKey },
    timeout: 8000,
  });
  assert.equal(details.method, "POST");
  assert.equal(details.headers["Content-Encoding"], "aes128gcm", "encrypted for the subscription");
  assert.match(details.headers.Authorization, /^vapid t=.+, k=/, "signed with the service's VAPID key");
  assert.equal(details.headers.Urgency, "high");
  assert.ok(details.body.length > 0);
  const source = fs.readFileSync(path.join(ROOT, "server/src/services/mobile-push.js"), "utf8");
  assert.match(source, /TTL: 3600, urgency: kind === "attention" \? "high" : "normal", topic: kind,/, "the options checked here are the ones the service sends");
});

await check("the phone offers the switch only where web push can work", () => {
  const env = ({ ua = "Mozilla/5.0 (Linux; Android 14)", standalone = false, permission = "default", sw = true } = {}) => ({
    navigator: { userAgent: ua, ...(sw ? { serviceWorker: {} } : {}), standalone },
    PushManager: function PushManager() {},
    Notification: { permission },
    matchMedia: () => ({ matches: standalone }),
  });
  assert.deepEqual(pushSupport(env()), { supported: true, permission: "default" });
  assert.equal(pushSupport(env({ ua: "iPhone OS 17_4 like Mac OS X Safari" })).reason, "ios_needs_install", "iPhone: only the home-screen app gets push");
  assert.equal(pushSupport(env({ ua: "iPhone OS 17_4 like Mac OS X Safari", standalone: true })).supported, true);
  assert.equal(pushSupport(env({ permission: "denied" })).reason, "denied");
  assert.equal(pushSupport(env({ sw: false })).reason, "unsupported");
});

await check("the service worker shows the notification and opens the page", () => {
  const sw = fs.readFileSync(path.join(ROOT, "web/public/m/sw.js"), "utf8");
  assert.match(sw, /addEventListener\("push"/);
  assert.match(sw, /showNotification\(/);
  assert.match(sw, /addEventListener\("notificationclick"/);
  assert.match(sw, /openWindow\(url\)/);
  assert.doesNotMatch(sw, /caches\.|addEventListener\("fetch"/, "it caches nothing: the page always talks to the live desktop");
  const push = fs.readFileSync(path.join(ROOT, "web/lib/mobile/push.mjs"), "utf8");
  assert.match(push, /register\("\/m\/sw\.js", \{ scope: "\/m\/" \}\)/, "registered inside the installed app's scope");
});

await check("the server's full mobile e2e (push included) runs when a scratch Postgres is provided", async () => {
  const url = process.env.LILY_TEST_DATABASE_URL || "";
  if (!url) {
    console.log("  (skipped: set LILY_TEST_DATABASE_URL to a scratch Postgres to run the closed loop)");
    return;
  }
  const pg = requireServer("pg");
  const name = `lily_mobile_e2e_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const admin = new pg.Client({ connectionString: url });
  await admin.connect();
  await admin.query(`create database ${name}`);
  try {
    const scratch = new URL(url); scratch.pathname = `/${name}`;
    const run = spawnSync(process.execPath, [path.join(ROOT, "server/scripts/mobile-command-e2e.mjs")], {
      cwd: path.join(ROOT, "server"), env: { ...process.env, DATABASE_URL: scratch.href }, encoding: "utf8", timeout: 240_000,
    });
    assert.equal(run.status, 0, `server mobile e2e failed:\n${run.stdout.slice(-3000)}\n${run.stderr.slice(-3000)}`);
    assert.match(run.stdout, /mobile-command-e2e: ok/);
  } finally {
    await admin.query(`drop database if exists ${name} with (force)`);
    await admin.end();
  }
});

console.log(`\n${checks} checks passed (mobile push)`);
