"use strict";
const id = value => typeof value === "string" && /^[A-Za-z0-9_-]{1,200}$/.test(value);
const text = (value, max, required = false) => typeof value === "string" && value.length <= max && !value.includes("\0") && (!required || Boolean(value.trim()));
const integer = value => Number.isSafeInteger(value) && value >= 0;
const states = ["offered", "active", "review", "changes_requested", "accepted", "declined", "cancelled"];
const targets = { accept: "active", decline: "declined", submit: "review", request_changes: "changes_requested", approve: "accepted", cancel: "cancelled" };
function exact(value, keys) { return value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).every(key => keys.includes(key)); }
function taskKey(value, kind = "conversationId") { return exact(value, [kind]) && id(value[kind]) ? { [kind]: value[kind] } : null; }
function taskCommand(value) {
  if (!exact(value, ["conversationId", "taskId", "clientCommandId", "action", "expectedRevision", "deliveryId", "reason"]) || !id(value.conversationId) || !id(value.taskId)
    || !Object.hasOwn(targets, value.action) || !integer(value.expectedRevision) || value.expectedRevision < 1 || value.expectedRevision >= Number.MAX_SAFE_INTEGER
    || value.clientCommandId != null && !id(value.clientCommandId)) return null;
  const delivery = ["submit", "approve", "request_changes"].includes(value.action);
  if (delivery ? !id(value.deliveryId) : value.deliveryId != null) return null;
  if (value.action === "request_changes" ? !text(value.reason, 4000, true) : value.reason != null && (!["decline", "cancel", "accept"].includes(value.action) || !text(value.reason, 4000))) return null;
  return { conversationId: value.conversationId, taskId: value.taskId, action: value.action, expectedRevision: value.expectedRevision,
    ...(value.clientCommandId ? { clientCommandId: value.clientCommandId } : {}), ...(delivery ? { deliveryId: value.deliveryId } : {}),
    ...(value.reason != null ? { reason: value.reason.trim() } : {}) };
}
function taskView(value) {
  if (!value || !["id", "conversationId", "requesterUserId", "assigneeUserId", "inputSnapshotId"].every(key => id(value[key]))
    || !states.includes(value.state) || !integer(value.revision) || value.revision < 1 || value.revision >= Number.MAX_SAFE_INTEGER
    || !text(value.title, 200, true) || !text(value.objective, 12000, true) || !text(value.acceptanceCriteria, 12000, true)
    || !integer(value.createdAt) || !integer(value.updatedAt) || value.updatedAt < value.createdAt
    || !Array.isArray(value.deliveries) || value.deliveries.length > 1000) return null;
  const deliveries = value.deliveries.map(d => d && id(d.id) && integer(d.number) && d.number > 0 && integer(d.submittedAt)
    ? { id: d.id, number: d.number, submittedAt: d.submittedAt } : null);
  if (deliveries.some(d => !d) || new Set(deliveries.map(d => d.id)).size !== deliveries.length
    || deliveries.some((d, i) => d.number !== i + 1)) return null;
  const currentDeliveryId = value.currentDeliveryId ?? null, acceptedDeliveryId = value.acceptedDeliveryId ?? null;
  if (currentDeliveryId !== (deliveries.at(-1)?.id ?? null) || acceptedDeliveryId != null && acceptedDeliveryId !== currentDeliveryId
    || ["review", "changes_requested", "accepted"].includes(value.state) && !currentDeliveryId
    || value.state === "accepted" && acceptedDeliveryId !== currentDeliveryId
    || value.state !== "accepted" && acceptedDeliveryId != null || value.reason != null && !text(value.reason, 4000)) return null;
  return { ...Object.fromEntries(["id", "conversationId", "requesterUserId", "assigneeUserId", "inputSnapshotId", "title", "objective", "acceptanceCriteria", "state", "revision", "createdAt", "updatedAt"].map(key => [key, value[key]])),
    deliveries, currentDeliveryId, acceptedDeliveryId, ...(value.reason ? { reason: value.reason } : {}) };
}
function taskResult(method, value) {
  if (value?.ok !== true) return { ok: false, code: id(value?.code) ? value.code : "COLLAB_TASK_UNAVAILABLE" };
  if (method === "listTasks") {
    const tasks = Array.isArray(value.tasks) ? value.tasks.map(taskView) : null;
    return tasks && tasks.length <= 50 && tasks.every(Boolean) ? { ok: true, tasks } : { ok: false, code: "COLLAB_TASK_INVALID" };
  }
  if (method === "getTask") { const task = taskView(value.task); return task ? { ok: true, task } : { ok: false, code: "COLLAB_TASK_INVALID" }; }
  if (method === "getTaskCommands") return { ok: true, commands: (value.commands || []).flatMap(row => {
    const safe = taskResult("changeTask", row);
    return safe.clientCommandId && id(row.taskId) ? [{ ...safe, taskId: row.taskId }] : [];
  }) };
  return { ok: true, ...Object.fromEntries(["clientCommandId", "code", "taskId"].filter(key => id(value[key])).map(key => [key, value[key]])),
    state: ["completed", "failed", "confirming"].includes(value.state) ? value.state : "confirming" };
}
module.exports = { taskView, taskCommand, taskKey, taskResult, taskTargets: targets };
