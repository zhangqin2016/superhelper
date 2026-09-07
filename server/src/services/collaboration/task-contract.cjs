"use strict";

// Canonical server contract. Callers must resolve current authorization in a server
// transaction before invoking it; payload roles are never authority.
function fail(code) { throw Object.assign(new Error(code), { code }); }
function identifier(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,200}$/.test(value)) fail("COLLAB_TASK_INVALID");
  return value;
}
function bounded(value, limit, required = false) {
  if (typeof value !== "string" || value.length > limit || (required && !value.trim()) || value.includes("\0")) fail("COLLAB_TASK_INVALID");
  return value.trim();
}
function revision(value) {
  if (!Number.isSafeInteger(value) || value < 1 || value >= Number.MAX_SAFE_INTEGER) fail("COLLAB_TASK_INVALID");
  return value;
}
function exact(value, allowed) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some((k) => !allowed.includes(k))) fail("COLLAB_TASK_INVALID");
}
function createTask(input, { actorUserId, authorizedParticipantIds, now } = {}) {
  exact(input, ["id", "conversationId", "assigneeUserId", "inputSnapshotId", "title", "objective", "acceptanceCriteria"]);
  const requesterUserId = identifier(actorUserId), assigneeUserId = identifier(input.assigneeUserId);
  if (requesterUserId === assigneeUserId) fail("COLLAB_TASK_SELF_ASSIGNMENT");
  if (!Array.isArray(authorizedParticipantIds) || ![requesterUserId, assigneeUserId].every((id) => authorizedParticipantIds.includes(id))) fail("COLLAB_TASK_ACCESS_DENIED");
  if (!Number.isSafeInteger(now) || now < 0) fail("COLLAB_TASK_INVALID");
  return { id: identifier(input.id), conversationId: identifier(input.conversationId), requesterUserId, assigneeUserId,
    inputSnapshotId: identifier(input.inputSnapshotId), title: bounded(input.title, 200, true),
    objective: bounded(input.objective, 12000, true), acceptanceCriteria: bounded(input.acceptanceCriteria, 12000, true),
    state: "offered", revision: 1, currentDeliveryId: null, acceptedDeliveryId: null,
    deliveries: [], createdAt: now, updatedAt: now };
}
const ACTIONS = {
  accept: { role: "assigneeUserId", from: ["offered"], to: "active" },
  decline: { role: "assigneeUserId", from: ["offered"], to: "declined" },
  submit: { role: "assigneeUserId", from: ["active", "changes_requested"], to: "review" },
  request_changes: { role: "requesterUserId", from: ["review"], to: "changes_requested" },
  approve: { role: "requesterUserId", from: ["review"], to: "accepted" },
  cancel: { role: "requesterUserId", from: ["offered", "active", "review", "changes_requested"], to: "cancelled" },
};
function transitionTask(task, command, { actorUserId, authorizedParticipantIds, now, verifiedDelivery } = {}) {
  exact(command, ["action", "expectedRevision", "deliveryId", "reason"]);
  const rule = Object.hasOwn(ACTIONS, command.action) ? ACTIONS[command.action] : null;
  if (!rule) fail("COLLAB_TASK_INVALID");
  if (!Array.isArray(authorizedParticipantIds) || ![task.requesterUserId, task.assigneeUserId].every((id) => authorizedParticipantIds.includes(id)) || actorUserId !== task[rule.role]) fail("COLLAB_TASK_ACCESS_DENIED");
  if (revision(command.expectedRevision) !== revision(task.revision)) fail("COLLAB_TASK_REVISION_CONFLICT");
  if (!rule.from.includes(task.state)) fail("COLLAB_TASK_STATE_CONFLICT");
  if (!Number.isSafeInteger(now) || now < task.updatedAt) fail("COLLAB_TASK_INVALID");
  const next = { ...task, deliveries: task.deliveries.map((d) => ({ ...d })), state: rule.to, revision: task.revision + 1, updatedAt: now };
  const reason = command.reason == null ? "" : bounded(command.reason, 4000, command.action === "request_changes");
  if (command.action === "request_changes" && !reason) fail("COLLAB_TASK_REASON_REQUIRED");
  if (["approve", "request_changes"].includes(command.action)) {
    if (identifier(command.deliveryId) !== task.currentDeliveryId) fail("COLLAB_TASK_DELIVERY_CONFLICT");
  } else if (command.action !== "submit" && command.deliveryId != null) fail("COLLAB_TASK_INVALID");
  if (command.action === "submit") {
    // verifiedDelivery is supplied by the server object broker, never spread
    // from the request: all objects have passed task ACL + completion checks.
    const id = identifier(command.deliveryId);
    if (!verifiedDelivery || verifiedDelivery.id !== id || verifiedDelivery.taskId !== task.id
      || verifiedDelivery.inputSnapshotId !== task.inputSnapshotId || verifiedDelivery.actorUserId !== actorUserId
      || verifiedDelivery.complete !== true || !/^[a-f0-9]{64}$/.test(verifiedDelivery.manifestHash || "")) fail("COLLAB_TASK_DELIVERY_UNVERIFIED");
    if (task.deliveries.some((d) => d.id === id)) fail("COLLAB_TASK_DELIVERY_CONFLICT");
    next.deliveries.push({ id, inputSnapshotId: task.inputSnapshotId, manifestHash: verifiedDelivery.manifestHash, submittedAt: now, number: task.deliveries.length + 1 });
    next.currentDeliveryId = id;
  }
  if (command.action === "approve") next.acceptedDeliveryId = command.deliveryId;
  if (["request_changes", "decline", "cancel"].includes(command.action)) next.reason = reason;
  else delete next.reason;
  return next;
}
module.exports = { createTask, transitionTask };
