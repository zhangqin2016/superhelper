"use strict";

const { z } = require("zod");

function buildIntentContractToolDefinition({ executionSurface, mcpServerName } = {}) {
  return {
    id: "lily_intent_contract_commit",
    name: "lily_intent_contract_commit",
    group: "task-contracts",
    requiredSkillIds: [],
    executionSurface,
    mcpServerName,
    description: "Commit one semantic refinement of the current turn's host-owned intent contract. Before answering an external factual request whose evidence gate is not already active, declare verificationPlan.externalFact=true. After finding primary sources, include authorityHosts and evidenceAnchorGroups when named conclusions require item-level support. The main process validates the candidate and preserves every baseline constraint.",
    inputSchema: {
      objective: z.string().min(1).max(1000).describe("the user's intended outcome, not a restatement of internal process"),
      deliverables: z.array(z.string().min(1).max(500)).max(12).optional(),
      successCriteria: z.array(z.string().min(1).max(500)).max(20).optional(),
      assumptions: z.array(z.string().min(1).max(500)).max(12).optional(),
      criticalUnknowns: z.array(z.string().min(1).max(500)).max(10).optional().describe("unknowns that make useful progress impossible or an action materially unsafe; omit defaultable ambiguity in reversible research or analysis"),
      neededCapabilities: z.array(z.string().min(1).max(500)).max(16).optional(),
      constraints: z.array(z.string().min(1).max(500)).max(20).optional(),
      riskLevel: z.enum(["low", "medium", "high"]).optional(),
      verificationPlan: z.object({
        externalFact: z.boolean().optional().describe("true only when the answer depends on facts outside the conversation, supplied sources, and local workspace"),
        claimKinds: z.array(z.string().regex(/^[a-z][a-z0-9_:-]{0,63}$/i)).max(8).optional(),
        requiredScopeDimensions: z.array(z.string().min(1).max(80)).max(8).optional(),
        resolvedScopeDimensions: z.array(z.string().min(1).max(80)).max(8).optional(),
        sourceAuthority: z.enum(["standard", "named_publisher", "primary_or_official", "official_primary"]).optional(),
        authorityHosts: z.array(z.string().min(1).max(300)).max(12).optional().describe("hostnames observed on the primary or official sources that may support the final answer"),
        entityEvidenceRequired: z.boolean().optional(),
        claimEvidenceRequired: z.boolean().optional(),
        classificationEvidenceRequired: z.boolean().optional(),
        evidenceAnchorGroups: z.array(
          z.array(z.string().min(1).max(120)).min(1).max(8),
        ).max(12).optional().describe("semantic evidence requirements; every group is required, while strings inside one group are equivalent source-wording alternatives"),
        forbiddenInferenceIds: z.array(z.enum(["ordered_directory_implies_classification"])).max(8).optional(),
        conflictRuleIds: z.array(z.enum(["negative_or_revoked_classification", "subordinate_vs_independent_tier"])).max(8).optional(),
      }).optional().describe("additive evidence plan for an external claim; omitted fields never weaken the host baseline"),
    },
    annotations: { readOnlyHint: true },
    handler: async (args) => ({
      ok: true,
      intentContract: {
        taskType: "general",
        objective: args.objective,
        deliverables: args.deliverables || [],
        successCriteria: args.successCriteria || [],
        assumptions: args.assumptions || [],
        criticalUnknowns: args.criticalUnknowns || [],
        neededCapabilities: args.neededCapabilities || [],
        constraints: args.constraints || [],
        riskLevel: args.riskLevel || "low",
        provenance: { mode: "model_candidate" },
      },
      verificationPlan: args.verificationPlan || null,
    }),
  };
}

module.exports = { buildIntentContractToolDefinition };
