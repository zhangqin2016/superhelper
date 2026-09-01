"use strict";

const { messageIdentifier } = require("./message-intent");
const STATES = new Set(["queued", "submitting", "confirming", "paused", "failed", "delivery_unknown", "cancellation_requested", "cancelled", "persisted"]);
const TYPES = new Set(["message.create", "message.edit", "message.revoke"]);
const ERROR_CODES = new Set([
  "COLLAB_OPERATION_FAILED", "MESSAGE_REVISION_CONFLICT", "COLLAB_MESSAGE_EDIT_WINDOW_EXPIRED", "COLLAB_MESSAGE_REVOKE_WINDOW_EXPIRED",
  "COLLAB_MESSAGE_EDIT_FORBIDDEN", "COLLAB_MESSAGE_REVOKE_FORBIDDEN", "COLLAB_AUTHORIZATION_DENIED", "COLLAB_MEMBERSHIP_INACTIVE",
  "COLLAB_ACCESS_REVOKED", "COLLAB_SERVICE_UNAUTHORIZED", "ACCOUNT_LOGIN_REQUIRED", "COLLAB_ACCOUNT_CHANGED",
  "COLLAB_NETWORK_UNAVAILABLE", "COLLAB_TRANSACTION_RETRY", "COLLAB_RATE_LIMITED", "COLLAB_RESPONSE_UNKNOWN",
  "COLLAB_SERVICE_REQUEST_FAILED", "COLLAB_OUTBOX_DEVICE_CHANGED", "COLLAB_OUTBOX_DEVICE_REQUIRED", "IDEMPOTENCY_KEY_REUSED",
  "COLLAB_MESSAGE_BODY_REQUIRED", "COLLAB_MESSAGE_BODY_TOO_LARGE", "COLLAB_MENTION_MEMBER_INACTIVE", "COLLAB_ATTACHMENT_NOT_READY",
]);
function safeOperationErrorCode(value) { return value == null ? null : ERROR_CODES.has(value) ? value : "COLLAB_OPERATION_FAILED"; }
function invalidOperationView() { return Object.assign(new Error("Invalid collaboration message operations"), { code: "COLLAB_MESSAGE_OPERATIONS_INVALID" }); }
function validOperationRequest(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(k => !["conversationId", "outboxIds"].includes(k))) return null;
  if (!messageIdentifier(value.conversationId) || !Array.isArray(value.outboxIds) || value.outboxIds.length > 200
    || Array.from(value.outboxIds).some(id => !messageIdentifier(id)) || new Set(value.outboxIds).size !== value.outboxIds.length) return null;
  return { conversationId: value.conversationId, outboxIds: [...value.outboxIds] };
}
// Shared strict whitelist: never coerce a malformed record into a successful
// recovery decision and never forward arbitrary persisted/transport fields.
function operationView(value) {
  if (!value || !["id", "conversationId", "clientCommandId", "scopeId", "messageId"].every(k => messageIdentifier(value[k]))
    || !TYPES.has(value.commandType) || !STATES.has(value.state)
    || !Number.isSafeInteger(value.attempts) || value.attempts < 0
    || !["deliveryConfirmed", "deliveryUncertain", "originalDeviceRequired"].every(k => typeof value[k] === "boolean")
    || value.blockedBy !== null && (!messageIdentifier(value.blockedBy) || value.blockedBy === value.id)
    || value.errorCode !== null && !ERROR_CODES.has(value.errorCode)) throw invalidOperationView();
  const mutation = value.commandType !== "message.create";
  if (mutation && (!Number.isSafeInteger(value.expectedRevision) || value.expectedRevision < 1)) throw invalidOperationView();
  if (value.commandType === "message.edit" && (typeof value.bodyText !== "string" || Buffer.byteLength(value.bodyText, "utf8") > 64 * 1024)) throw invalidOperationView();
  return { id: value.id, conversationId: value.conversationId, clientCommandId: value.clientCommandId,
    scopeId: value.scopeId, commandType: value.commandType, messageId: value.messageId,
    ...(mutation ? { expectedRevision: value.expectedRevision } : {}), state: value.state, attempts: value.attempts,
    deliveryConfirmed: value.deliveryConfirmed, deliveryUncertain: value.deliveryUncertain, blockedBy: value.blockedBy,
    originalDeviceRequired: value.originalDeviceRequired, errorCode: value.errorCode,
    ...(value.commandType === "message.edit" ? { bodyText: value.bodyText } : {}) };
}
function operationResult(value, request) {
  if (!validOperationRequest(request) || value?.ok !== true || value.conversationId !== request.conversationId
    || !Array.isArray(value.operations) || !Array.isArray(value.unavailableOutboxIds)
    || value.operations.length + value.unavailableOutboxIds.length !== request.outboxIds.length) throw invalidOperationView();
  const requested = new Set(request.outboxIds), seen = new Set();
  const operations = Array.from(value.operations, row => {
    const safe = operationView(row);
    if (safe.conversationId !== request.conversationId || !requested.has(safe.id) || seen.has(safe.id)) throw invalidOperationView();
    seen.add(safe.id); return safe;
  });
  for (const id of value.unavailableOutboxIds) {
    if (!messageIdentifier(id) || !requested.has(id) || seen.has(id)) throw invalidOperationView();
    seen.add(id);
  }
  return { ok: true, conversationId: request.conversationId, operations, unavailableOutboxIds: [...value.unavailableOutboxIds] };
}
module.exports = { safeOperationErrorCode, validOperationRequest, operationView, operationResult, invalidOperationView };
