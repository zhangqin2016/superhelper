#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);

const {
  DEFAULT_COLLABORATION_POLICY,
  applyCollaborationPolicyGate,
  profileMatchesCollaborationContext,
  resolveCollaborationPolicy,
} = await import("../server/src/services/collaboration/policy.js");
const { buildEnvManagedClientConfig } = await import("../server/src/services/client-config.js");
const { assertProductionSecrets } = await import("../server/src/config.js");

assert.deepEqual(DEFAULT_COLLABORATION_POLICY, {
  enabled: false,
  schemaVersion: 1,
  realtime: true,
  attachments: false,
  workspaceShares: false,
  aiTools: false,
});

assert.deepEqual(resolveCollaborationPolicy({}), DEFAULT_COLLABORATION_POLICY);
assert.deepEqual(resolveCollaborationPolicy({ enabled: true }), {
  ...DEFAULT_COLLABORATION_POLICY,
  enabled: true,
});
assert.deepEqual(resolveCollaborationPolicy({
  enabled: true,
  attachments: true,
  workspaceShares: true,
  aiTools: true,
}), {
  enabled: true,
  schemaVersion: 1,
  realtime: true,
  attachments: true,
  workspaceShares: true,
  aiTools: true,
});
assert.deepEqual(resolveCollaborationPolicy({ enabled: true }, { killSwitch: true }), DEFAULT_COLLABORATION_POLICY);
assert.deepEqual(resolveCollaborationPolicy({ schemaVersion: 2, enabled: true }), DEFAULT_COLLABORATION_POLICY);
assert.deepEqual(resolveCollaborationPolicy({ schemaVersion: "1", enabled: true }), DEFAULT_COLLABORATION_POLICY);
assert.deepEqual(resolveCollaborationPolicy({ schemaVersion: true, enabled: true }), DEFAULT_COLLABORATION_POLICY);
assert.deepEqual(resolveCollaborationPolicy(null), DEFAULT_COLLABORATION_POLICY);

const profileEnabledConfig = {
  models: { activePresetId: "keep-this-model" },
  collaboration: { enabled: true, schemaVersion: 1, attachments: true },
};
assert.deepEqual(
  applyCollaborationPolicyGate(profileEnabledConfig, { collaborationEnabled: false }),
  { ...profileEnabledConfig, collaboration: DEFAULT_COLLABORATION_POLICY },
  "the server master switch must close collaboration even if a signed profile tries to enable it",
);
assert.deepEqual(
  applyCollaborationPolicyGate(profileEnabledConfig, {
    collaborationEnabled: true,
    killSwitch: true,
  }),
  { ...profileEnabledConfig, collaboration: DEFAULT_COLLABORATION_POLICY },
  "the explicit kill switch must beat every profile",
);
assert.deepEqual(
  applyCollaborationPolicyGate(profileEnabledConfig, {
    collaborationEnabled: true,
    organizationEligible: false,
  }),
  { ...profileEnabledConfig, collaboration: DEFAULT_COLLABORATION_POLICY },
  "organization rollout denial must only close collaboration",
);
assert.equal(
  applyCollaborationPolicyGate(profileEnabledConfig, { collaborationEnabled: false }).models.activePresetId,
  "keep-this-model",
  "a collaboration policy failure must not mutate unrelated signed configuration",
);
assert.deepEqual(
  applyCollaborationPolicyGate(profileEnabledConfig, {
    collaborationEnabled: true,
    realtime: true,
    attachments: false,
    workspaceShares: false,
    aiTools: false,
  }).collaboration,
  { ...DEFAULT_COLLABORATION_POLICY, enabled: true },
  "a profile must never re-enable a server-disabled collaboration capability",
);

assert.equal(
  profileMatchesCollaborationContext({ scope: "user", target_id: "user-1" }, { userId: "user-1" }),
  true,
  "a user-scoped signed profile must only target its authenticated user",
);
assert.equal(
  profileMatchesCollaborationContext({ scope: "user", target_id: "user-1" }, { userId: "user-2" }), false);
assert.equal(
  profileMatchesCollaborationContext(
    { scope: "organization", target_id: "org-1" },
    { organizationIds: ["org-2", "org-1"] },
  ),
  true,
  "an organization-scoped signed profile must require verified membership",
);
assert.equal(
  profileMatchesCollaborationContext(
    { scope: "organization", target_id: "org-1" },
    { organizationIds: ["org-2"] },
  ),
  false,
);

const delivered = buildEnvManagedClientConfig({
  collaborationEnabled: true,
  collaborationRealtimeEnabled: true,
  collaborationAttachmentsEnabled: true,
  collaborationWorkspaceSharesEnabled: true,
  collaborationAiToolsEnabled: false,
}, [], "gateway");
assert.deepEqual(delivered?.collaboration, {
  enabled: true,
  schemaVersion: 1,
  realtime: true,
  attachments: true,
  workspaceShares: true,
  aiTools: false,
});

assert.throws(
  () => assertProductionSecrets({
    NODE_ENV: "production",
    SESSION_SECRET: "safe-session-secret",
    MODEL_GATEWAY_TOKEN_SECRET: "safe-gateway-secret",
    COLLABORATION_ENABLED: "true",
  }, {
    sessionSecret: "safe-session-secret",
    modelGatewayTokenSecret: "safe-gateway-secret",
    collaborationEnabled: true,
    collaborationMessageKek: "",
  }),
  /COLLAB_MESSAGE_KEK/,
  "production must refuse collaboration without its server-only message KEK",
);
assert.doesNotThrow(() => assertProductionSecrets({
  NODE_ENV: "production",
    SESSION_SECRET: "safe-session-secret",
    MODEL_GATEWAY_TOKEN_SECRET: "safe-gateway-secret",
    COLLABORATION_ENABLED: "false",
}, {
  sessionSecret: "safe-session-secret",
  modelGatewayTokenSecret: "safe-gateway-secret",
  collaborationEnabled: false,
  collaborationMessageKek: "",
}), "disabling collaboration must leave existing production capability available");

const remoteUserData = fs.mkdtempSync(path.join(os.tmpdir(), "lily-collaboration-policy-"));
process.env.LILY_USER_DATA_DIR = remoteUserData;
const remoteConfig = require("../src/main/remote-config.js");
function writeRemoteConfigCache(state) {
  fs.writeFileSync(path.join(remoteUserData, "remote-config-cache.json"), JSON.stringify({
    config: { encrypted: false, data: Buffer.from(JSON.stringify(state), "utf8").toString("base64") },
  }));
  remoteConfig.reloadRemoteConfigCache();
}

const untouchedRemoteModels = { activePresetId: "service-model", presets: [{ id: "service-model" }] };
writeRemoteConfigCache({
  schemaVersion: 1,
  configVersion: "collaboration-policy-test",
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
  effectiveConfig: {
    models: untouchedRemoteModels,
    collaboration: { enabled: true, schemaVersion: "1" },
  },
});
assert.deepEqual(
  remoteConfig.getRemoteCollaborationPolicySync(),
  DEFAULT_COLLABORATION_POLICY,
  "unknown collaboration schemas must resolve to a stable disabled policy",
);
assert.deepEqual(
  remoteConfig.getRemoteEffectiveConfigSync().models,
  untouchedRemoteModels,
  "an invalid collaboration block must not discard other valid remote configuration",
);
writeRemoteConfigCache({
  schemaVersion: 1,
  configVersion: "collaboration-policy-stale",
  expiresAt: new Date(Date.now() - 60_000).toISOString(),
  effectiveConfig: { collaboration: { enabled: true, schemaVersion: 1 } },
});
assert.deepEqual(
  remoteConfig.getRemoteCollaborationPolicySync(),
  DEFAULT_COLLABORATION_POLICY,
  "stale signed config must disable collaboration deterministically",
);
fs.rmSync(remoteUserData, { recursive: true, force: true });

console.log("collaboration-policy: ok");
