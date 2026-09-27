#!/usr/bin/env node
/**
 * /api/legal/search and /api/legal/article: the only door to the served corpus.
 *
 * The first version checked the device signature and nothing else — any
 * signed device read the whole corpus, an admin disabling the pack changed
 * nothing, no quota bounded a scraper, and the V2 body went out verbatim.
 * Now: signature, then the pack's entitlement, then a per-device quota; only
 * whitelisted fields leave; the audit log carries no question text.
 */
import assert from "node:assert/strict";
import http from "node:http";

process.env.DATABASE_URL ||= "postgres://test:test@127.0.0.1:1/none";
const gatewayCalls = [];
const gateway = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => { body += c; });
  req.on("end", () => {
    gatewayCalls.push({ url: req.url, body: body ? JSON.parse(body) : null });
    const reply = (status, json) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(json)); };
    if (req.url.startsWith("/article")) {
      return new URL(req.url, "http://x").searchParams.get("article") === "第九百条"
        ? reply(404, { ok: false, error: "LEGAL_ARTICLE_NOT_FOUND" })
        : reply(200, { ok: true, corpusVersion: "V28", article: { id: "a#1", law: "劳动合同法", title: "中华人民共和国劳动合同法", article: "第三十九条", text: "全".repeat(5000), validity: "effective", internalPath: "/opt/secret" } });
    }
    reply(200, { ok: true, corpusVersion: "V28", laws: [{ name: "劳动合同法", source: "caller", weight: 1 }],
      results: [{ id: "a#1", law: "劳动合同法", title: "中华人民共和国劳动合同法", article: "第三十九条", text: "长".repeat(4000), validity: "effective", internalPath: "/opt/secret", score: 1 }] });
  });
});
await new Promise((resolve) => gateway.listen(0, "127.0.0.1", resolve));
process.env.LILY_LEGAL_GATEWAY_URL = `http://127.0.0.1:${gateway.address().port}`;

const Fastify = (await import("../server/node_modules/fastify/fastify.js")).default;
const { registerPublicLegalSearchRoutes, createDeviceQuota } = await import("../server/src/routes/public/legal-search.js");
let checks = 0;
const check = (label) => { checks += 1; console.log(`ok - ${label}`); };

let signed = true;
let entitled = { ok: true };
const logs = [];
const app = Fastify({ logger: { level: "info", stream: { write: (line) => logs.push(line) } } });
registerPublicLegalSearchRoutes(app, {
  verifySignature: async (request, reply) => { if (signed) return true; reply.code(401).send({ ok: false, code: "DEVICE_SIGNATURE_INVALID" }); return false; },
  access: async () => entitled,
  quota: createDeviceQuota({ perMinute: 3, perDay: 5 }),
});
const post = (url, payload) => app.inject({ method: "POST", url, payload });
const question = "员工严重违反规章制度公司能否解除合同";

try {
  {
    const res = await post("/api/legal/search", { deviceId: "device-1", query: question, laws: ["劳动合同法"], topK: 3 });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.deepEqual(gatewayCalls[0], { url: "/search", body: { query: question, laws: ["劳动合同法"], topK: 3, includeHistorical: false } }, "the gateway gets the question, the laws and the bounds");
    assert.equal(body.results[0].validity, "effective");
    assert.equal(body.results[0].internalPath, undefined, "only whitelisted fields leave the host");
    assert.ok(body.results[0].text.length <= 3001 && body.results[0].textTruncated, "search text is bounded and says so");
    assert.deepEqual(body.laws, [{ name: "劳动合同法", source: "caller" }]);
    const audit = logs.find((line) => line.includes("legal search"));
    assert.ok(audit && !audit.includes(question) && !audit.includes("device-1"), "the audit line carries neither the question nor the raw device id");
    const article = await post("/api/legal/article", { deviceId: "device-1", law: "劳动合同法", article: "第39条" });
    assert.equal(article.statusCode, 200);
    assert.equal(article.json().article.text.length, 5000, "an article comes back whole");
    assert.equal(article.json().article.internalPath, undefined);
    assert.equal((await post("/api/legal/article", { deviceId: "device-1", law: "劳动合同法", article: "第九百条" })).statusCode, 404);
    check("an entitled device searches and fetches whole articles; only whitelisted fields leave; the audit holds no question");
  }
  {
    signed = false;
    assert.equal((await post("/api/legal/search", { deviceId: "device-2", query: question })).statusCode, 401, "no signature, no search");
    signed = true;
    entitled = { ok: false, code: "LEGAL_KB_DISABLED" };
    const refused = await post("/api/legal/search", { deviceId: "device-2", query: question });
    assert.deepEqual([refused.statusCode, refused.json().code], [403, "LEGAL_KB_DISABLED"], "an admin disabling the pack closes the search too");
    entitled = { ok: false, code: "LEGAL_KB_NOT_ENTITLED", requiredPlan: "pro" };
    assert.deepEqual((await post("/api/legal/article", { deviceId: "device-2", id: "a#1" })).json(), { ok: false, code: "LEGAL_KB_NOT_ENTITLED", requiredPlan: "pro" });
    entitled = { ok: true };
    assert.equal((await post("/api/legal/search", { deviceId: "device-2", query: "x".repeat(241) })).statusCode, 400, "an oversized query never reaches the gateway");
    check("signature, then entitlement, then input bounds — each refuses on its own");
  }
  {
    // device-1 has used 3 requests this minute: the quota is per device.
    const limited = await post("/api/legal/search", { deviceId: "device-1", query: question });
    assert.deepEqual([limited.statusCode, limited.json().code], [429, "LEGAL_SEARCH_RATE_LIMITED"]);
    assert.ok(Number(limited.headers["retry-after"]) > 0, "and says when to come back");
    assert.equal((await post("/api/legal/search", { deviceId: "device-3", query: question })).statusCode, 200, "another device is unaffected");
    let t = 0;
    const quota = createDeviceQuota({ perMinute: 100, perDay: 2, now: () => t });
    assert.deepEqual([quota("d").ok, quota("d").ok, quota("d").ok], [true, true, false], "a daily ceiling bounds a patient scraper");
    t = 86_400_001;
    assert.equal(quota("d").ok, true, "and resets after a day");
    check("a per-device quota bounds each device, per minute and per day");
  }
  {
    gateway.close();
    await new Promise((resolve) => setTimeout(resolve, 50));
    const down = await post("/api/legal/search", { deviceId: "device-4", query: question });
    assert.deepEqual([down.statusCode, down.json().code], [503, "LEGAL_SEARCH_UNAVAILABLE"], "a gateway outage is an explicit 503");
    check("the gateway being down is an explicit, retryable 503");
  }
} finally {
  await app.close();
  gateway.close();
}
console.log(`legal-search-route: ok (${checks} checks)`);
