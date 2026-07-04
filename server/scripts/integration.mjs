import assert from "node:assert/strict";
import crypto from "node:crypto";
import pg from "pg";

process.env.DATABASE_URL ||= "postgres://integration:integration@localhost:5432/integration";
process.env.ADMIN_TOKEN ||= "integration-token";
process.env.ALLOW_UNSIGNED_LICENSES ||= "true";
process.env.PUBLIC_BASE_URL ||= "https://lily.integration.test";
process.env.QINIU_ACCESS_KEY ||= "integration-qiniu-ak";
process.env.QINIU_SECRET_KEY ||= "integration-qiniu-sk";
process.env.QINIU_BUCKET ||= "integration-bucket";
process.env.QINIU_PUBLIC_BASE_URL ||= "https://qiniu.integration.test";
process.env.MODEL_GATEWAY_PROVIDERS ||= JSON.stringify({
  deepseek: {
    type: "anthropic",
    baseUrl: "https://upstream.integration.test/anthropic",
    apiKey: "integration-upstream-key",
    models: ["deepseek-v4-pro[1m]"],
  },
  openai_mock: {
    type: "openai",
    baseUrl: "https://openai-upstream.integration.test/v1",
    apiKey: "integration-openai-key",
  },
});

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
}

function base64urlEncode(input) {
  return Buffer.from(input)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function sha256(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

function signedHeaders({ method, pathname, payload, deviceId, privateKey }) {
  const timestamp = new Date().toISOString();
  const nonce = crypto.randomUUID();
  const bodyHash = sha256(stableStringify(payload));
  const canonical = {
    method: method.toUpperCase(),
    pathname,
    timestamp,
    nonce,
    bodyHash,
  };
  const signature = crypto.sign(
    null,
    Buffer.from(stableStringify(canonical)),
    crypto.createPrivateKey(privateKey),
  );
  return {
    "X-Lily-Device-Id": deviceId,
    "X-Lily-Key-Alg": "ed25519",
    "X-Lily-Timestamp": timestamp,
    "X-Lily-Nonce": nonce,
    "X-Lily-Body-Sha256": bodyHash,
    "X-Lily-Signature": base64urlEncode(signature),
  };
}

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
  const { createAccessToken, hashRefreshToken, verifyWebSessionToken } = await import("../src/services/account-auth.js");
  const { signModelGatewayToken } = await import("../src/services/model-gateway.js");
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
      features: ["updates", "skill-packages", "usage"],
    },
  });
  assert.equal(created.statusCode, 201);
  const licenseKey = created.json().licenseKey;
  const licenseId = created.json().licenseId;
  const deviceKeys = crypto.generateKeyPairSync("ed25519");
  const publicKey = deviceKeys.publicKey.export({ type: "spki", format: "pem" });
  const privateKey = deviceKeys.privateKey.export({ type: "pkcs8", format: "pem" });

  const activationPayload = {
    deviceId: `dev_integration_${runId}`,
    fingerprintHash: "integration-hash",
    platform: "darwin",
    arch: "arm64",
    appVersion: "0.0.0",
    publicKey,
    keyAlg: "ed25519",
    licenseKey,
  };
  const activated = await app.inject({ method: "POST", url: "/api/licenses/activate", payload: activationPayload });
  assert.equal(activated.statusCode, 200);
  assert.equal(activated.json().license.licenseId, licenseId);

  const verifyPayload = { ...activationPayload, licenseId };
  const verified = await app.inject({
    method: "POST",
    url: "/api/licenses/verify",
    headers: signedHeaders({
      method: "POST",
      pathname: "/api/licenses/verify",
      payload: verifyPayload,
      deviceId: activationPayload.deviceId,
      privateKey,
    }),
    payload: verifyPayload,
  });
  assert.equal(verified.statusCode, 200);

  const accountUserId = `usr_integration_${runId}`;
  const accountSessionId = `sess_integration_${runId}`;
  await pool.query(
    "insert into users (id, phone_e164, status, last_login_at) values ($1, $2, 'active', now())",
    [accountUserId, `+86138${String(runId).slice(-7)}`],
  );
  await pool.query(
    "insert into user_sessions (id, user_id, device_id, refresh_token_hash, expires_at, last_seen_at) values ($1, $2, $3, $4, now() + interval '7 days', now())",
    [accountSessionId, accountUserId, activationPayload.deviceId, hashRefreshToken(`integration_refresh_${runId}`)],
  );
  const accountAccessToken = createAccessToken({
    userId: accountUserId,
    sessionId: accountSessionId,
    deviceId: activationPayload.deviceId,
    scopes: ["account", "billing"],
  });
  const billingLinkPayload = {
    deviceId: activationPayload.deviceId,
    fingerprintHash: activationPayload.fingerprintHash,
    platform: activationPayload.platform,
    arch: activationPayload.arch,
    appVersion: activationPayload.appVersion,
    publicKey,
    keyAlg: "ed25519",
  };
  const billingLink = await app.inject({
    method: "POST",
    url: "/api/account/billing-link",
    headers: {
      Authorization: `Bearer ${accountAccessToken}`,
      ...signedHeaders({
        method: "POST",
        pathname: "/api/account/billing-link",
        payload: billingLinkPayload,
        deviceId: activationPayload.deviceId,
        privateKey,
      }),
    },
    payload: billingLinkPayload,
  });
  assert.equal(billingLink.statusCode, 200);
  const billingToken = new URL(billingLink.json().url).searchParams.get("token");
  assert.match(billingToken, /^one_time_/);

  const consumedBillingLink = await app.inject({
    method: "POST",
    url: "/api/account/billing-link/consume",
    payload: { token: billingToken },
  });
  assert.equal(consumedBillingLink.statusCode, 200);
  const consumedSession = verifyWebSessionToken(consumedBillingLink.json().webSessionToken);
  assert.equal(consumedSession.ok, true);
  assert.equal(consumedSession.userId, accountUserId);
  assert.equal(consumedSession.sessionId, accountSessionId);

  const reusedBillingLink = await app.inject({
    method: "POST",
    url: "/api/account/billing-link/consume",
    payload: { token: billingToken },
  });
  assert.equal(reusedBillingLink.statusCode, 410);

  const globalProfile = await app.inject({
    method: "POST",
    url: "/api/admin/config-profiles",
    headers: adminHeaders,
    payload: {
      id: `global-integration-${runId}`,
      name: "Integration Global Config",
      scope: "global",
      priority: 0,
      enabled: true,
      config: {
        models: {
          activePresetId: "managed-standard",
          presets: [
            {
              id: "managed-standard",
              label: "Managed Standard",
              env: {
                LILY_API_BASE_URL: "https://lilych.lilywb.cn/llm",
                LILY_MODEL: "integration-main",
                LILY_MODEL_HAIKU: "integration-fast",
                LILY_MODEL_SONNET: "integration-main",
                LILY_MODEL_OPUS: "integration-strong",
                LILY_SUBAGENT_MODEL: "integration-fast",
              },
            },
          ],
        },
      },
    },
  });
  assert.equal(globalProfile.statusCode, 201);

  const deviceProfile = await app.inject({
    method: "POST",
    url: "/api/admin/config-profiles",
    headers: adminHeaders,
    payload: {
      id: `device-integration-${runId}`,
      name: "Integration Device Override",
      scope: "device",
      targetId: activationPayload.deviceId,
      priority: 100,
      enabled: true,
      config: {
        models: {
          activePresetId: "managed-device",
          presets: [
            {
              id: "managed-device",
              label: "Managed Device",
              env: {
                LILY_API_BASE_URL: "https://lilych.lilywb.cn/device-llm",
                LILY_MODEL: "integration-device-main",
              },
            },
          ],
        },
      },
    },
  });
  assert.equal(deviceProfile.statusCode, 201);

  const blockedRolloutProfile = await app.inject({
    method: "POST",
    url: "/api/admin/config-profiles",
    headers: adminHeaders,
    payload: {
      id: `rollout-blocked-${runId}`,
      name: "Integration Blocked Rollout",
      scope: "global",
      priority: 1000,
      rolloutPercent: 0,
      enabled: true,
      config: {
        models: {
          activePresetId: "managed-blocked",
          presets: [{ id: "managed-blocked", label: "Blocked Rollout" }],
        },
      },
    },
  });
  assert.equal(blockedRolloutProfile.statusCode, 201);

  const unsignedClientConfig = await app.inject({
    method: "POST",
    url: "/api/client/config",
    payload: { ...activationPayload, licenseId },
  });
  assert.equal(unsignedClientConfig.statusCode, 401);

  const configPayload = { ...activationPayload, licenseId };
  const configHeaders = signedHeaders({
    method: "POST",
    pathname: "/api/client/config",
    payload: configPayload,
    deviceId: activationPayload.deviceId,
    privateKey,
  });
  const clientConfig = await app.inject({
    method: "POST",
    url: "/api/client/config",
    headers: configHeaders,
    payload: configPayload,
  });
  assert.equal(clientConfig.statusCode, 200);
  assert.equal(clientConfig.json().ok, true);
  assert.equal(clientConfig.json().effectiveConfig.models.activePresetId, "managed-device");
  assert.equal(clientConfig.json().effectiveConfig.models.presets[0].env.LILY_MODEL, "integration-device-main");
  assert.ok(!clientConfig.json().appliedProfileIds.includes(`rollout-blocked-${runId}`));
  assert.ok(clientConfig.json().signature);

  const brokenDeviceProfile = await app.inject({
    method: "PATCH",
    url: `/api/admin/config-profiles/device-integration-${runId}`,
    headers: adminHeaders,
    payload: {
      config: {
        models: {
          activePresetId: "managed-broken",
          presets: [{ id: "managed-broken", label: "Broken Config" }],
        },
      },
    },
  });
  assert.equal(brokenDeviceProfile.statusCode, 200);

  const rolledBackProfile = await app.inject({
    method: "POST",
    url: `/api/admin/config-profiles/device-integration-${runId}/rollback`,
    headers: adminHeaders,
    payload: {},
  });
  assert.equal(rolledBackProfile.statusCode, 200);

  const afterRollbackConfig = await app.inject({
    method: "POST",
    url: "/api/client/config",
    headers: signedHeaders({
      method: "POST",
      pathname: "/api/client/config",
      payload: configPayload,
      deviceId: activationPayload.deviceId,
      privateKey,
    }),
    payload: configPayload,
  });
  assert.equal(afterRollbackConfig.statusCode, 200);
  assert.equal(afterRollbackConfig.json().effectiveConfig.models.activePresetId, "managed-device");

  const gatewayProfile = await app.inject({
    method: "POST",
    url: "/api/admin/config-profiles",
    headers: adminHeaders,
    payload: {
      id: `gateway-integration-${runId}`,
      name: "Integration Gateway Config",
      scope: "device",
      targetId: activationPayload.deviceId,
      priority: 200,
      enabled: true,
      config: {
        models: {
          activePresetId: "managed-gateway",
          presets: [
            {
              id: "managed-gateway",
              label: "Managed Gateway",
              env: {
                LILY_API_BASE_URL: "/llm/deepseek",
                LILY_API_KEY: "$LILY_GATEWAY_TOKEN",
                LILY_GATEWAY_PROVIDER: "deepseek",
                LILY_MODEL: "deepseek-v4-pro[1m]",
                LILY_MODEL_HAIKU: "deepseek-v4-pro[1m]",
                LILY_MODEL_SONNET: "deepseek-v4-pro[1m]",
                LILY_MODEL_OPUS: "deepseek-v4-pro[1m]",
                LILY_SUBAGENT_MODEL: "deepseek-v4-pro[1m]",
              },
            },
          ],
        },
      },
    },
  });
  assert.equal(gatewayProfile.statusCode, 201);

  const gatewayConfig = await app.inject({
    method: "POST",
    url: "/api/client/config",
    headers: signedHeaders({
      method: "POST",
      pathname: "/api/client/config",
      payload: configPayload,
      deviceId: activationPayload.deviceId,
      privateKey,
    }),
    payload: configPayload,
  });
  assert.equal(gatewayConfig.statusCode, 200);
  const gatewayEnv = gatewayConfig.json().effectiveConfig.models.presets[0].env;
  assert.equal(gatewayEnv.LILY_API_BASE_URL, "https://lily.integration.test/llm/deepseek");
  assert.match(gatewayEnv.LILY_API_KEY, /^lilygw\./);

  const unauthorizedGateway = await app.inject({
    method: "POST",
    url: "/llm/deepseek/v1/messages",
    payload: { model: "deepseek-v4-pro[1m]", messages: [{ role: "user", content: "hello" }] },
  });
  assert.equal(unauthorizedGateway.statusCode, 401);

  const originalFetch = globalThis.fetch;
  let upstreamRequest = null;
  globalThis.fetch = async (url, init) => {
    upstreamRequest = { url: String(url), init };
    if (String(url).endsWith("/v1/messages/count_tokens")) {
      return new Response(JSON.stringify({ input_tokens: 11 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify({
      id: "msg_integration",
      type: "message",
      role: "assistant",
      model: "deepseek-v4-pro[1m]",
      content: [{ type: "text", text: "gateway ok" }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 3, output_tokens: 2 },
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  const gatewayResponse = await app.inject({
    method: "POST",
    url: "/llm/deepseek/v1/messages",
    headers: { Authorization: `Bearer ${gatewayEnv.LILY_API_KEY}` },
    payload: {
      model: "deepseek-v4-pro[1m]",
      messages: [{ role: "user", content: "hello" }],
      max_tokens: 16,
    },
  });
  assert.equal(gatewayResponse.statusCode, 200);
  assert.equal(gatewayResponse.json().content[0].text, "gateway ok");
  assert.equal(upstreamRequest.url, "https://upstream.integration.test/anthropic/v1/messages");
  assert.equal(upstreamRequest.init.headers["x-api-key"], "integration-upstream-key");

  const countTokensResponse = await app.inject({
    method: "POST",
    url: "/llm/deepseek/v1/messages/count_tokens",
    headers: { Authorization: `Bearer ${gatewayEnv.LILY_API_KEY}` },
    payload: {
      model: "deepseek-v4-pro[1m]",
      messages: [{ role: "user", content: "count me" }],
    },
  });
  assert.equal(countTokensResponse.statusCode, 200);
  assert.equal(countTokensResponse.json().input_tokens, 11);
  assert.equal(upstreamRequest.url, "https://upstream.integration.test/anthropic/v1/messages/count_tokens");

  const modelListResponse = await app.inject({
    method: "GET",
    url: "/llm/deepseek/v1/models",
    headers: { Authorization: `Bearer ${gatewayEnv.LILY_API_KEY}` },
  });
  assert.equal(modelListResponse.statusCode, 200);
  assert.equal(modelListResponse.json().data[0].id, "deepseek-v4-pro[1m]");
  globalThis.fetch = originalFetch;

  globalThis.fetch = async (url, init) => {
    upstreamRequest = { url: String(url), init };
    return new Response(JSON.stringify({
      id: "chatcmpl-integration",
      model: "gpt-test",
      choices: [{ message: { role: "assistant", content: "openai gateway ok" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 3, completion_tokens: 2 },
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  const openAiGatewayToken = signModelGatewayToken({
    deviceId: activationPayload.deviceId,
    licenseId,
    providerId: "openai_mock",
  });
  const openAiResponse = await app.inject({
    method: "POST",
    url: "/llm/openai_mock/v1/messages",
    headers: { Authorization: `Bearer ${openAiGatewayToken}` },
    payload: {
      model: "gpt-test",
      messages: [{ role: "user", content: "hello" }],
      max_tokens: 16,
    },
  });
  globalThis.fetch = originalFetch;
  assert.equal(openAiResponse.statusCode, 200);
  assert.equal(openAiResponse.json().content[0].text, "openai gateway ok");
  assert.equal(upstreamRequest.url, "https://openai-upstream.integration.test/v1/chat/completions");
  assert.equal(upstreamRequest.init.headers.Authorization, "Bearer integration-openai-key");

  const replayedClientConfig = await app.inject({
    method: "POST",
    url: "/api/client/config",
    headers: configHeaders,
    payload: configPayload,
  });
  assert.equal(replayedClientConfig.statusCode, 401);
  assert.equal(replayedClientConfig.json().code, "DEVICE_SIGNATURE_REPLAYED");

  const rotatedKeys = crypto.generateKeyPairSync("ed25519");
  const rotatedPublicKey = rotatedKeys.publicKey.export({ type: "spki", format: "pem" });
  const rotatedPrivateKey = rotatedKeys.privateKey.export({ type: "pkcs8", format: "pem" });
  const rotatePayload = {
    ...activationPayload,
    licenseId,
    newPublicKey: rotatedPublicKey,
    newKeyAlg: "ed25519",
  };
  const rotated = await app.inject({
    method: "POST",
    url: "/api/devices/rotate-key",
    headers: signedHeaders({
      method: "POST",
      pathname: "/api/devices/rotate-key",
      payload: rotatePayload,
      deviceId: activationPayload.deviceId,
      privateKey,
    }),
    payload: rotatePayload,
  });
  assert.equal(rotated.statusCode, 200);

  const oldKeyAfterRotation = await app.inject({
    method: "POST",
    url: "/api/client/config",
    headers: signedHeaders({
      method: "POST",
      pathname: "/api/client/config",
      payload: configPayload,
      deviceId: activationPayload.deviceId,
      privateKey,
    }),
    payload: configPayload,
  });
  assert.equal(oldKeyAfterRotation.statusCode, 401);
  assert.equal(oldKeyAfterRotation.json().code, "DEVICE_SIGNATURE_INVALID");

  const newKeyAfterRotation = await app.inject({
    method: "POST",
    url: "/api/client/config",
    headers: signedHeaders({
      method: "POST",
      pathname: "/api/client/config",
      payload: configPayload,
      deviceId: activationPayload.deviceId,
      privateKey: rotatedPrivateKey,
    }),
    payload: configPayload,
  });
  assert.equal(newKeyAfterRotation.statusCode, 200);

  const usagePayload = {
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
  };
  const unsignedUsage = await app.inject({
    method: "POST",
    url: "/api/usage/report",
    payload: usagePayload,
  });
  assert.equal(unsignedUsage.statusCode, 401);

  const usage = await app.inject({
    method: "POST",
    url: "/api/usage/report",
    headers: signedHeaders({
      method: "POST",
      pathname: "/api/usage/report",
      payload: usagePayload,
      deviceId: activationPayload.deviceId,
      privateKey: rotatedPrivateKey,
    }),
    payload: usagePayload,
  });
  assert.equal(usage.statusCode, 200);

  const usageSummaryPayload = {
    deviceId: activationPayload.deviceId,
    fingerprintHash: "integration-hash",
    platform: "darwin",
    arch: "arm64",
    appVersion: "0.0.0",
    publicKey,
    keyAlg: "ed25519",
    historyDays: 7,
  };
  const usageSummary = await app.inject({
    method: "POST",
    url: "/api/usage/summary",
    headers: signedHeaders({
      method: "POST",
      pathname: "/api/usage/summary",
      payload: usageSummaryPayload,
      deviceId: activationPayload.deviceId,
      privateKey: rotatedPrivateKey,
    }),
    payload: usageSummaryPayload,
  });
  assert.equal(usageSummary.statusCode, 200);
  assert.equal(usageSummary.json().deviceId, activationPayload.deviceId);

  const skillEventPayload = {
    deviceId: activationPayload.deviceId,
    licenseId,
    fingerprintHash: "integration-hash",
    platform: "darwin",
    arch: "arm64",
    appVersion: "0.0.0",
    publicKey,
    keyAlg: "ed25519",
    eventType: "install",
    skillId: "integration-skill",
    skillVersion: "1.0.0",
    metadata: { source: "integration" },
  };
  const skillEvent = await app.inject({
    method: "POST",
    url: "/api/skills/events",
    headers: signedHeaders({
      method: "POST",
      pathname: "/api/skills/events",
      payload: skillEventPayload,
      deviceId: activationPayload.deviceId,
      privateKey: rotatedPrivateKey,
    }),
    payload: skillEventPayload,
  });
  assert.equal(skillEvent.statusCode, 200);

  const diagnosticPayload = {
    deviceId: activationPayload.deviceId,
    licenseId,
    fingerprintHash: "integration-hash",
    platform: "darwin",
    arch: "arm64",
    appVersion: "0.0.0",
    publicKey,
    keyAlg: "ed25519",
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
  };
  const diagnostic = await app.inject({
    method: "POST",
    url: "/api/diagnostics/runtime-traces",
    headers: signedHeaders({
      method: "POST",
      pathname: "/api/diagnostics/runtime-traces",
      payload: diagnosticPayload,
      deviceId: activationPayload.deviceId,
      privateKey: rotatedPrivateKey,
    }),
    payload: diagnosticPayload,
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
      attachments: [
        {
          key: "feedback/dev_integration/draft/example.png",
          name: "example.png",
          mimeType: "image/png",
          sizeBytes: 128,
          width: 320,
          height: 200,
        },
      ],
    },
  });
  assert.equal(contact.statusCode, 201);
  assert.ok(contact.json().id);

  const attachmentToken = await app.inject({
    method: "POST",
    url: "/api/contact-attachments/upload-token",
    headers: { "X-Lily-Device-Id": "dev_integration" },
    payload: {
      draftId: "draft_integration",
      fileName: "screenshot.png",
      mimeType: "image/png",
      sizeBytes: 256,
    },
  });
  assert.equal(attachmentToken.statusCode, 200);
  assert.ok(attachmentToken.json().token.includes("integration-qiniu-ak:"));
  assert.ok(attachmentToken.json().key.startsWith("feedback/dev_integration/draft_integration/"));

  const legacyContact = await app.inject({
    method: "POST",
    url: "/api/contact",
    payload: {
      name: "Legacy Contact",
      email: "legacy@example.com",
      message: "Please keep the old contact endpoint compatible.",
      source: "legacy",
    },
  });
  assert.equal(legacyContact.statusCode, 201);
  assert.ok(legacyContact.json().id);

  const contacts = await app.inject({
    method: "GET",
    url: "/api/admin/contact-requests",
    headers: adminHeaders,
  });
  assert.equal(contacts.statusCode, 200);
  assert.ok(contacts.json().contacts.some((item) => item.id === contact.json().id));
  const adminContact = contacts.json().contacts.find((item) => item.id === contact.json().id);
  const adminAttachment = adminContact?.attachments?.find(
    (item) => item.object_key === "feedback/dev_integration/draft/example.png",
  );
  assert.ok(adminAttachment);
  assert.equal(
    adminAttachment.public_url,
    "https://qiniu.integration.test/feedback/dev_integration/draft/example.png",
  );
  assert.equal(adminAttachment.publicUrl, adminAttachment.public_url);
  assert.ok(contacts.json().contacts.some((item) => item.id === legacyContact.json().id));

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
  const olderRelease = await app.inject({
    method: "POST",
    url: "/api/admin/releases",
    headers: adminHeaders,
    payload: {
      version: "0.0.1",
      platform: "darwin-arm64",
      url: "https://example.com/old.dmg",
      sha256: "abcdef1234567890",
      sizeBytes: 1,
      notes: "older release inserted after newest",
      enabled: true,
    },
  });
  assert.equal(olderRelease.statusCode, 201);

  const latest = await app.inject({ method: "GET", url: "/api/releases/latest?platform=darwin-arm64&version=0.0.0" });
  assert.equal(latest.statusCode, 200);
  assert.equal(latest.json().sizeBytes, 123);
  assert.equal(latest.json().version, `9.9.9-integration-${runId}`);

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
