"use strict";

// Durable store terminal states plus legacy process-jobs-core receipts.
const TERMINAL_JOB_STATUSES = new Set(["succeeded", "failed", "cancelled", "outcome_unknown", "exited", "stopped"]);
const PROCESS_JOB_TOOL = /^(?:(?:mcp__)?lily_(?:process_jobs|pj)(?:__|[._/:]))?job_(?:start|status|logs|stop)$/;

function parseJson(text) {
  try {
    return JSON.parse(String(text || ""));
  } catch {
    return null;
  }
}

function resultObjects(result) {
  const out = [];
  if (result && typeof result === "object") out.push(result);
  if (Array.isArray(result?.content)) {
    for (const part of result.content) {
      const parsed = part?.type === "text" ? parseJson(part.text) : null;
      if (parsed && typeof parsed === "object") out.push(parsed);
    }
  }
  if (typeof result === "string") {
    const parsed = parseJson(result);
    if (parsed && typeof parsed === "object") out.push(parsed);
  }
  return out;
}

function hasIncompleteProgress(progress) {
  if (!progress || typeof progress !== "object") return false;
  const current = Number(progress.current ?? progress.done ?? progress.writtenBytes ?? progress.currentBytes);
  const total = Number(progress.total ?? progress.max ?? progress.totalBytes);
  if (Number.isFinite(current) && Number.isFinite(total) && total > 0) return current < total;
  return Boolean(progress.label || progress.phase || progress.domain || progress.status);
}

function isBlockingJobPayload(payload = {}) {
  const status = String(payload.state || payload.status || "").toLowerCase();
  if (status !== "running") return false;
  const outputFiles = Array.isArray(payload.outputFiles) ? payload.outputFiles.filter(Boolean) : [];
  return outputFiles.length > 0 || hasIncompleteProgress(payload.progress);
}

function compactJob(payload = {}) {
  return {
    jobId: String(payload.jobId || ""),
    status: String(payload.state || payload.status || ""),
    phase: String(payload.phase || payload.progress?.phase || payload.progress?.label || ""),
    progress: payload.progress && typeof payload.progress === "object" ? payload.progress : null,
    outputFiles: Array.isArray(payload.outputFiles) ? payload.outputFiles.filter(Boolean).slice(0, 10) : [],
  };
}

function jobGeneration(payload) {
  const startedAt = typeof payload.startedAt === "string" ? Date.parse(payload.startedAt) : NaN;
  return Number.isInteger(payload.pid) && payload.pid > 0 && Number.isFinite(startedAt)
    ? { pid: payload.pid, startedAt }
    : null;
}

function findBlockingRunningProcessJobs(tools = []) {
  const jobs = new Map();
  const terminalJobs = new Set();
  const generations = new Map();
  for (const tool of tools || []) {
    for (const payload of resultObjects(tool?.result)) {
      if (!payload?.jobId) continue;
      const jobId = String(payload.jobId);
      const statuses = [payload.state, payload.status].filter((value) => value != null);
      const validReceipt = typeof payload.jobId === "string"
        && (tool?.input?.jobId === undefined || tool.input.jobId === payload.jobId)
        && payload.ok === true && payload.isError !== true
        && tool?.result?.isError !== true && tool?.result?.ok !== false
        && ["done", "completed"].includes(tool?.status)
        && PROCESS_JOB_TOOL.test(String(tool?.name || ""))
        && statuses.length > 0
        && statuses.every((status) => typeof status === "string"
          && status.toLowerCase() === statuses[0].toLowerCase());
      const status = validReceipt ? statuses[0].toLowerCase() : "";
      const generation = jobGeneration(payload);
      const previous = generations.get(jobId);
      if (previous && (!generation || generation.pid !== previous.pid || generation.startedAt !== previous.startedAt)) {
        // Only an observed new start can reuse a legacy ID; status replies cannot.
        const restarted = validReceipt && status === "running" && /job_start$/.test(tool.name)
          && generation && generation.startedAt > previous.startedAt;
        if (!restarted) continue;
        terminalJobs.delete(jobId);
        jobs.delete(jobId);
        generations.set(jobId, generation);
      }
      if (terminalJobs.has(jobId)) continue;
      if (validReceipt && generation && (status === "running" || TERMINAL_JOB_STATUSES.has(status))) {
        generations.set(jobId, generation);
      }
      const validTerminal = validReceipt && TERMINAL_JOB_STATUSES.has(status);
      if (validTerminal) {
        // A terminal receipt ends liveness only; task acceptance is decided elsewhere.
        terminalJobs.add(jobId);
        jobs.delete(jobId);
      } else if (isBlockingJobPayload(payload)) {
        jobs.set(jobId, compactJob(payload));
      }
    }
  }
  return [...jobs.values()];
}

function runningProcessJobNotice(jobs = []) {
  const first = jobs[0] || {};
  const progress = first.progress || {};
  const current = Number(progress.current ?? progress.done);
  const total = Number(progress.total);
  const count = jobs.length > 1 ? ` 等 ${jobs.length} 个后台任务` : "";
  const progressText = Number.isFinite(current) && Number.isFinite(total) && total > 0
    ? `（${current}/${total}）`
    : "";
  return `后台任务 ${first.jobId || "unknown"}${count} 仍在运行${progressText}，本轮不能标记为已完成。请继续检查 job_status/job_logs，等任务退出或产物完成后再给最终结果。`;
}

module.exports = {
  findBlockingRunningProcessJobs,
  runningProcessJobNotice,
};
