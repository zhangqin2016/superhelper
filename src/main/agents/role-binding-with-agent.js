"use strict";

/**
 * A role change made while an agent is bound.
 *
 * The agent owns the role dimension; letting the user swap the role underneath
 * left the chip saying "agent X" while the conversation ran another role. The
 * user's explicit role choice wins: the agent is deactivated first (its
 * pre-activation snapshot restores skills/mode/model), the caller then applies
 * the chosen role against the CURRENT binding version, and the conversation
 * gets a durable "role selected, agent deactivated" record. Fail-open: any
 * failure leaves the agent bound and lets the role change proceed as before.
 */

/**
 * The caller applies the role binding AFTER this resolves, and that write can
 * still fail. `restore` hands back a best-effort undo so the user is never left
 * with neither the agent nor the new role.
 */
async function releaseAgentForRoleChange(ctx, sessionId, { roleName = "", locale = "zh-CN" } = {}) {
  try {
    const { resolveSessionAgentPolicy } = require("./session-agent-policy");
    const policy = resolveSessionAgentPolicy(ctx, sessionId);
    if (!policy.active) return null;
    const agent = { id: policy.agentId, name: policy.displayName || policy.definition?.name || "", icon: policy.definition?.icon || "" };
    const { deactivateAgent } = require("./agent-activation");
    const result = await deactivateAgent({ ctx, sessionId, expectedBindingVersion: policy.bindingVersion });
    require("./session-runtime-refresh").refreshSessionRuntime(ctx, sessionId);
    require("./agent-binding-notice").commitAgentBindingNotice(ctx, sessionId, {
      kind: "replaced_by_role", agent, definition: policy.definition, roleName, locale,
      bindingVersion: result?.binding?.bindingVersion ?? policy.bindingVersion + 1,
    });
    return {
      agentId: agent.id,
      name: agent.name,
      bindingVersion: result?.binding?.bindingVersion ?? null,
      revisionId: policy.agentRevisionId,
    };
  } catch {
    return null;
  }
}

module.exports = { releaseAgentForRoleChange };
