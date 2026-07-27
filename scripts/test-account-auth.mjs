#!/usr/bin/env node
import assert from "node:assert/strict";

process.env.SESSION_SECRET = "test-session-secret";
process.env.USER_TOKEN_PEPPER = "test-user-pepper";
process.env.SMS_CODE_PEPPER = "test-sms-pepper";
process.env.DATABASE_URL ||= "postgres://user:pass@localhost:5432/lily_test";

const accountAuth = await import("../server/src/services/account-auth.js");
const wallet = await import("../server/src/services/wallet.js");
const gatewayAuth = await import("../server/src/services/model-gateway/auth.js");
const gatewayUsage = await import("../server/src/services/model-gateway/usage.js");
const aliyunSms = await import("../server/src/services/sms-provider-aliyun.js");
const { config } = await import("../server/src/config.js");

assert.equal(accountAuth.normalizePhoneE164("13800000000"), "+8613800000000");
assert.equal(accountAuth.normalizePhoneE164("+86 138 0000 0000"), "+8613800000000");
assert.equal(accountAuth.normalizePhoneE164("001"), "");
assert.equal(aliyunSms.aliyunPhoneNumber("+8613800000000"), "13800000000");
assert.equal(aliyunSms.aliyunPhoneNumber("+14155550100"), "14155550100");

const codeHash = accountAuth.hashSmsCode("+8613800000000", "123456");
assert.equal(accountAuth.verifySmsCodeHash("+8613800000000", "123456", codeHash), true);
assert.equal(accountAuth.verifySmsCodeHash("+8613800000000", "123457", codeHash), false);
assert.equal(accountAuth.verifySmsCodeHash("+8613800000001", "123456", codeHash), false);

const refreshToken = accountAuth.createRefreshToken();
assert.match(refreshToken, /^lily_refresh_/);
assert.equal(accountAuth.hashRefreshToken(refreshToken), accountAuth.hashRefreshToken(refreshToken));
assert.notEqual(accountAuth.hashRefreshToken(`${refreshToken}x`), accountAuth.hashRefreshToken(refreshToken));

const accessToken = accountAuth.createAccessToken({
  userId: "usr_test",
  sessionId: "sess_test",
  deviceId: "dev_test",
  scopes: ["account", "billing", "model_gateway", "media_gateway"],
  nowMs: Date.parse("2026-07-02T00:00:00.000Z"),
  ttlSeconds: 900,
});
assert.match(accessToken, /^lily_access_/);
const verified = accountAuth.verifyAccessToken(accessToken, {
  nowMs: Date.parse("2026-07-02T00:05:00.000Z"),
});
assert.equal(verified.ok, true);
assert.equal(verified.userId, "usr_test");
assert.equal(verified.sessionId, "sess_test");
assert.equal(verified.deviceId, "dev_test");
assert.deepEqual(verified.scopes, ["account", "billing", "model_gateway", "media_gateway"]);
assert.equal(accountAuth.verifyAccessToken(accessToken, {
  nowMs: Date.parse("2026-07-02T00:20:00.000Z"),
}).code, "ACCESS_TOKEN_EXPIRED");
assert.equal(accountAuth.verifyAccessToken(`${accessToken}x`, {
  nowMs: Date.parse("2026-07-02T00:05:00.000Z"),
}).code, "ACCESS_TOKEN_INVALID");

const webSession = accountAuth.createWebSessionToken({
  userId: "usr_test",
  sessionId: "sess_web",
  nowMs: Date.parse("2026-07-02T00:00:00.000Z"),
  ttlSeconds: 3600,
});
assert.match(webSession, /^lily_user_/);
assert.deepEqual(accountAuth.verifyWebSessionToken(webSession, {
  nowMs: Date.parse("2026-07-02T00:30:00.000Z"),
}), {
  ok: true,
  userId: "usr_test",
  sessionId: "sess_web",
});
assert.equal(accountAuth.verifyWebSessionToken(webSession, {
  nowMs: Date.parse("2026-07-02T02:00:00.000Z"),
}).code, "WEB_SESSION_EXPIRED");
assert.equal(accountAuth.verifyWebSessionToken(`${webSession}x`, {
  nowMs: Date.parse("2026-07-02T00:30:00.000Z"),
}).code, "WEB_SESSION_INVALID");

const lowRisk = accountAuth.evaluateSmsRisk({
  phoneRecentCount: 0,
  ipRecentCount: 0,
  deviceRecentCount: 0,
  prefixRecentCount: 0,
  hasActiveCode: false,
});
assert.deepEqual(lowRisk, { level: "low", action: "send", reason: "" });

const cooldown = accountAuth.evaluateSmsRisk({
  phoneRecentCount: 0,
  ipRecentCount: 0,
  deviceRecentCount: 0,
  prefixRecentCount: 0,
  hasActiveCode: true,
});
assert.equal(cooldown.action, "cooldown");

const captcha = accountAuth.evaluateSmsRisk({
  phoneRecentCount: 4,
  ipRecentCount: 20,
  deviceRecentCount: 7,
  prefixRecentCount: 40,
  hasActiveCode: false,
});
assert.equal(captcha.level, "medium");
assert.equal(captcha.action, "captcha_required");

const blocked = accountAuth.evaluateSmsRisk({
  phoneRecentCount: 10,
  ipRecentCount: 120,
  deviceRecentCount: 30,
  prefixRecentCount: 200,
  hasActiveCode: false,
});
assert.equal(blocked.level, "high");
assert.equal(blocked.action, "blocked");

const grants = wallet.createSignupGrants({
  userId: "usr_test",
  now: new Date("2026-07-02T00:00:00.000Z"),
  freeTokens: 100000,
  freeImages: 3,
  freeVideos: 1,
  freeDays: 7,
});
assert.equal(grants.length, 3);
assert.equal(grants[0].grant_type, "free_tokens");
assert.equal(grants[0].resource_type, "token");
assert.equal(grants[0].unit_total, 100000);
assert.equal(grants[1].grant_type, "free_image_generations");
assert.equal(grants[1].resource_type, "image_generation");
assert.equal(grants[1].unit_total, 3);
assert.equal(grants[2].grant_type, "free_video_generations");
assert.equal(grants[2].resource_type, "video_generation");
assert.equal(grants[2].unit_total, 1);

const summary = wallet.summarizeEntitlements(grants, {
  now: new Date("2026-07-03T00:00:00.000Z"),
});
assert.equal(summary.usable, true);
assert.equal(summary.tokenBalance, 100000);
assert.equal(summary.imageGenerationsRemaining, 3);
assert.equal(summary.videoGenerationsRemaining, 1);
assert.equal(summary.freeGrantExpiresAt, "2026-07-09T00:00:00.000Z");

const expired = wallet.summarizeEntitlements(grants, {
  now: new Date("2026-07-10T00:00:00.000Z"),
});
assert.equal(expired.usable, false);
assert.equal(expired.tokenBalance, 0);
assert.equal(expired.imageGenerationsRemaining, 0);
assert.equal(expired.videoGenerationsRemaining, 0);

const accountGatewayToken = gatewayAuth.signModelGatewayToken({
  deviceId: "dev_test",
  licenseId: "lic_test",
  providerId: "vision",
  userId: "usr_test",
  sessionId: "sess_test",
  expiresAt: "2099-07-02T01:00:00.000Z",
});
const verifiedGatewayToken = gatewayAuth.verifyModelGatewayToken(accountGatewayToken, "vision");
assert.equal(verifiedGatewayToken.ok, true);
assert.equal(verifiedGatewayToken.deviceId, "dev_test");
assert.equal(verifiedGatewayToken.userId, "usr_test");
assert.equal(verifiedGatewayToken.sessionId, "sess_test");

const recentlyExpiredGatewayToken = gatewayAuth.signModelGatewayToken({
  deviceId: "dev_test",
  licenseId: "lic_test",
  providerId: "vision",
  expiresAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
});
assert.equal(
  gatewayAuth.verifyModelGatewayToken(recentlyExpiredGatewayToken, "vision").code,
  "MODEL_GATEWAY_TOKEN_EXPIRED",
);
config.modelGatewayExpiredTokenGraceSeconds = 60 * 60;
const graceVerifiedGatewayToken = gatewayAuth.verifyModelGatewayToken(recentlyExpiredGatewayToken, "vision");
assert.equal(graceVerifiedGatewayToken.ok, true);
assert.equal(graceVerifiedGatewayToken.expiredGrace, true);
assert.equal(
  gatewayAuth.verifyModelGatewayToken(recentlyExpiredGatewayToken, "deepseek").code,
  "MODEL_GATEWAY_PROVIDER_MISMATCH",
);
const tooOldGatewayToken = gatewayAuth.signModelGatewayToken({
  deviceId: "dev_test",
  licenseId: "lic_test",
  providerId: "vision",
  expiresAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
});
assert.equal(
  gatewayAuth.verifyModelGatewayToken(tooOldGatewayToken, "vision").code,
  "MODEL_GATEWAY_TOKEN_EXPIRED",
);
config.modelGatewayExpiredTokenGraceSeconds = 0;

const selected = wallet.selectGrantsForConsumption(grants, {
  resourceType: "image_generation",
  units: 2,
  now: new Date("2026-07-03T00:00:00.000Z"),
});
assert.equal(selected.ok, true);
assert.equal(selected.debits.length, 1);
assert.equal(selected.debits[0].grant.id, grants[1].id);
assert.equal(selected.debits[0].units, 2);

const insufficient = wallet.selectGrantsForConsumption(grants, {
  resourceType: "video_generation",
  units: 2,
  now: new Date("2026-07-03T00:00:00.000Z"),
});
assert.equal(insufficient.ok, false);
assert.equal(insufficient.code, "ENTITLEMENT_INSUFFICIENT");

const chatUsage = gatewayUsage.chatTokenUsage({
  model: "test-model",
  system: "You are concise.",
  messages: [
    { role: "user", content: "Write a short plan for account billing." },
  ],
});
assert.equal(chatUsage.feature, "chat_model");
assert.equal(chatUsage.resourceType, "token");
assert.equal(chatUsage.units > 1, true);
assert.equal(chatUsage.specKey, "test-model");

const anonymousToken = gatewayAuth.signModelGatewayToken({
  deviceId: "dev_test",
  providerId: "deepseek",
  expiresAt: "2099-07-02T01:00:00.000Z",
});
const licenseToken = gatewayAuth.signModelGatewayToken({
  deviceId: "dev_test",
  licenseId: "lic_test",
  providerId: "deepseek",
  expiresAt: "2099-07-02T01:00:00.000Z",
});
assert.equal(gatewayUsage.gatewayAccountRequired({ token: gatewayAuth.verifyModelGatewayToken(anonymousToken, "deepseek"), enforcementEnabled: true }).ok, false);
assert.equal(gatewayUsage.gatewayAccountRequired({ token: verifiedGatewayToken, enforcementEnabled: true }).ok, true);
assert.equal(
  gatewayUsage.gatewayAccountRequired({ token: verifiedGatewayToken, enforcementEnabled: true }).licenseAuthorized,
  true,
  "a logged-in user with a server-validated activation must keep license access instead of consuming the account wallet",
);
assert.equal(gatewayUsage.gatewayAccountRequired({ token: gatewayAuth.verifyModelGatewayToken(licenseToken, "deepseek"), enforcementEnabled: true }).ok, true);
assert.equal(gatewayUsage.gatewayAccountRequired({ token: gatewayAuth.verifyModelGatewayToken(licenseToken, "deepseek"), enforcementEnabled: true }).licenseAuthorized, true);

// Free trial: a downloaded-but-not-logged-in device with a signed, still-valid
// trial window must be granted access even when usage enforcement is on —
// otherwise the operator-configured trial (license_trial_days) is dead on arrival.
const nowMs = Date.parse("2026-07-09T00:00:00.000Z");
const activeTrialToken = gatewayAuth.verifyModelGatewayToken(
  gatewayAuth.signModelGatewayToken({
    deviceId: "dev_trial",
    providerId: "deepseek",
    trialEndsAt: "2026-07-11T00:00:00.000Z",
    expiresAt: "2099-07-02T01:00:00.000Z",
  }),
  "deepseek",
);
assert.equal(activeTrialToken.trialEndsAt, "2026-07-11T00:00:00.000Z", "trial expiry is signed into and recovered from the gateway token");
const activeTrial = gatewayUsage.gatewayAccountRequired({ token: activeTrialToken, enforcementEnabled: true, nowMs });
assert.equal(activeTrial.ok, true, "an active trial device is allowed under enforcement");
assert.equal(activeTrial.trial, true, "trial access is flagged (so usage stays free during the window, not wallet-debited)");

const expiredTrialToken = gatewayAuth.verifyModelGatewayToken(
  gatewayAuth.signModelGatewayToken({
    deviceId: "dev_trial",
    providerId: "deepseek",
    trialEndsAt: "2026-07-01T00:00:00.000Z",
    expiresAt: "2099-07-02T01:00:00.000Z",
  }),
  "deepseek",
);
const expiredTrial = gatewayUsage.gatewayAccountRequired({ token: expiredTrialToken, enforcementEnabled: true, nowMs });
assert.equal(expiredTrial.ok, false, "an expired trial falls through to requiring login/activation");
assert.equal(expiredTrial.code, "ACCOUNT_LOGIN_REQUIRED", "after the trial window the user must log in or activate");

console.log("account auth and wallet helpers ok");
