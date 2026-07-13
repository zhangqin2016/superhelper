process.env.SESSION_SECRET ||= "test-session-secret-abcdefghijklmnop";
process.env.DATABASE_URL ||= "postgres://localhost:5432/test";
const { default: Fastify } = await import("fastify");
const { WebSocket } = await import("ws");
const { registerMobileRelay } = await import("./src/services/mobile-relay.js");
const grant = { id: "g1", status: "active", user_id: "u1", desktop_device_id: "dtop", mobile_device_id: "dmob" };
const app = Fastify({ logger: false });
registerMobileRelay(app, {
  verifyAccessToken: (t) => t === "tok_dtop" ? { ok: true, userId: "u1", sessionId: "s", deviceId: "dtop" }
                        : t === "tok_dmob" ? { ok: true, userId: "u1", sessionId: "s", deviceId: "dmob" }
                        : { ok: false, code: "BAD" },
  lookupActiveGrant: async (id) => id === "g1" ? grant : null,
});
await app.listen({ port: 0, host: "127.0.0.1" });
const port = app.server.address().port;
const base = `ws://127.0.0.1:${port}/api/mobile/relay`;
const connect = (role, deviceId, token) => new Promise((res, rej) => {
  const ws = new WebSocket(`${base}?role=${role}&grantId=g1&deviceId=${deviceId}&token=${token}`);
  ws.on("open", () => res(ws)); ws.on("error", rej); setTimeout(() => rej(new Error(role+" timeout")), 3000);
});
const results = [];
const desktop = await connect("desktop", "dtop", "tok_dtop");
const mobile = await connect("mobile", "dmob", "tok_dmob");
desktop.on("message", (d) => { const m = JSON.parse(d.toString()); if (m.type === "command") results.push("desktop_got:"+m.text); });
await new Promise(r => setTimeout(r, 100));
mobile.send(JSON.stringify({ type: "command", text: "hello-from-phone" }));
await new Promise(r => setTimeout(r, 200));
let rejected = false;
await new Promise((r) => { const bad = new WebSocket(`${base}?role=mobile&grantId=g1&deviceId=dmob&token=WRONG`); bad.on("error", () => { rejected = true; r(); }); bad.on("open", () => r()); setTimeout(r, 1500); });
console.log("ROUTED:", results.join(",") || "(none)");
console.log("UNAUTH_REJECTED:", rejected);
console.log("VERDICT:", results.includes("desktop_got:hello-from-phone") && rejected ? "PASS" : "FAIL");
await app.close();
