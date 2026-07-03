"use strict";

const TASK_TYPE_SCHEMA_VERSION = 1;

const PLATFORM_BASELINE_RULES = Object.freeze([
  "Preserve the user's original request and never rewrite the visible user message.",
  "Use the task type only to improve execution quality; do not expose internal policy unless asked.",
  "For non-trivial work, identify the impact surface before changing files or running risky commands.",
  "Keep progress visible when the engine is thinking, reading files, running tools, or waiting on permissions.",
  "Before finishing, report what was verified; if verification was not possible, state that explicitly.",
]);

const TASK_TYPES = Object.freeze({
  general: {
    id: "general",
    label: "General",
    categories: [],
    active: false,
    verification: [],
  },
  bug_investigation: {
    id: "bug_investigation",
    label: "Bug investigation",
    categories: ["bugfix"],
    active: true,
    verification: ["reproduce_or_explain", "root_cause", "targeted_fix", "regression_test"],
  },
  runtime_protocol: {
    id: "runtime_protocol",
    label: "Runtime / protocol",
    categories: ["runtime"],
    active: true,
    verification: ["event_ordering", "turn_ownership", "queue_semantics", "permission_flow", "fixture_or_unit_test"],
  },
  agent_quality: {
    id: "agent_quality",
    label: "Agent quality",
    categories: ["agent_quality"],
    active: true,
    verification: ["routing_contract", "prompt_context", "tool_or_skill_boundary", "regression_test"],
  },
  architecture_audit: {
    id: "architecture_audit",
    label: "Architecture audit",
    categories: ["architecture_audit"],
    active: true,
    verification: ["impact_surface", "weak_point_inventory", "source_evidence", "improvement_plan", "regression_test"],
  },
  release_deploy: {
    id: "release_deploy",
    label: "Release / deploy",
    categories: ["release"],
    active: true,
    verification: ["version_bump", "artifact_manifest", "upload_target", "live_version_check"],
  },
  server_change: {
    id: "server_change",
    label: "Server change",
    categories: ["server"],
    active: true,
    verification: ["auth_boundary", "route_contract", "persistence_or_migration", "server_test"],
  },
  ui_change: {
    id: "ui_change",
    label: "UI change",
    categories: ["ui"],
    active: true,
    verification: ["visible_state", "loading_empty_error_states", "repeat_interaction", "renderer_test_or_manual_check"],
  },
  configuration_change: {
    id: "configuration_change",
    label: "Configuration change",
    categories: ["config"],
    active: true,
    verification: ["local_override", "server_managed_config", "secret_boundary", "inactive_device_update_access"],
  },
  code_change: {
    id: "code_change",
    label: "Code change",
    categories: ["code"],
    active: true,
    verification: ["entry_point", "callers", "focused_test", "no_unrelated_refactor"],
  },
  document_work: {
    id: "document_work",
    label: "Document work",
    categories: ["document"],
    active: true,
    verification: ["page_coverage", "tables_images", "output_opens"],
  },
  media_generation: {
    id: "media_generation",
    label: "Media generation",
    categories: ["media"],
    active: true,
    verification: ["progress_visible", "preview_or_openable_path", "provider_error_surface"],
  },
});

const TASK_TYPE_PRIORITY = Object.freeze([
  "release_deploy",
  "runtime_protocol",
  "architecture_audit",
  "agent_quality",
  "server_change",
  "ui_change",
  "configuration_change",
  "code_change",
  "document_work",
  "media_generation",
  "bug_investigation",
  "general",
]);

const CATEGORY_TO_TASK_TYPE = Object.freeze(
  Object.fromEntries(
    Object.values(TASK_TYPES).flatMap((type) => type.categories.map((category) => [category, type.id])),
  ),
);

function canonicalTaskTypeFromCategories(categories = []) {
  const candidates = new Set(categories.map((category) => CATEGORY_TO_TASK_TYPE[category]).filter(Boolean));
  return TASK_TYPE_PRIORITY.find((id) => candidates.has(id)) || "general";
}

function taskTypeDefinition(taskType) {
  return TASK_TYPES[taskType] || TASK_TYPES.general;
}

function modelDraftSchema() {
  return {
    schemaVersion: TASK_TYPE_SCHEMA_VERSION,
    type: "object",
    required: ["taskType", "objective", "impactSurface", "verificationPlan"],
    properties: {
      taskType: { enum: Object.keys(TASK_TYPES) },
      objective: { type: "string" },
      impactSurface: { type: "array", items: { type: "string" } },
      assumptions: { type: "array", items: { type: "string" } },
      risks: { type: "array", items: { type: "string" } },
      verificationPlan: { type: "array", items: { type: "string" } },
    },
  };
}

module.exports = {
  CATEGORY_TO_TASK_TYPE,
  PLATFORM_BASELINE_RULES,
  TASK_TYPE_SCHEMA_VERSION,
  TASK_TYPE_PRIORITY,
  TASK_TYPES,
  canonicalTaskTypeFromCategories,
  modelDraftSchema,
  taskTypeDefinition,
};
