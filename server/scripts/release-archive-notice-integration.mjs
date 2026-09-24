#!/usr/bin/env node
// Closed loop for phase 4: real Postgres, real migrations, real routes, a
// stand-in for object storage and for the model provider.
//
//   archive: preview lists only what nobody is offered, older than retention,
//     not the minimum, with exactly its objects (0.1.18 never takes 0.1.183's);
//     confirming moves them under archive/ and disables the release; an id that
//     stopped qualifying is skipped; restore moves them back.
//   legacy notice: off → an old client's chat reaches the provider as today;
//     on (trial scope) → it gets a normal assistant reply saying how to update,
//     in the protocol and streaming mode it asked for, without calling the
//     provider; a supported client and a device outside the trial are untouched;
//     with no installable release at the floor there is no notice.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import Fastify from "fastify";
import cookie from "@fastify/cookie";
import pg from "pg";

if (!process.env.DATABASE_URL) { console.log("release archive + notice integration: skipped (DATABASE_URL not configured)"); process.exit(0); }

const here = path.dirname(fileURLToPath(import.meta.url));
const schema = `release_p4_${crypto.randomUUID().replaceAll("-", "")}`;
const control = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const scoped = new URL(process.env.DATABASE_URL);
scoped.searchParams.set("options", `-c search_path=${schema}`);
const cwd = process.cwd();
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "release-p4-"));
process.chdir(temp);
const ADMIN_TOKEN = crypto.randomBytes(32).toString("hex");

// Object storage stand-in: a key set; move and list behave like Qiniu's.
const objects = new Set();
const moves = [];
const decode = (value) => Buffer.from(value.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8").split(":").slice(1).join(":");
const storage = Fastify({ logger: false, maxParamLength: 2000 }); // real Qiniu entries are long base64
storage.addContentTypeParser("application/x-www-form-urlencoded", (_request, _payload, done) => done(null, {}));
storage.post("/move/:from/:to/force/false", async (request, reply) => {
  const from = decode(request.params.from), to = decode(request.params.to);
  if (!objects.has(from)) return reply.code(612).send({ error: "no such file" });
  if (objects.has(to)) return reply.code(614).send({ error: "file exists" });
  objects.delete(from); objects.add(to); moves.push([from, to]);
  return {};
});
storage.post("/list", async (request) => ({ items: [...objects].filter((k) => k.startsWith(String(request.query.prefix || ""))).map((key) => ({ key })) }));
const storageUrl = await storage.listen({ host: "127.0.0.1", port: 0 });
// The CDN (HEAD on release creation) and the model provider.
const cdn = Fastify({ logger: false });
cdn.head("/*", async (_request, reply) => reply.code(200).send());
let upstreamCalls = 0;
cdn.post("/v1/chat/completions", async () => { upstreamCalls += 1; return { id: "u", object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content: "real answer" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }; });
const cdnUrl = await cdn.listen({ host: "127.0.0.1", port: 0 });

Object.assign(process.env, {
  DATABASE_URL: scoped.href,
  SESSION_SECRET: crypto.randomBytes(32).toString("hex"),
  ADMIN_TOKEN,
  ADMIN_EMAIL: "test-admin@example.invalid",
  ADMIN_PASSWORD: crypto.randomBytes(16).toString("hex"),
  QINIU_PUBLIC_BASE_URL: cdnUrl,
  QINIU_RS_HOST: storageUrl,
  QINIU_RSF_HOST: storageUrl,
  MODEL_GATEWAY_ENABLED: "true",
  // Account billing is exercised elsewhere; here an unlicensed device's chat must reach the provider.
  ACCOUNT_USAGE_ENFORCEMENT: "false",
  MODEL_GATEWAY_PROVIDERS: JSON.stringify({ "p4-test": { type: "openai", baseUrl: `${cdnUrl}/v1`, apiKey: "fixture-only", model: "test-model" } }),
  NODE_ENV: "test",
});

const step = (label) => console.log(`  · ${label}`);
let app, pool, closeDb;
try {
  await control.query(`create schema ${schema}`);
  step("apply the real migrations");
  const migrate = spawnSync(process.execPath, [path.join(here, "migrate.mjs")], { env: { ...process.env }, encoding: "utf8", cwd: path.resolve(here, "..") });
  assert.equal(migrate.status, 0, `migrate failed:\n${migrate.stdout}\n${migrate.stderr}`);
  assert.match(migrate.stdout, /059_release_archive\.sql/);

  const [dbMod, { adminRoutes }, { publicRoutes }, { installDocOnlyCompilers }, appSettings, gateway, auth] = await Promise.all([
    import("../src/db.js"), import("../src/routes/admin.js"), import("../src/routes/public.js"), import("../src/openapi.js"),
    import("../src/services/app-settings.js"), import("../src/services/model-gateway.js"), import("../src/services/model-gateway/auth.js"),
  ]);
  ({ pool, closeDb } = dbMod);
  app = Fastify({ logger: false });
  installDocOnlyCompilers(app);
  await app.register(cookie);
  await app.register(adminRoutes);
  await app.register(publicRoutes);
  await app.register(gateway.modelGatewayRoutes);
  const call = async (method, url, payload, headers = {}) => {
    const res = await app.inject({ method, url, ...(payload === undefined ? {} : { payload }), headers });
    let body = null; try { body = res.json(); } catch { body = res.body; }
    return { status: res.statusCode, body, raw: res.body };
  };
  const asAdmin = { authorization: `Bearer ${ADMIN_TOKEN}` };
  const platform = "darwin-arm64";
  const installerKey = (v) => `app/updates/${platform}/${v}/Lily Workbench-${v}-arm64.dmg`;
  const release = (version, extra = {}) => ({ version, platform, url: `${cdnUrl}/${encodeURI(installerKey(version))}`, sha256: "a".repeat(64), sizeBytes: 1, ...extra });
  await appSettings.setQiniuConfig({ publicBaseUrl: cdnUrl, accessKey: "ak-test", secretKey: "sk-test", bucket: "b" });

  step("seed: three old versions, the full version, a minimum, a rolling one");
  for (const v of ["0.1.18", "0.1.100", "0.1.183", "0.1.184", "0.1.185", "0.1.186"]) {
    objects.add(installerKey(v));
    objects.add(`app/auto-updates/${platform}/stable/Lily Workbench-${v}-arm64.zip`);
  }
  objects.add(`app/auto-updates/${platform}/stable/latest-mac.yml`);
  objects.add(`app/auto-updates/${platform}/releases/0.1.18/latest-mac.yml`);
  for (const v of ["0.1.18", "0.1.100", "0.1.183", "0.1.184", "0.1.185"]) assert.equal((await call("POST", "/api/admin/releases", release(v), asAdmin)).status, 201);
  assert.equal((await call("POST", "/api/admin/releases", release("0.1.186", { immutableFeed: true, rolloutPercent: 10 }), asAdmin)).status, 201);
  await pool.query("update releases set created_at = now() - interval '90 days' where version in ('0.1.18', '0.1.100', '0.1.183', '0.1.184')");
  await call("PATCH", `/api/admin/release-support/stable/${platform}`, { minSupportedVersion: "0.1.184" }, asAdmin);

  step("preview: only what nobody needs, with exactly its objects");
  const preview = await call("GET", "/api/admin/release-archive/preview", undefined, asAdmin);
  assert.equal(preview.status, 200, JSON.stringify(preview.body));
  assert.equal(preview.body.configured, true);
  const byVersion = Object.fromEntries(preview.body.candidates.map((c) => [c.version, c]));
  assert.deepEqual(Object.keys(byVersion).sort(), ["0.1.100", "0.1.18", "0.1.183"], "not the full (0.1.185), not the minimum (0.1.184), not the rolling (0.1.186)");
  assert.deepEqual(byVersion["0.1.18"].objects.sort(), [
    `app/auto-updates/${platform}/releases/0.1.18/latest-mac.yml`,
    `app/auto-updates/${platform}/stable/Lily Workbench-0.1.18-arm64.zip`,
    installerKey("0.1.18"),
  ].sort(), "0.1.18 never takes 0.1.183's files, and the shared pointer is never archived");
  assert.equal(moves.length, 0, "previewing moves nothing");

  step("archive: confirmed ids only, recomputed on the server");
  await pool.query("update releases set created_at = now() where version = '0.1.100'"); // stopped qualifying since the preview
  const done = await call("POST", "/api/admin/release-archive", { releaseIds: preview.body.candidates.map((c) => c.id) }, asAdmin);
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.equal(done.body.skipped.length, 1, "an id that no longer qualifies is skipped, not archived");
  assert.ok(objects.has(`archive/${installerKey("0.1.18")}`) && !objects.has(installerKey("0.1.18")), "the old direct link stops working");
  assert.ok(objects.has(installerKey("0.1.184")) && objects.has(`app/auto-updates/${platform}/stable/latest-mac.yml`), "the minimum and the shared pointer stay");
  const archived = (await pool.query("select version, enabled, archived_at is not null as archived from releases where version in ('0.1.18','0.1.183','0.1.100') order by version")).rows;
  assert.deepEqual(archived.map((r) => [r.version, r.enabled, r.archived]), [["0.1.100", true, false], ["0.1.18", false, true], ["0.1.183", false, true]]);
  assert.equal((await call("GET", `/api/releases/latest?platform=${platform}&version=0.1.100`)).body.version, "0.1.185", "what is offered is unchanged");

  step("restore moves the files back and re-enables it");
  const id018 = (await pool.query("select id from releases where version='0.1.18'")).rows[0].id;
  const archivedRow = (await pool.query("select archived_objects from releases where id=$1", [id018])).rows[0];
  const restoreRes = await call("POST", `/api/admin/release-archive/${id018}/restore`, {}, asAdmin);
  assert.equal(restoreRes.body.restored, 3, JSON.stringify({ archived: archivedRow.archived_objects, restoreRes: restoreRes.body, done: done.body, objects: [...objects].filter((k) => k.includes("0.1.18")) }));
  assert.ok(objects.has(installerKey("0.1.18")));
  assert.equal((await pool.query("select enabled, archived_at from releases where id=$1", [id018])).rows[0].enabled, true);

  step("legacy notice: off → an old client's chat reaches the provider as today");
  await pool.query("insert into devices (id, platform, arch, app_version) values ('dev_old', 'darwin', 'arm64', '0.1.100'), ('dev_old_2', 'darwin', 'arm64', '0.1.100'), ('dev_new', 'darwin', 'arm64', '0.1.185')");
  const tokenFor = (deviceId) => auth.signModelGatewayToken({ deviceId, providerId: "p4-test" });
  const chat = (deviceId, extra = {}) => call("POST", "/llm/p4-test/v1/chat/completions", { model: "test-model", messages: [{ role: "user", content: "hi" }], ...extra }, { authorization: `Bearer ${tokenFor(deviceId)}` });
  const before = upstreamCalls;
  const offRes = await chat("dev_old");
  assert.equal(offRes.status, 200, JSON.stringify(offRes.body));
  assert.equal(upstreamCalls, before + 1);

  step("on, trial scope: the old client is told how to update, the provider is not called");
  assert.equal((await call("PATCH", "/api/admin/release-settings/legacy-notice", { enabled: true, deviceIds: ["dev_old"] }, asAdmin)).status, 200);
  const calls = upstreamCalls;
  const notice = await chat("dev_old");
  assert.equal(notice.status, 200);
  assert.match(notice.body.choices[0].message.content, /0\.1\.100 已停止支持，请更新到 0\.1\.185/);
  assert.match(notice.body.choices[0].message.content, new RegExp(installerKey("0.1.185").split("/").pop().replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/ /g, "(?: |%20)")));
  const streamed = await chat("dev_old", { stream: true });
  assert.match(streamed.raw, /data: \{.*"content":"当前 Lily 版本/);
  assert.match(streamed.raw, /data: \[DONE\]/, "a streaming request gets a complete stream");
  const anthropic = await call("POST", "/llm/p4-test/v1/messages", { model: "test-model", max_tokens: 16, stream: true, messages: [{ role: "user", content: "hi" }] }, { authorization: `Bearer ${tokenFor("dev_old")}` });
  assert.match(anthropic.raw, /event: message_start[\s\S]*event: content_block_delta[\s\S]*已停止支持[\s\S]*event: message_stop/, "and an Anthropic-protocol client gets Anthropic events");
  assert.equal(upstreamCalls, calls, "no provider call for any notice");
  assert.equal((await chat("dev_old_2")).body.choices[0].message.content, "real answer", "outside the trial scope: untouched");
  assert.equal((await chat("dev_new")).body.choices[0].message.content, "real answer", "a supported client: untouched");
  const summary = await call("GET", "/api/admin/rollouts", undefined, asAdmin);
  assert.equal(summary.body.legacyNotice.hits.devices, 1);

  step("no installable release at the floor → no notice");
  await call("PATCH", `/api/admin/release-support/stable/${platform}`, { minSupportedVersion: "0.1.300" }, asAdmin);
  assert.equal((await chat("dev_old")).body.choices[0].message.content, "real answer");

  console.log("release archive + notice integration: ok");
} finally {
  for (const server of [storage, cdn]) { try { await server.close(); } catch { /* ignore */ } }
  try { await app?.close(); } catch { /* ignore */ }
  try { await closeDb?.(); } catch { try { await pool?.end(); } catch { /* ignore */ } }
  try { await control.query(`drop schema if exists ${schema} cascade`); } catch { /* ignore */ }
  await control.end();
  process.chdir(cwd);
  fs.rmSync(temp, { recursive: true, force: true });
}
