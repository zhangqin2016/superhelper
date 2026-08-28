import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { test } from "node:test";

const requireServer = createRequire(new URL("../server/package.json", import.meta.url));
const today = new Date().toISOString().slice(0, 10);
const migration = new URL("../server/migrations/031_usage_provider_identity.sql", import.meta.url);

function loadClient(name, mocks) {
  const file = new URL(`../src/main/${name}.js`, import.meta.url);
  const require = createRequire(file);
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(file, "utf8"), {
    module, exports: module.exports,
    require: id => Object.hasOwn(mocks, id) ? mocks[id] : require(id),
    process, Buffer, console, setTimeout, clearTimeout, AbortController,
  }, { filename: file.pathname });
  return module.exports;
}

function clientFixture(t, transport = async () => new Response('{"ok":true}')) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lily-usage-provider-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const config = {
    userDataPath: name => path.join(root, name),
    appVersion: () => "0.0.0-test",
    appEdition: () => ({ serviceApiBaseUrl: "https://usage.test", features: {} }),
  };
  const reloadStore = () => loadClient("usage-local-store", { "./config": config });
  const store = reloadStore();
  const uploads = [];
  const client = loadClient("service-client", {
    "./config": config,
    electron: {},
    "node:child_process": { execSync: () => "" },
    "./legal-kb/legal-kb-client": {},
    "./proxy-aware-fetch": async (url, init) => {
      uploads.push(JSON.parse(init.body));
      return transport(url, init);
    },
  });
  const reporter = loadClient("usage-reporter", {
    "./local-date-key": { localDateKey: () => today },
    "./model-presets": { getActivePresetEnv: () => ({ LILY_MODEL: "global" }), getUserApiEnv: () => ({}) },
    "./agent-env": { normalizeToLilyEnv: x => x, pickModelId: x => x.LILY_MODEL },
    "./license-manager": { getLicenseStatus: () => ({}) },
    "./usage-local-store": store,
    "./service-client": client,
  });
  return { store, reloadStore, reporter, client, uploads };
}

function record(reporter, providerID, sessionId = "session") {
  reporter.recordUserSend(sessionId, [{ isImage: true }], { providerID, modelID: "shared-name" });
  reporter.recordToolCall(sessionId, { name: "skill" });
  reporter.recordModelUsage(sessionId, { inputTokens: 120, outputTokens: 30 });
}

test("provider/model identity survives real local persistence and signed upload", async t => {
  const { reporter, store, reloadStore, uploads } = clientFixture(t);
  record(reporter, "vendorA");
  record(reporter, "vendorB");
  assert.equal((await reporter.flush("session")).ok, true);
  assert.deepEqual(uploads.map(r => [r.providerID, r.model]), [
    ["vendorA", "shared-name"], ["vendorB", "shared-name"],
  ]);
  assert.equal(new Set(uploads.map(r => r.reportId)).size, 2);
  assert.ok(uploads.every(r => typeof r.reportId === "string" && r.reportId.length > 0));
  const persisted = JSON.parse(fs.readFileSync(store.storePath(), "utf8"));
  assert.deepEqual(persisted.days[today].models.map(r => [r.providerID, r.model, r.inputTokens]), [
    ["vendorA", "shared-name", 120], ["vendorB", "shared-name", 120],
  ]);
  const summary = reloadStore().getUsageSummary();
  assert.equal(summary.rangeTotals.inputTokens, 240);
  assert.equal(summary.pricingId, "deepseek_standard");
  assert.equal(summary.byModel.length, 2);
});

test("legacy daily totals migrate to unknown identity without changing prices or totals", t => {
  const { store, reloadStore } = clientFixture(t);
  fs.writeFileSync(store.storePath(), JSON.stringify({ schemaVersion: 1, days: {
    [today]: { inputTokens: 50, outputTokens: 10, messageCount: 2, turnCount: 1 },
  } }));
  const migrated = reloadStore();
  const before = migrated.getUsageSummary();
  assert.deepEqual(structuredClone(before.byModel), [{
    date: today, providerID: "unknown", model: "unknown",
    inputTokens: 50, outputTokens: 10, messageCount: 2, turnCount: 1,
  }]);
  migrated.mergeSessionRecord({ date: today, model: "shared-name", inputTokens: 20 });
  migrated.mergeSessionRecord({ date: today, providerID: "vendorA", model: "shared-name", inputTokens: 30 });
  const summary = reloadStore().getUsageSummary();
  assert.equal(summary.rangeTotals.inputTokens, 100);
  assert.deepEqual(structuredClone(summary.byModel.map(r => [r.providerID, r.model])), [
    ["unknown", "unknown"], ["unknown", "shared-name"], ["vendorA", "shared-name"],
  ]);
  assert.equal(summary.pricingId, before.pricingId);
});

test("retry retains its report ID and local persistence deduplicates even after reload", async t => {
  let fail = true;
  const { reporter, uploads, reloadStore } = clientFixture(t, async () => {
    if (fail) throw new Error("acknowledgement lost");
    return new Response('{"ok":true}');
  });
  record(reporter, "vendorA");
  assert.equal((await reporter.flush("session")).ok, false);
  record(reporter, "vendorB");
  fail = false;
  assert.equal((await reporter.flush("session")).ok, true);
  assert.ok(uploads[0].reportId);
  assert.equal(uploads[0].reportId, uploads[1].reportId);
  assert.notEqual(uploads[0].reportId, uploads[2].reportId);
  const reopened = reloadStore();
  reopened.mergeSessionRecord(uploads[0]);
  assert.equal(reloadStore().getUsageSummary().rangeTotals.inputTokens, 240);
});

test("model-keyed and token-only callers preserve explicit provider or use unknown", async t => {
  const { reporter, uploads } = clientFixture(t);
  reporter.recordModelUsage("idle", { "shared-name": { input_tokens: 120 } }, {
    providerID: "vendorA", modelID: "shared-name",
  });
  reporter.recordModelUsage("idle", { inputTokens: 120 }, { providerID: "vendorB", modelID: "shared-name" });
  reporter.recordModelUsage("idle", { inputTokens: 10 }, "shared-name");
  assert.equal((await reporter.flush("idle")).ok, true);
  assert.deepEqual(uploads.map(r => [r.providerID, r.inputTokens]), [
    ["vendorA", 120], ["vendorB", 120], ["unknown", 10],
  ]);
});

test("PostgreSQL usage migration, routes, queries and retry transactions", {
  skip: !process.env.USAGE_TEST_DATABASE_URL && "set USAGE_TEST_DATABASE_URL to run isolated PostgreSQL integration",
}, async t => {
  const { Pool } = requireServer("pg");
  const schema = `usage_test_${randomUUID().replaceAll("-", "")}`;
  const admin = new Pool({ connectionString: process.env.USAGE_TEST_DATABASE_URL });
  await admin.query(`create schema ${schema}`);
  const url = new URL(process.env.USAGE_TEST_DATABASE_URL);
  url.searchParams.set("options", `-c search_path=${schema}`);
  process.env.DATABASE_URL = url.href;
  const { pool, closeDb } = await import("../server/src/db.js");
  t.after(async () => {
    await closeDb();
    await admin.query(`drop schema ${schema} cascade`);
    await admin.end();
  });
  for (const name of ["001_initial.sql", "004_device_trial_settings.sql", "007_client_config_profiles.sql"]) {
    await pool.query(fs.readFileSync(new URL(`../server/migrations/${name}`, import.meta.url), "utf8"));
  }
  await pool.query("insert into devices (id) values ('legacy-device')");
  await pool.query("insert into usage_daily (device_id, usage_date, model, input_tokens) values ('legacy-device', $1, 'shared-name', 50)", [today]);
  const legacyColumns = await pool.query("select column_name from information_schema.columns where table_schema = $1 and table_name = 'usage_daily' order by ordinal_position", [schema]);
  await pool.query(fs.readFileSync(migration, "utf8"));

  const oldServerReport = (deviceId, tokens) => pool.query(`
    insert into usage_daily (usage_date, device_id, model, input_tokens)
    values ($1, $2, 'shared-name', $3)
    on conflict (usage_date, device_id, model) do update set
      input_tokens = usage_daily.input_tokens + excluded.input_tokens,
      updated_at = now()
  `, [today, deviceId, tokens]);

  const Fastify = requireServer("fastify");
  const app = Fastify({ logger: false });
  const { installDocOnlyCompilers } = await import("../server/src/openapi.js");
  const { registerPublicTelemetryRoutes } = await import("../server/src/routes/public/telemetry.js");
  const { registerAdminUsageRoutes } = await import("../server/src/routes/admin/usage.js");
  const { registerAdminSummaryRoutes } = await import("../server/src/routes/admin/summary.js");
  const { upsertDevice, upsertDevicePublicKey } = await import("../server/src/services/device-identity.js");
  installDocOnlyCompilers(app);
  app.setErrorHandler((error, _request, reply) => reply.code(error.name === "ZodError" ? 400 : 500).send({ ok: false }));
  registerPublicTelemetryRoutes(app);
  registerAdminUsageRoutes(app);
  registerAdminSummaryRoutes(app);
  await app.ready();
  t.after(() => app.close());
  let loseAck = false;
  const transport = async (target, init) => {
    const response = await app.inject({ method: init.method, url: new URL(target).pathname, headers: init.headers, payload: init.body });
    if (loseAck && response.statusCode === 200) { loseAck = false; throw new Error("committed response lost"); }
    return new Response(response.body, { status: response.statusCode });
  };
  const makeClient = async context => {
    const fixture = clientFixture(context, transport);
    await upsertDevice(fixture.client.devicePayload());
    await upsertDevicePublicKey(fixture.client.devicePayload());
    return fixture;
  };

  await t.test("migration preserves historical usage as unknown provider", async () => {
    const { rows } = await pool.query("select * from usage_daily where device_id = 'legacy-device'");
    assert.equal(rows[0].input_tokens, 50);
    const breakdown = await pool.query("select * from usage_provider_breakdown where device_id = 'legacy-device'");
    assert.equal(Number(breakdown.rows[0].input_tokens), 50);
    assert.equal(breakdown.rows[0].provider_id, "unknown");
  });

  await t.test("migration leaves legacy columns and old binary conflict target intact", async () => {
    await oldServerReport("legacy-device", 11);
    await oldServerReport("legacy-device", 13);
    const after = await pool.query("select column_name from information_schema.columns where table_schema = $1 and table_name = 'usage_daily' order by ordinal_position", [schema]);
    assert.deepEqual(after.rows, legacyColumns.rows);
    const { rows } = await pool.query("select * from usage_daily where device_id = 'legacy-device'");
    assert.equal(rows.length, 1);
    assert.equal(rows[0].input_tokens, 74);
    const breakdown = await pool.query("select * from usage_provider_breakdown where device_id = 'legacy-device'");
    assert.equal(Number(breakdown.rows[0].input_tokens), 74, "old servers continue contributing to unknown attribution after migration");
  });

  await t.test("same-name providers remain distinct after upload and a lost acknowledgement", async context => {
    const { reporter, client, uploads, reloadStore } = await makeClient(context);
    record(reporter, "vendorA");
    record(reporter, "vendorB");
    loseAck = true;
    assert.equal((await reporter.flush("session")).ok, false);
    assert.equal((await reporter.flush("session")).ok, true);
    const { rows } = await pool.query("select * from usage_provider_daily where device_id = $1 order by provider_id", [client.getDeviceId()]);
    assert.deepEqual(rows.map(r => [r.provider_id, r.model, r.input_tokens, r.message_count]), [
      ["vendorA", "shared-name", 120, 1], ["vendorB", "shared-name", 120, 1],
    ]);
    assert.ok(rows.every(r => r.image_count === 1 && r.tool_call_count === 1 && r.plugin_call_count === 1 && r.output_tokens === 30));
    assert.equal(reloadStore().getUsageSummary().rangeTotals.inputTokens, 240);
    assert.equal(uploads[0].reportId, uploads[2].reportId);
    const aggregate = await pool.query("select * from usage_daily where device_id = $1", [client.getDeviceId()]);
    assert.equal(aggregate.rows.length, 1);
    for (const key of ["input_tokens", "output_tokens", "message_count", "image_count", "tool_call_count", "plugin_call_count"]) {
      assert.equal(aggregate.rows[0][key], rows.reduce((total, row) => total + row[key], 0), `${key} aggregate must count each detail delta once`);
    }
    const summary = await client.fetchUsageSummary();
    assert.equal(summary.json.days[0].inputTokens, 240);
    assert.deepEqual(summary.json.byModel.map(r => r.providerID).sort(), ["vendorA", "vendorB"]);
    const adminUsage = await app.inject(`/api/admin/usage?deviceId=${client.getDeviceId()}&providerID=vendorB`);
    assert.equal(adminUsage.json().usage.length, 1);
    assert.equal(adminUsage.json().usage[0].provider_id, "vendorB");
    const legacyAdmin = await app.inject(`/api/admin/usage?deviceId=${client.getDeviceId()}`);
    assert.equal(legacyAdmin.json().usage.length, 1);
    assert.equal(legacyAdmin.json().usage[0].input_tokens, 240);
    assert.equal(Object.hasOwn(legacyAdmin.json().usage[0], "provider_id"), false);
    const dashboard = await app.inject("/api/admin/summary");
    assert.deepEqual(dashboard.json().models, [{ model: "shared-name", messages: 2 }], "legacy chart aggregates and model keys must remain compatible");
    assert.deepEqual(dashboard.json().byModel.filter(r => r.model === "shared-name").map(r => r.providerID).sort(), ["unknown", "vendorA", "vendorB"]);
  });

  await t.test("legacy uploads remain additive in unknown bucket; malformed identity is rejected", async context => {
    const { client } = await makeClient(context);
    const payload = { date: today, model: "shared-name", inputTokens: 10 };
    for (const providerID of [undefined, null, ""]) {
      assert.equal((await client.reportUsage({ ...payload, providerID })).ok, true);
    }
    const { rows } = await pool.query("select * from usage_provider_daily where device_id = $1", [client.getDeviceId()]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].provider_id, "unknown");
    assert.equal(rows[0].input_tokens, 30);
    const summary = await client.fetchUsageSummary();
    assert.deepEqual(summary.json.byModel.map(r => [r.providerID, r.inputTokens]), [["unknown", 30]], "unknown detail must not be added again to the residual");
    for (const providerID of [{ id: "vendorA" }, "x".repeat(201)]) {
      assert.equal((await client.reportUsage({ ...payload, providerID })).status, 400);
    }
    assert.equal((await client.reportUsage({ ...payload, reportId: "" })).status, 400);
  });

  await t.test("concurrent retries and fresh equal deltas count exactly once per device/report", async context => {
    const { client } = await makeClient(context);
    const payload = { reportId: randomUUID(), date: today, providerID: "vendorA", model: "shared-name", inputTokens: 7 };
    const results = await Promise.all(Array.from({ length: 8 }, () => client.reportUsage(payload)));
    assert.ok(results.every(r => r.ok));
    assert.equal((await client.reportUsage({ ...payload, reportId: randomUUID() })).ok, true);
    const { rows } = await pool.query("select * from usage_daily where device_id = $1", [client.getDeviceId()]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].input_tokens, 14);
    const details = await pool.query("select * from usage_provider_daily where device_id = $1", [client.getDeviceId()]);
    assert.equal(details.rows.length, 1);
    assert.equal(details.rows[0].input_tokens, 14);
    const other = await makeClient(context);
    assert.equal((await other.client.reportUsage(payload)).ok, true);
    const otherRows = await pool.query("select * from usage_daily where device_id = $1", [other.client.getDeviceId()]);
    assert.equal(otherRows.rows[0].input_tokens, 7);
  });

  await t.test("provider metadata remains covered by device signatures", async context => {
    let tampered;
    const { client } = clientFixture(context, async (target, init) => {
      const payload = JSON.parse(init.body);
      payload.providerID = "forged-provider";
      tampered = await app.inject({ method: init.method, url: new URL(target).pathname, headers: init.headers, payload });
      return new Response(tampered.body, { status: tampered.statusCode });
    });
    await upsertDevice(client.devicePayload());
    await upsertDevicePublicKey(client.devicePayload());
    assert.equal((await client.reportUsage({ date: today, model: "shared-name", providerID: "vendorA", reportId: randomUUID(), inputTokens: 7 })).status, 401);
    assert.equal(tampered.json().code, "DEVICE_SIGNATURE_BODY_MISMATCH");
    const { rows } = await pool.query("select * from usage_report_receipts where device_id = $1", [client.getDeviceId()]);
    assert.equal(rows.length, 0);
  });

  await t.test("old and new servers coexist without duplicating aggregate or unknown usage", async context => {
    const { client } = await makeClient(context);
    const payload = { reportId: randomUUID(), date: today, providerID: "vendorA", model: "shared-name", inputTokens: 7 };
    await oldServerReport(client.getDeviceId(), 5);
    await Promise.all([
      oldServerReport(client.getDeviceId(), 11),
      client.reportUsage(payload).then(result => assert.equal(result.ok, true)),
      client.reportUsage({ ...payload, reportId: randomUUID(), providerID: "vendorB" }).then(result => assert.equal(result.ok, true)),
    ]);
    assert.equal((await client.reportUsage(payload)).ok, true);
    const summary = await client.fetchUsageSummary();
    assert.equal(summary.json.days[0].inputTokens, 30);
    assert.deepEqual(summary.json.byModel.map(r => [r.providerID, r.inputTokens]), [["unknown", 16], ["vendorA", 7], ["vendorB", 7]]);
  });

  for (const table of ["usage_daily", "usage_provider_daily"]) await t.test(`failed ${table} write rolls back both counters and receipt`, async context => {
    const { client } = await makeClient(context);
    const payload = { reportId: randomUUID(), date: today, providerID: "rollback", model: `rollback-${table}`, inputTokens: 7 };
    await pool.query(`alter table ${table} add constraint usage_test_failure check (model <> 'rollback-${table}')`);
    try {
      assert.equal((await client.reportUsage(payload)).ok, false);
      for (const target of ["usage_daily", "usage_provider_daily", "usage_report_receipts"]) {
        const result = await pool.query(`select * from ${target} where device_id = $1`, [client.getDeviceId()]);
        assert.equal(result.rows.length, 0, `${target} must roll back with the failed write`);
      }
    } finally { await pool.query(`alter table ${table} drop constraint usage_test_failure`); }
    assert.equal((await client.reportUsage(payload)).ok, true);
    const { rows } = await pool.query("select * from usage_daily where device_id = $1", [client.getDeviceId()]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].input_tokens, 7);
    const details = await pool.query("select * from usage_provider_daily where device_id = $1", [client.getDeviceId()]);
    assert.equal(details.rows[0].input_tokens, 7);
  });
});
