import { z } from "zod";
import { config } from "../../config.js";
import { db } from "../../db.js";
import { signConfigPayload } from "../../services/security.js";
import {
  buildClientBootstrapPolicy,
} from "../../services/client-bootstrap.js";
import {
  buildEnvManagedClientConfig,
  DEFAULT_EFFECTIVE_CONFIG,
  clientConfigTtlMs,
  expandModelProviderMenu,
  resolveAccountContextForClientConfig,
  rolloutAllows,
  withGatewayRuntimeConfig,
} from "../../services/client-config.js";
import {
  applyCollaborationPolicyGate,
} from "../../services/collaboration/policy.js";
import { discoverLilyMediaProviderContracts } from "../../services/media-provider-contracts.js";
import {
  recoverLicenseScopeByFingerprint,
  requireSignedDeviceRequest,
  trialPayload,
  upsertDevice,
  validLicenseScope,
} from "../../services/device-identity.js";
import { registerDeviceSchema } from "./devices.js";
import { listAvailableAgentIds, resolveAgentSelection } from "../../services/agent-packages.js";
import { zodBody, okResponse } from "../../openapi.js";
import { selectProfilesForTarget } from "../../services/config-profile-selection.js";
import { createDeliveryTrace } from "../../services/config-delivery-trace.js";

const clientConfigSchema = registerDeviceSchema.extend({
  licenseId: z.string().max(80).optional().nullable(),
  accountAccessToken: z.string().max(4096).optional().nullable(),
  publicKey: registerDeviceSchema.shape.publicKey,
  keyAlg: registerDeviceSchema.shape.keyAlg,
});

/**
 * The group a device belongs to for config delivery: its own group_id wins,
 * else it inherits the group of its license (the customer/tier group). Null when
 * neither is set.
 */
async function resolveDeviceGroupId(deviceId, licenseId) {
  if (deviceId) {
    const device = await db
      .selectFrom("devices")
      .select("group_id")
      .where("id", "=", deviceId)
      .executeTakeFirst();
    if (device?.group_id) return device.group_id;
  }
  if (licenseId) {
    const license = await db
      .selectFrom("licenses")
      .select("group_id")
      .where("id", "=", licenseId)
      .executeTakeFirst();
    if (license?.group_id) return license.group_id;
  }
  return null;
}

async function resolveActiveOrganizationIds(userId) {
  if (!userId) return [];
  const memberships = await db
    .selectFrom("organization_members")
    .innerJoin("organizations", "organizations.id", "organization_members.organization_id")
    .select("organization_members.organization_id")
    .where("organization_members.user_id", "=", userId)
    .where("organization_members.status", "=", "active")
    .where("organizations.status", "=", "active")
    .execute();
  return memberships.map((row) => row.organization_id);
}

async function resolveEffectiveConfig(input, options = {}) {
  // Prefer the device's own valid binding; if it has none (typically a reinstall
  // / data reset regenerated the client-stored deviceId), try to recover and
  // adopt the license from another device with the same hardware fingerprint,
  // so a paid, non-expired license is not locked out by a changed deviceId.
  const licenseId = (await validLicenseScope(input)) || (await recoverLicenseScopeByFingerprint(input));
  const groupId = await resolveDeviceGroupId(input.deviceId, licenseId);
  const profiles = await db.selectFrom("config_profiles").selectAll().where("enabled", "=", true).execute();

  // Selection, order and merge are the shared seam: the admin preview runs this
  // exact code, so a preview cannot disagree with what a device receives.
  const target = {
    deviceId: input.deviceId || "",
    licenseId: licenseId || "",
    groupId: groupId || "",
    userId: options.accountContext?.userId || "",
    organizationIds: options.accountContext?.organizationIds || [],
  };
  const { applied, skipped } = selectProfilesForTarget(profiles, target, { rolloutAllows });
  const trace = options.trace || createDeliveryTrace();
  trace.skipped(skipped);
  const baseline = options.baselineEffectiveConfig || DEFAULT_EFFECTIVE_CONFIG;
  const effectiveConfig = trace.merge(applied, baseline);
  const latest = applied
    .map((profile) => new Date(profile.updated_at).getTime())
    .filter((value) => Number.isFinite(value))
    .sort((a, b) => b - a)[0];

  return {
    effectiveConfig,
    configVersion: latest ? new Date(latest).toISOString() : "packaged",
    appliedProfileIds: applied.map((profile) => profile.id),
    // Server-validated license scope (may be "" when the device has no valid
    // binding). Gateway tokens must be signed with THIS, not the raw
    // client-reported input.licenseId — see withGatewayRuntimeConfig.
    licenseScope: licenseId,
    trace,
  };
}

export function registerPublicClientConfigRoutes(app) {
  app.get("/api/client/bootstrap", {
    schema: {
      tags: ["public:client-config"],
      summary: "Resolve the runtime region and gateway policy for a client",
      response: {
        200: okResponse({
          schemaVersion: { type: "number" },
          configVersion: { type: "string" },
          region: { type: "string" },
          gatewayBaseUrl: { type: "string" },
          apiBaseUrl: { type: "string" },
          modelGatewayBaseUrl: { type: "string" },
          features: { type: "object", additionalProperties: true },
          routing: { type: "object", additionalProperties: true },
          ttlSeconds: { type: "number" },
          expiresAt: { type: "string" },
        }),
      },
    },
  }, async (request, reply) => reply.send(buildClientBootstrapPolicy(request)));

  app.post("/api/client/config", {
    schema: {
      tags: ["public:client-config"],
      summary: "Resolve a device's effective client configuration",
      description:
        "Upserts the device, verifies the signed request, and returns the signed effective config and trial status.",
      body: zodBody(clientConfigSchema),
      response: {
        200: okResponse({
          schemaVersion: { type: "number" },
          configVersion: { type: "string" },
          expiresAt: { type: "string" },
          effectiveConfig: { type: "object", additionalProperties: true },
          deviceId: { type: "string" },
          trial: { type: "object", additionalProperties: true },
          appliedProfileIds: { type: "array", items: { type: "string" } },
          configProvenance: { type: "object", additionalProperties: true },
          configDecisions: { type: "array", items: { type: "object", additionalProperties: true } },
          signature: { type: "string" },
        }),
      },
    },
  }, async (request, reply) => {
    const input = clientConfigSchema.parse(request.body);
    const device = await upsertDevice(input);
    if (!(await requireSignedDeviceRequest(request, reply, input))) return;

    const { getMediaDeliveryMode, getModelDeliveryMode } = await import("../../services/app-settings.js");
    const modelDeliveryMode = await getModelDeliveryMode();
    const baselineEffectiveConfig =
      buildEnvManagedClientConfig(config, undefined, modelDeliveryMode) || DEFAULT_EFFECTIVE_CONFIG;
    const account = await resolveAccountContextForClientConfig(input, db);
    const organizationIds = await resolveActiveOrganizationIds(account?.userId);
    const organizationEligible = config.collaborationRolloutOrganizations.length === 0
      || config.collaborationRolloutOrganizations.some((id) => organizationIds.includes(id));
    const resolved = await resolveEffectiveConfig(input, {
      baselineEffectiveConfig,
      accountContext: { userId: account?.userId || "", organizationIds },
    });
    // Per-scope agent selection (`config.agents = {available, default}`), resolved
    // against the packages published for this caller (global ∪ active orgs).
    // Additive + fail-open: a profile without `agents` costs no query and the
    // config is untouched; a DB error leaves the config exactly as resolved.
    if (resolved.effectiveConfig?.agents) {
      try {
        const availableAgentIds = await listAvailableAgentIds(db, { organizationIds });
        resolved.effectiveConfig = resolved.trace.stage("agentSelection", resolved.effectiveConfig, (cfg) => resolveAgentSelection(cfg, availableAgentIds));
      } catch (error) {
        request.log.warn({ error }, "agent selection resolution skipped");
      }
    }
    const collaborationGatedConfig = resolved.trace.stage("collaborationGate", resolved.effectiveConfig, (cfg) => applyCollaborationPolicyGate(cfg, {
      collaborationEnabled: config.collaborationEnabled,
      killSwitch: config.collaborationKillSwitch,
      organizationEligible,
      realtime: config.collaborationRealtimeEnabled,
      attachments: config.collaborationAttachmentsEnabled,
      workspaceShares: config.collaborationWorkspaceSharesEnabled,
      tasks: config.collaborationTasksEnabled,
      taskGit: config.collaborationTaskGitEnabled,
      sharedPublication: config.collaborationSharedPublicationEnabled,
      aiTools: config.collaborationAiToolsEnabled,
    }));
    // Expand any per-scope `models.providers` directive into its preset menu
    // before tokens are injected.
    const scopedConfig = resolved.trace.stage("modelMenu", collaborationGatedConfig, (cfg) => expandModelProviderMenu(cfg, {
      deliveryMode: modelDeliveryMode,
    }));
    const bootstrapPolicy = buildClientBootstrapPolicy(request);
    const mediaDeliveryMode = await getMediaDeliveryMode();
    const scopedPreview = withGatewayRuntimeConfig(scopedConfig, request, input, {
      publicBaseUrl: config.publicBaseUrl,
      policyBaseUrl: bootstrapPolicy.apiBaseUrl,
      mediaDeliveryMode,
      modelDeliveryMode,
      account,
      licenseScope: resolved.licenseScope,
      trialEndsAt: device?.trial_ends_at || "",
    });
    const selectedMedia = {
      image: scopedPreview.media?.image?.default || "",
      video: scopedPreview.media?.video?.default || "",
      speech: scopedPreview.media?.speech?.default || "",
    };
    const availableMedia = {
      image: scopedPreview.media?.image?.providers || [],
      video: scopedPreview.media?.video?.providers || [],
      speech: scopedPreview.media?.speech?.providers || [],
    };
    const mediaContracts = await discoverLilyMediaProviderContracts({
      serverConfig: config,
      selected: selectedMedia,
      available: availableMedia,
    });
    const effectiveConfig = withGatewayRuntimeConfig(scopedConfig, request, input, {
      publicBaseUrl: config.publicBaseUrl,
      policyBaseUrl: bootstrapPolicy.apiBaseUrl,
      mediaDeliveryMode,
      modelDeliveryMode,
      account,
      mediaContracts,
      licenseScope: resolved.licenseScope,
      trialEndsAt: device?.trial_ends_at || "",
    });
    const payload = {
      schemaVersion: 1,
      configVersion: resolved.configVersion,
      expiresAt: new Date(Date.now() + clientConfigTtlMs(config)).toISOString(),
      effectiveConfig,
    };

    // The receipt travels with the config: which rule established each field,
    // and which stage removed or rewrote one. It is outside the signed payload
    // on purpose — it explains delivery, it is not part of it, and a client that
    // ignores it behaves exactly as before.
    const receipt = resolved.trace.receipt();
    return reply.send({
      ok: true,
      ...payload,
      deviceId: input.deviceId,
      trial: trialPayload(device),
      appliedProfileIds: resolved.appliedProfileIds,
      configProvenance: receipt.provenance,
      configDecisions: receipt.decisions,
      signature: signConfigPayload(payload),
    });
  });
}
