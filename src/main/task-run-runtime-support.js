"use strict";

function progressValueFromNotice(notice = {}) {
  const progress = notice?.progress;
  if (!progress || typeof progress !== "object") return null;
  const explicit = Number(progress.percent ?? progress.value);
  if (Number.isFinite(explicit)) return Math.max(0, Math.min(100, explicit));
  const current = Number(progress.current ?? progress.done ?? progress.writtenBytes ?? progress.currentBytes);
  const total = Number(progress.total ?? progress.max ?? progress.totalBytes);
  if (Number.isFinite(current) && Number.isFinite(total) && total > 0) {
    return Math.max(0, Math.min(100, (current / total) * 100));
  }
  return null;
}

function shouldBeginTaskRunAtTurnStart({ taskContract = null, turnPolicy = null, scheduledTask = null } = {}) {
  if (scheduledTask?.runId) return true;
  if (taskContract?.active) return true;
  return Boolean(turnPolicy && turnPolicy.rigor && turnPolicy.rigor !== "fast");
}

function compactTool(tool = null) {
  if (!tool) return null;
  return {
    id: tool.id || "",
    name: tool.name || "unknown",
    status: tool.status || "",
    title: tool.title || "",
  };
}

function createLeadLeaseRenewal({ agentTaskGraphStore, now, log }) {
  function renewLeadLease(sessionId, state) {
    const graphId = state.taskRun?.agentGraphId;
    const attemptId = state.taskRun?.resumeState?.leadAttemptId;
    if (!agentTaskGraphStore || !graphId || !attemptId) return;
    try {
      agentTaskGraphStore.renew({
        graphId,
        sessionId,
        taskId: `lead_${state.taskRun.id}`,
        workerId: "lead",
        attemptId,
        now: now(),
        leaseMs: 24 * 60 * 60 * 1_000,
      });
    } catch (error) {
      if (!/AGENT_TASK_(NOT_RUNNING|LEASE_EXPIRED)/.test(String(error?.code || error?.message || ""))) {
        log.warn("Lead agent lease renewal failed open: %s", error?.message || error);
      }
    }
  }

  return renewLeadLease;
}

module.exports = { progressValueFromNotice, shouldBeginTaskRunAtTurnStart, compactTool, createLeadLeaseRenewal };
