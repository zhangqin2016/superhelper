"use strict";

const BYPASS_REASONS = new Set([
  "policy_disabled",
  "snapshot_not_ready",
  "revision_missing",
  "identity_missing",
  "budget_zero",
  "provider_unsupported",
  "activation_invalid",
  "prompt_budget_exhausted",
  "request_build_failed",
]);

const EXPRESSION_PROFILES = new Set(["immersive", "balanced", "task_preserving"]);

function characterApplicationForTrace(application, trace) {
  const receipt = application && typeof application === "object" ? application : { status: "native" };
  if (receipt.status !== "native" || trace?.status !== "native" || !trace?.revisionId) return receipt;
  const rawReason = String(trace.policyReason || "activation_invalid");
  let reason = "activation_invalid";
  if (["remote_disabled", "kill_switch"].includes(rawReason)) reason = "policy_disabled";
  else if (["identity_over_budget", "envelope_over_budget"].includes(rawReason)) reason = "prompt_budget_exhausted";
  else if (BYPASS_REASONS.has(rawReason)) reason = rawReason;
  return {
    status: "bypassed",
    reason,
    revisionId: String(trace.revisionId),
    ...(EXPRESSION_PROFILES.has(trace.expressionProfile)
      ? { expressionProfile: trace.expressionProfile }
      : {}),
  };
}

module.exports = { characterApplicationForTrace };
