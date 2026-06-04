import assert from "node:assert/strict";
import pg from "pg";

process.env.DATABASE_URL ||= "postgres://integration:integration@localhost:5432/integration";
process.env.ADMIN_TOKEN ||= "integration-token";
process.env.ALLOW_UNSIGNED_LICENSES ||= "true";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

async function hasDatabase() {
  try {
    await pool.query("select 1");
    return true;
  } catch {
    return false;
  }
}

if (!(await hasDatabase())) {
  console.log("server-integration: skipped (DATABASE_URL unavailable)");
  await pool.end();
  process.exit(0);
}

try {
  const fs = await import("node:fs");
  const migrationFiles = fs
    .readdirSync(new URL("../migrations", import.meta.url))
    .filter((name) => name.endsWith(".sql"))
    .sort();
  for (const file of migrationFiles) {
    await pool.query(fs.readFileSync(new URL(`../migrations/${file}`, import.meta.url), "utf8"));
  }

  const { buildApp } = await import("../src/app.js");
  const app = await buildApp();
  const adminHeaders = { Authorization: `Bearer ${process.env.ADMIN_TOKEN}` };
  const runId = Date.now();

  const resetSettings = await app.inject({
    method: "PATCH",
    url: "/api/admin/settings",
    headers: adminHeaders,
    payload: { licenseTrialDays: 3 },
  });
  assert.equal(resetSettings.statusCode, 200);

  const settings = await app.inject({
    method: "GET",
    url: "/api/admin/settings",
    headers: adminHeaders,
  });
  assert.equal(settings.statusCode, 200);
  assert.equal(settings.json().settings.licenseTrialDays, 3);

  const updatedSettings = await app.inject({
    method: "PATCH",
    url: "/api/admin/settings",
    headers: adminHeaders,
    payload: { licenseTrialDays: 5 },
  });
  assert.equal(updatedSettings.statusCode, 200);
  assert.equal(updatedSettings.json().settings.licenseTrialDays, 5);

  const trialDevice = await app.inject({
    method: "POST",
    url: "/api/devices/register",
    payload: {
      deviceId: `dev_trial_${runId}`,
      fingerprintHash: "trial-hash",
      platform: "darwin",
      arch: "arm64",
      appVersion: "0.0.0",
    },
  });
  assert.equal(trialDevice.statusCode, 200);
  assert.equal(trialDevice.json().trial.valid, true);
  assert.ok(trialDevice.json().trial.expiresAt);

  const created = await app.inject({
    method: "POST",
    url: "/api/admin/licenses",
    headers: adminHeaders,
    payload: {
      customerName: "Integration",
      plan: "pro",
      seats: 1,
      expiresAt: new Date(Date.now() + 86400_000).toISOString(),
      features: ["updates", "plugins", "usage"],
    },
  });
  assert.equal(created.statusCode, 201);
  const licenseKey = created.json().licenseKey;
  const licenseId = created.json().licenseId;

  const activationPayload = {
    deviceId: `dev_integration_${runId}`,
    fingerprintHash: "integration-hash",
    platform: "darwin",
    arch: "arm64",
    appVersion: "0.0.0",
    licenseKey,
  };
  const activated = await app.inject({ method: "POST", url: "/api/licenses/activate", payload: activationPayload });
  assert.equal(activated.statusCode, 200);
  assert.equal(activated.json().license.licenseId, licenseId);

  const verified = await app.inject({
    method: "POST",
    url: "/api/licenses/verify",
    payload: { ...activationPayload, licenseId },
  });
  assert.equal(verified.statusCode, 200);

  const usage = await app.inject({
    method: "POST",
    url: "/api/usage/report",
    payload: {
      deviceId: activationPayload.deviceId,
      licenseId,
      date: new Date().toISOString().slice(0, 10),
      model: "integration-model",
      messageCount: 1,
      imageCount: 1,
      toolCallCount: 1,
      pluginCallCount: 0,
      inputTokens: 10,
      outputTokens: 20,
    },
  });
  assert.equal(usage.statusCode, 200);

  const diagnostic = await app.inject({
    method: "POST",
    url: "/api/diagnostics/runtime-traces",
    payload: {
      deviceId: activationPayload.deviceId,
      licenseId,
      fingerprintHash: "integration-hash",
      platform: "darwin",
      arch: "arm64",
      appVersion: "0.0.0",
      claudeVersion: "2.1.160",
      eventType: "system",
      eventSubtype: "new_protocol_shape",
      normalizedKind: "protocol_warning",
      severity: "warning",
      turnPhase: "busy",
      sessionState: "running",
      summary: "unknownEvent",
      trace: {
        schemaVersion: 1,
        event: { type: "system", subtype: "new_protocol_shape", keys: ["type", "subtype"] },
      },
    },
  });
  assert.equal(diagnostic.statusCode, 201);
  assert.ok(diagnostic.json().id);

  const diagnostics = await app.inject({
    method: "GET",
    url: "/api/admin/diagnostics?days=1",
    headers: adminHeaders,
  });
  assert.equal(diagnostics.statusCode, 200);
  assert.ok(diagnostics.json().diagnostics.some((item) => item.id === diagnostic.json().id));
  assert.ok(diagnostics.json().byKind.some((item) => item.kind === "protocol_warning"));

  const diagnosticDetail = await app.inject({
    method: "GET",
    url: `/api/admin/diagnostics/${diagnostic.json().id}`,
    headers: adminHeaders,
  });
  assert.equal(diagnosticDetail.statusCode, 200);
  assert.equal(diagnosticDetail.json().diagnostic.normalized_kind, "protocol_warning");

  const contact = await app.inject({
    method: "POST",
    url: "/api/contact-requests",
    payload: {
      name: "Integration Contact",
      email: "integration@example.com",
      company: "Integration Co",
      phone: "123456",
      subject: "Team deployment",
      message: "We need a managed Lily Workbench team deployment.",
      source: "integration",
    },
  });
  assert.equal(contact.statusCode, 201);
  assert.ok(contact.json().id);

  const contacts = await app.inject({
    method: "GET",
    url: "/api/admin/contact-requests",
    headers: adminHeaders,
  });
  assert.equal(contacts.statusCode, 200);
  assert.ok(contacts.json().contacts.some((item) => item.id === contact.json().id));

  const release = await app.inject({
    method: "POST",
    url: "/api/admin/releases",
    headers: adminHeaders,
    payload: {
      version: `9.9.9-integration-${runId}`,
      platform: "darwin-arm64",
      url: "https://example.com/app.dmg",
      sha256: "1234567890abcdef",
      sizeBytes: 123,
      notes: "integration",
      enabled: true,
    },
  });
  assert.equal(release.statusCode, 201);

  const latest = await app.inject({ method: "GET", url: "/api/releases/latest?platform=darwin-arm64&version=0.0.0" });
  assert.equal(latest.statusCode, 200);
  assert.equal(latest.json().sizeBytes, 123);

  const restoredSettings = await app.inject({
    method: "PATCH",
    url: "/api/admin/settings",
    headers: adminHeaders,
    payload: { licenseTrialDays: 3 },
  });
  assert.equal(restoredSettings.statusCode, 200);

  await app.close();
  console.log("server-integration: ok");
} finally {
  await pool.end();
}
