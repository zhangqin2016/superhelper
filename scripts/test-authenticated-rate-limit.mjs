import assert from "node:assert/strict";
process.env.SESSION_SECRET = "rate-limit-test-session-secret";
process.env.ADMIN_TOKEN = "rate-limit-test-admin";
process.env.MODEL_GATEWAY_TOKEN_SECRET = "rate-limit-test-gateway-secret";
const { createAccessToken, createWebSessionToken } = await import("../server/src/services/account-auth.js");
const { createAdminSessionToken } = await import("../server/src/services/security.js");
const { signModelGatewayToken } = await import("../server/src/services/model-gateway/auth.js");
const { createRequestRateLimiter } = await import("../server/src/services/request-rate-limit.js");
const request = (headers = {}, cookies = {}) => ({ ip: "127.0.0.1", headers, cookies });
const access = (userId, sessionId) => request({ authorization: `Bearer ${createAccessToken({ userId, sessionId })}` });
const web = (userId, sessionId) => request({}, { lily_user_session: createWebSessionToken({ userId, sessionId }) });
let now = 0;
const limited = createRequestRateLimiter({ max: 2, windowMs: 1000, now: () => now });
assert.equal(limited(access("alice", "a1")), true);
assert.equal(limited(web("alice", "a2")), true);
assert.equal(limited(access("alice", "a3")), false, "sessions and auth surfaces share one account budget");
assert.equal(limited(access("bob", "b1")), true, "another user behind the same proxy has an independent budget");
const admin = request({ authorization: `Bearer ${process.env.ADMIN_TOKEN}` });
assert.equal(limited(admin), true);
assert.equal(limited(request({}, { lily_admin_session: createAdminSessionToken() })), true);
assert.equal(limited(admin), false, "admin cookie and static token share one admin budget");
const gateway = (userId, deviceId) => request({ authorization: `Bearer ${signModelGatewayToken({ userId, deviceId, sessionId: "gateway-session" })}` });
assert.equal(limited(gateway("alice", "different-device")), false, "gateway user shares account budget");
assert.equal(limited(gateway("", "device-one")), true);
assert.equal(limited(gateway("", "device-one")), true);
assert.equal(limited(gateway("", "device-one")), false);
assert.equal(limited(gateway("", "device-two")), true);
const anonymous = createRequestRateLimiter({ max: 2, windowMs: 1000, now: () => now });
assert.equal(anonymous(request({ authorization: "Bearer forged-1" }, { lily_user_session: "forged-cookie-1" })), true);
assert.equal(anonymous(request({ authorization: "Bearer forged-2", "x-forwarded-for": "10.0.0.2" }, { lily_admin_session: "forged-cookie-2" })), true);
assert.equal(anonymous(request({ authorization: "Bearer forged-3" })), false, "rotating unsigned credentials cannot evade the shared IP budget");
now = 1000;
assert.equal(anonymous(request()), true);
assert.equal(limited(access("alice", "a4")), true, "budget resets at the window boundary");
console.log("authenticated request rate limit: ok");

// Exercise the same hook contract over HTTP: anonymous proxy traffic cannot
// exhaust a verified admin, while each identity still receives a real 429.
const { createRequire } = await import("node:module");
const requireServer = createRequire(new URL("../server/package.json", import.meta.url));
const app = requireServer("fastify")({ logger: false });
await app.register(requireServer("@fastify/cookie"));
const check = createRequestRateLimiter({ max: 2 });
app.addHook("preHandler", async (req, reply) => {
  if (!check(req)) return reply.code(429).send({ ok: false, code: "RATE_LIMITED" });
});
app.get("/api/test", async () => ({ ok: true }));
try {
  assert.equal((await app.inject("/api/test")).statusCode, 200);
  assert.equal((await app.inject("/api/test")).statusCode, 200);
  assert.equal((await app.inject("/api/test")).statusCode, 429);
  assert.equal((await app.inject({ url: "/api/test", headers: admin.headers })).statusCode, 200);
  assert.equal((await app.inject({ url: "/api/test", headers: { cookie: `lily_admin_session=${createAdminSessionToken()}` } })).statusCode, 200);
  assert.equal((await app.inject({ url: "/api/test", headers: admin.headers })).statusCode, 429);
  assert.equal((await app.inject({ url: "/api/test", headers: access("employee", "session").headers })).statusCode, 200);
} finally { await app.close(); }
console.log("authenticated rate limit HTTP isolation: ok");
