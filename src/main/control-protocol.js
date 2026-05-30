"use strict";

const crypto = require("node:crypto");

const EDIT_TOOLS = new Set([
  "Read",
  "Edit",
  "Write",
  "MultiEdit",
  "Glob",
  "Grep",
  "NotebookEdit",
]);

function newRequestId(prefix = "req") {
  return `${prefix}_${crypto.randomUUID()}`;
}

/**
 * @param {{ type?: string, request_id?: string, request?: Record<string, unknown> }} ev
 */
function parseCanUseToolRequest(ev) {
  if (!ev || typeof ev !== "object") return null;

  const nested =
    ev.request && typeof ev.request === "object" ? ev.request : null;
  const subtype = nested?.subtype ?? ev.subtype;
  const isCanUseTool =
    subtype === "can_use_tool" ||
    (ev.type === "sdk_control_request" && subtype === "permission");
  if (!isCanUseTool) return null;

  const req = nested || ev;

  let requestId =
    ev.request_id ||
    (typeof req.request_id === "string" ? req.request_id : "") ||
    (typeof ev.id === "string" ? ev.id : "") ||
    "";
  if (!requestId) requestId = newRequestId("perm");

  const toolName = String(req.tool_name || req.toolName || "unknown");
  const input =
    req.input && typeof req.input === "object"
      ? req.input
      : req.tool_input && typeof req.tool_input === "object"
        ? req.tool_input
        : {};

  return {
    requestId,
    toolName,
    input,
    title: typeof req.title === "string" ? req.title : "",
    description: typeof req.description === "string" ? req.description : "",
    decisionReason:
      typeof req.decision_reason === "string" ? req.decision_reason : "",
  };
}

/**
 * @param {string} toolName
 * @param {string} permissionMode
 */
function needsUserApproval(toolName, permissionMode) {
  if (permissionMode === "bypassPermissions") return false;
  if (toolName === "Read") return false;
  if (permissionMode === "acceptEdits" && EDIT_TOOLS.has(toolName)) return false;
  return true;
}

/**
 * @param {string} requestId
 * @param {{ behavior: "allow" | "deny", updatedInput?: Record<string, unknown>, message?: string }} decision
 */
function buildControlResponse(requestId, decision) {
  const response = { behavior: decision.behavior };
  if (decision.behavior === "allow") {
    response.updatedInput = decision.updatedInput || {};
    if (Array.isArray(decision.updatedPermissions) && decision.updatedPermissions.length) {
      response.updatedPermissions = decision.updatedPermissions;
    }
  } else {
    response.message = decision.message || "User denied this action";
  }

  return {
    type: "control_response",
    response: {
      subtype: "success",
      request_id: requestId,
      response,
    },
  };
}

/**
 * @param {string} toolName
 */
function buildRememberAllowPermissions(toolName) {
  return [{ type: "allow", tool_name: toolName }];
}

function buildControlCancelRequest(requestId) {
  return {
    type: "control_cancel_request",
    request_id: requestId,
  };
}

/**
 * @param {Record<string, string>} variables
 */
function buildUpdateEnvironmentVariablesRequest(variables) {
  return {
    type: "update_environment_variables",
    variables,
  };
}

/**
 * @param {string} requestId
 * @param {Record<string, unknown>} [responseBody]
 */
function buildControlAck(requestId, responseBody) {
  return {
    type: "control_response",
    response: {
      subtype: "success",
      request_id: requestId,
      ...(responseBody ? { response: responseBody } : {}),
    },
  };
}

/**
 * Host → CLI control_request (stdin).
 * @param {string} requestId
 * @param {Record<string, unknown>} request
 */
function buildOutboundControlRequest(requestId, request) {
  return {
    type: "control_request",
    request_id: requestId,
    request,
  };
}

function buildInterruptRequest() {
  return buildOutboundControlRequest(newRequestId("interrupt"), {
    subtype: "interrupt",
  });
}

/**
 * @param {string} mode
 */
function buildSetPermissionModeRequest(mode) {
  return buildOutboundControlRequest(newRequestId("perm"), {
    subtype: "set_permission_mode",
    mode,
  });
}

function buildInitializeRequest() {
  return buildOutboundControlRequest(newRequestId("init"), {
    subtype: "initialize",
    promptSuggestions: true,
  });
}

/**
 * @param {string} requestId
 * @param {Record<string, unknown>} hookPayload
 */
function buildHookCallbackResponse(requestId, hookPayload = {}) {
  return buildControlAck(requestId, {
    hookSpecificOutput: hookPayload,
  });
}

module.exports = {
  EDIT_TOOLS,
  newRequestId,
  parseCanUseToolRequest,
  needsUserApproval,
  buildControlResponse,
  buildRememberAllowPermissions,
  buildControlCancelRequest,
  buildUpdateEnvironmentVariablesRequest,
  buildControlAck,
  buildOutboundControlRequest,
  buildInterruptRequest,
  buildSetPermissionModeRequest,
  buildInitializeRequest,
  buildHookCallbackResponse,
};
