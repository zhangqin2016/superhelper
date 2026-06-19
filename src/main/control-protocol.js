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

const READ_ONLY_TOOLS = new Set(["Read", "Glob", "Grep"]);

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
    suggestions: Array.isArray(req.suggestions)
      ? req.suggestions
      : Array.isArray(req.permission_suggestions)
        ? req.permission_suggestions
        : Array.isArray(req.permissionSuggestions)
          ? req.permissionSuggestions
          : [],
  };
}

/**
 * Claude CLI owns the permission-mode classifier. If it sends can_use_tool to
 * the host, the request needs a host decision; do not re-classify by tool name.
 * @param {string} toolName
 * @param {string} permissionMode
 */
function needsUserApproval(_toolName, permissionMode) {
  if (permissionMode === "bypassPermissions") return false;
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
 * "批准并记住" must survive runner restarts: rules go to localSettings (the
 * app-managed config dir), not the in-process session scope.
 * Shape follows the CLI PermissionUpdate schema (addRules).
 * @param {string} toolName
 */
function buildRememberAllowPermissions(toolName) {
  return [{
    type: "addRules",
    rules: [{ toolName }],
    behavior: "allow",
    destination: "localSettings",
  }];
}

/**
 * CLI-suggested permission updates default to session scope; promote them to
 * localSettings so "remember" actually persists. Explicit settings
 * destinations are respected.
 * @param {unknown[]} suggestions
 */
function withPersistentDestination(suggestions) {
  return suggestions.map((suggestion) => {
    if (!suggestion || typeof suggestion !== "object") return suggestion;
    const destination =
      suggestion.destination && suggestion.destination !== "session"
        ? suggestion.destination
        : "localSettings";
    return { ...suggestion, destination };
  });
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

/**
 * Enable/disable an MCP server at runtime (CLI `mcp_toggle` control). Lets the
 * host scope the active tool set per context — activate only the relevant
 * learned system's server so the model isn't shown 10 systems' tools at once.
 * @param {string} serverName
 * @param {boolean} enabled
 */
function buildMcpToggleRequest(serverName, enabled) {
  return buildOutboundControlRequest(newRequestId("mcp"), {
    subtype: "mcp_toggle",
    serverName: String(serverName || ""),
    enabled: Boolean(enabled),
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

/**
 * Generic ack for informational hooks.
 * @param {string} requestId
 */
function buildHookContinueResponse(requestId) {
  return buildControlAck(requestId, {
    hookSpecificOutput: { continue: true },
  });
}

/**
 * PreToolUse hook response with user decision.
 * @param {string} requestId
 * @param {{ allow: boolean, updatedInput?: Record<string, unknown> }} decision
 */
function buildHookPreToolUseResponse(requestId, decision) {
  const output = { continue: true };
  if (decision.allow) {
    output.permissionDecision = "allow";
    if (decision.updatedInput) output.updatedInput = decision.updatedInput;
  } else {
    output.permissionDecision = "deny";
  }
  return buildControlAck(requestId, { hookSpecificOutput: output });
}

/**
 * Stop / SubagentStop hook response with user decision.
 * @param {string} requestId
 * @param {{ allow: boolean, reason?: string }} decision
 */
function buildHookStopResponse(requestId, decision) {
  const output = { continue: true };
  if (!decision.allow) {
    output.decision = "block";
    output.reason = decision.reason || "User blocked stop";
  }
  return buildControlAck(requestId, { hookSpecificOutput: output });
}

/**
 * Response to a CLI `request_user_dialog` control request.
 *
 * The SDK schema is `{ behavior: "completed" | "cancelled", result? }`. `result`
 * is opaque and defined per `dialog_kind`; the CLI's internal caller expects an
 * exact per-kind shape, so we only attach it when a caller has actually modeled
 * the kind. For any kind we cannot render faithfully the protocol mandates
 * `{ behavior: "cancelled" }` — fail closed rather than feed the caller a guessed
 * `result`, which is worse than the documented no-dialog degradation.
 * @param {string} requestId
 * @param {{ behavior?: "completed" | "cancelled", result?: unknown }} [decision]
 */
function buildUserDialogResponse(requestId, decision = {}) {
  const completed = decision.behavior === "completed";
  const body = { behavior: completed ? "completed" : "cancelled" };
  if (completed && decision.result !== undefined) body.result = decision.result;
  return buildControlAck(requestId, body);
}

/**
 * Response to a CLI MCP `elicitation` control request.
 *
 * The SDK schema is `{ action: "accept" | "decline" | "cancel", content? }`.
 * `content` is a free record whose keys are the elicitation's requested fields;
 * we pass the user's answers through best-effort and only attach it on "accept".
 * @param {string} requestId
 * @param {{ action?: "accept" | "decline" | "cancel", content?: Record<string, unknown> }} [decision]
 */
function buildElicitationResponse(requestId, decision = {}) {
  const action =
    decision.action === "accept" || decision.action === "decline"
      ? decision.action
      : "cancel";
  const body = { action };
  if (action === "accept" && decision.content && typeof decision.content === "object") {
    body.content = decision.content;
  }
  return buildControlAck(requestId, body);
}

module.exports = {
  EDIT_TOOLS,
  READ_ONLY_TOOLS,
  newRequestId,
  parseCanUseToolRequest,
  needsUserApproval,
  buildControlResponse,
  buildRememberAllowPermissions,
  withPersistentDestination,
  buildControlCancelRequest,
  buildUpdateEnvironmentVariablesRequest,
  buildControlAck,
  buildOutboundControlRequest,
  buildInterruptRequest,
  buildSetPermissionModeRequest,
  buildMcpToggleRequest,
  buildInitializeRequest,
  buildHookCallbackResponse,
  buildHookContinueResponse,
  buildHookPreToolUseResponse,
  buildHookStopResponse,
  buildUserDialogResponse,
  buildElicitationResponse,
};
