import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { Writable } from "node:stream";
const require = createRequire(new URL("../server/package.json", import.meta.url));
const Fastify = require("fastify");
const api = await import("../server/src/routes/public/collaboration-objects.js").catch((error) => { if (error.code !== "ERR_MODULE_NOT_FOUND") throw error; return {}; });
assert.equal(typeof api.registerCollaborationObjectRoutes, "function", "object HTTP boundary must be registered");
const chunks = [];
const app = Fastify({ logger: { level: "trace", stream: new Writable({ write(chunk, _encoding, callback) { chunks.push(chunk.toString()); callback(); } }) } });
// Mirror production's root error handler, which would otherwise log unsafe errors.
app.setErrorHandler((error, _request, reply) => { app.log.error(error); reply.code(500).send({ ok: false }); });
const credentials = { token: "UPLOAD_SECRET_SENTINEL", uploadUrl: "https://upload.invalid", objectKey: "collaboration/object", expiresAt: "2026-09-01T00:00:00Z" };
const dek = Buffer.alloc(32, 91), secret = dek.toString("base64");
let suppliedDek, returnedDek, called = 0;
const objectService = {
  async init(input) { called++; suppliedDek = input.dek; assert.deepEqual(input.dek, dek); return { objectId: "obj", state: "uploading", upload: credentials }; },
  async complete() { return { objectId: "obj", state: "verified" }; },
  async abort(input) {
    if (input.clientCommandId === "contention") throw Object.assign(new Error("database lock timeout"), { code: "COLLAB_TRANSACTION_RETRY", retryable: true });
    if (input.clientCommandId.startsWith("pg-")) throw Object.assign(new Error("PG_ERROR_SECRET https://private.invalid/?token=secret"), { code: input.clientCommandId.slice(3) });
    return { objectId: "obj", state: "aborted" };
  },
  async revoke() { throw Object.assign(new Error("https://private.invalid/?token=ERROR_SECRET"), { code: "https://private.invalid/?token=ERROR_SECRET" }); },
  async downloadTicket() { returnedDek = Buffer.from(dek); return { objectId: "obj", dek: returnedDek, url: "https://private.invalid/?token=DOWNLOAD_SECRET", expiresAt: "2026-09-01T00:00:00Z", ciphertextSize: 99, ciphertextSha256: "a".repeat(64) }; },
};
api.registerCollaborationObjectRoutes({
  post: (path, _schema, handler, options) => app.post(path, options, handler),
  accountFor: async () => ({ userId: "a", deviceId: "device", requestId: "req" }), database: {}, objectService,
});
const init = { deviceId: "device", clientCommandId: "init", conversationId: "c", purpose: "attachment", ciphertextSize: 99, ciphertextSha256: "a".repeat(64), originalName: "a.txt", mimeType: "text/plain", dek: secret };
const inject = (path, body, extra = {}) => app.inject({ method: "POST", url: `/api/collaboration/v1/objects/${path}`, payload: body, headers: { authorization: "Bearer AUTH_SECRET" }, ...extra });
try {
  let response = await inject("init?token=QUERY_SECRET", init);
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.json().result.upload.token, credentials.token);
  assert.equal(response.headers["cache-control"], "no-store");
  assert.deepEqual(suppliedDek, Buffer.alloc(32), "request DEK bytes are cleared after wrapping");
  for (const change of [{ ownerUserId: "b" }, { scopeType: "organization" }, { ciphertextSize: 1024 ** 3 + 1 }, { purpose: "workspace", ciphertextSize: 256 * 1024 ** 2 + 1 }, { dek: `${secret}extra` }, { originalName: "../secret" }, { ciphertextSha256: "bad" }]) {
    response = await inject("init", { ...init, ...change });
    assert.equal(response.statusCode, 400, response.body);
  }
  assert.equal(called, 1, "strict inputs fail before service side effects");
  const command = { deviceId: "device", clientCommandId: "command" };
  assert.equal((await inject("obj/complete", { ...command, etag: "etag", ciphertextSize: 99, ciphertextSha256: "a".repeat(64) })).statusCode, 200);
  assert.equal((await inject("obj/abort", command)).json().result.state, "aborted");
  response = await inject("obj/abort", { ...command, clientCommandId: "contention" });
  assert.equal(response.statusCode, 503);
  assert.equal(response.json().code, "COLLAB_TRANSACTION_RETRY");
  assert.equal(response.json().retryable, true, "safe database contention codes retain retry semantics without exposing provider errors");
  for (const code of ["40P01", "40001", "55P03", "57014"]) {
    response = await inject("obj/abort", { ...command, clientCommandId: `pg-${code}` });
    assert.equal(response.statusCode, 503, `${code} remains retryable after leaving the command/preflight transaction`);
    assert.equal(response.json().code, "COLLAB_TRANSACTION_RETRY");
    assert.equal(response.json().retryable, true, "native pg errors have no retryable property; the exact SQLSTATE is authoritative");
    assert.equal(response.body.includes("PG_ERROR_SECRET"), false);
  }
  response = await inject("obj/abort", { ...command, clientCommandId: "pg-23505" });
  assert.equal(response.statusCode, 400, "non-transient SQL errors must not accidentally enter a retry loop");
  assert.equal(response.json().code, "COLLAB_OBJECT_REQUEST_FAILED");
  assert.equal(response.json().retryable, false);
  response = await inject("obj/download-ticket", command);
  assert.equal(response.json().result.dek, secret);
  assert.deepEqual(returnedDek, Buffer.alloc(32), "download DEK bytes are cleared after encoding to TLS response");
  assert.equal(response.headers["cache-control"], "no-store");
  response = await inject("obj/revoke", command);
  assert.equal(response.json().code, "COLLAB_OBJECT_REQUEST_FAILED");
  assert.equal(response.body.includes("ERROR_SECRET"), false);
  response = await inject("init", `{"dek":"${secret}", BAD_JSON_SECRET`, { headers: { "content-type": "application/json" } });
  assert.equal(response.statusCode, 400);
  response = await inject("init", { ...init, unknown: "OVERSIZE_SECRET".repeat(4000) });
  assert.equal(response.statusCode, 413);
  assert.equal(response.headers["cache-control"], "no-store");
  await app.close();
  app.log.info("normal-request-logging-still-enabled");
  assert.ok(chunks.join("").includes("normal-request-logging-still-enabled"), "logger was truly enabled, not a false-negative logger:false test");
  for (const value of [secret, "AUTH_SECRET", "UPLOAD_SECRET_SENTINEL", "QUERY_SECRET", "DOWNLOAD_SECRET", "ERROR_SECRET", "BAD_JSON_SECRET", "OVERSIZE_SECRET", "PG_ERROR_SECRET"]) assert.equal(chunks.join("").includes(value), false, `sensitive marker leaked: ${value}`);
  console.log("collaboration object HTTP: strict inputs, size limits, no-store, zeroed keys and real logger secrecy passed");
} finally { await app.close(); }
