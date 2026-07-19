"use strict";

const { buildExternalFactPolicy } = require("./external-fact-policy");

function uniqueStrings(...lists) {
  const output = [];
  const seen = new Set();
  for (const list of lists) {
    for (const item of Array.isArray(list) ? list : []) {
      const value = String(item || "").trim();
      if (!value || seen.has(value)) continue;
      seen.add(value);
      output.push(value);
    }
  }
  return output;
}

function evidenceSourcesForTaskType(taskType) {
  const common = ["user_request", "tool_output"];
  switch (taskType) {
    case "architecture_audit":
      return uniqueStrings(common, [
        "workspace_tree_or_manifest",
        "code_file_reference",
        "runtime_event_or_log",
        "test_or_command_output",
        "document_evidence",
      ]);
    case "bug_investigation":
    case "runtime_protocol":
    case "code_change":
    case "agent_quality":
      return uniqueStrings(common, [
        "code_file_reference",
        "test_or_command_output",
        "runtime_event_or_log",
        "official_history_or_fixture",
      ]);
    case "release_deploy":
      return uniqueStrings(common, [
        "artifact_or_version_manifest",
        "upload_or_deploy_command_output",
        "live_service_check",
      ]);
    case "server_change":
      return uniqueStrings(common, [
        "route_or_service_code_reference",
        "database_or_migration_record",
        "api_response_or_server_log",
        "server_test_output",
      ]);
    case "ui_change":
      return uniqueStrings(common, [
        "renderer_code_reference",
        "screenshot_or_dom_observation",
        "renderer_test_or_manual_check",
      ]);
    case "configuration_change":
      return uniqueStrings(common, [
        "config_file_or_database_record",
        "effective_runtime_config",
        "secret_boundary_check",
      ]);
    case "content_extraction":
      return uniqueStrings(common, [
        "source_attachment",
        "native_vision_input",
        "vision_observation",
        "document_evidence",
        "extracted_text_or_table",
        "source_coverage_record",
      ]);
    case "document_work":
      return uniqueStrings(common, [
        "document_evidence",
        "page_or_sheet_coverage",
        "extracted_text_or_table",
        "output_file_or_open_check",
      ]);
    case "media_generation":
      return uniqueStrings(common, [
        "source_media_or_prompt",
        "generated_or_modified_file",
        "preview_or_openable_path",
        "provider_or_tool_output",
      ]);
    case "external_fact":
      return uniqueStrings(common, [
        "web_search_or_fetch_result",
        "live_api_response",
        "authoritative_external_document",
        "source_link_and_date",
        "ranking_or_comparison_criteria",
      ]);
    default:
      return common;
  }
}

function requiredEvidenceKindsForTaskType(taskType) {
  switch (taskType) {
    case "architecture_audit":
    case "agent_quality":
      return ["file_search", "file_read"];
    case "content_extraction":
      return ["source_content"];
    case "document_work":
      return ["document"];
    case "release_deploy":
      return ["verification"];
    case "external_fact":
      return ["external"];
    default:
      return [];
  }
}

function buildEvidencePolicy(classification = {}) {
  const taskType = classification.taskType || "general";
  const active = Boolean(classification.active);
  const externalFact = buildExternalFactPolicy(classification.externalFactIntent);
  const requiredEvidenceKinds = active ? requiredEvidenceKindsForTaskType(taskType) : [];
  if (externalFact.required && !requiredEvidenceKinds.includes("external")) requiredEvidenceKinds.push("external");
  const allowedSources = evidenceSourcesForTaskType(taskType);
  if (externalFact.required) {
    allowedSources.push("web_search_or_fetch_result", "live_api_response", "authoritative_external_document", "user_supplied_source");
  }
  const sourceContentRequirements = taskType === "content_extraction" ? [
    "Answer from the attached source content, not from its filename or surrounding metadata.",
    "State which attachments were read and disclose partial, unreadable, cropped, or uncertain content.",
    "Do not invent text, objects, pages, tables, or details that were not observed in the source.",
  ] : [];
  return {
    required: active,
    allowedSources: uniqueStrings(allowedSources),
    requiredEvidenceKinds: uniqueStrings(requiredEvidenceKinds),
    externalFact: externalFact.required,
    requireSourceLinks: externalFact.requiresSourceLinks,
    allowClarificationWithoutEvidence: externalFact.required,
    unsupportedClaimPolicy: active
      ? "Unsupported factual claims must be downgraded to uncertainty. Do not state causes, completion, deployment, correctness, data values, or external facts as confirmed without an allowed evidence source. Flag only the claims that actually lack support, inline where they occur — do NOT append a blanket evidence disclaimer to an answer that is already grounded in the evidence you have."
      : "Use evidence when making factual claims; if evidence is unavailable, say what is unknown instead of inventing details.",
    finalAnswerRequirements: active
      ? uniqueStrings([
          "For each important conclusion, cite the evidence type used.",
          "If evidence is missing, explicitly say it is unverified or unknown.",
          "Do not claim fixed/completed/deployed/verified unless tool output or a concrete record supports it.",
        ], sourceContentRequirements, externalFact.finalAnswerRequirements)
      : [],
  };
}

module.exports = {
  buildEvidencePolicy,
  evidenceSourcesForTaskType,
  requiredEvidenceKindsForTaskType,
};
