"use strict";

// Engine notices -> the task's liveness (progress, "no visible progress" and
// warning risks), deduplicated within 750 ms. Split from task-run-runtime.js.
const { addTaskRisk, compactTaskRun, updateTaskLiveness } = require("./task-run-state");
const { progressValueFromNotice } = require("./task-run-runtime-support");

function createLivenessUpdater({ stateFor, now, emitTaskEvent, log }) {
  function updateLivenessFromNotice(sessionId, notice = {}, eventType = "engine.notice") {
    try {
      const state = stateFor(sessionId);
      if (!notice) return null;
      const code = String(notice.code || "").trim();
      const detail = String(notice.detail || notice.message || "").trim();
      let status = "runtime_notice";
      let phase = "";
      let countsAsActivity = false;
      if (code === "longWait" || code === "waitingForFirstResponse") {
        status = "no_visible_progress";
        phase = "waiting";
      } else if (code === "toolProgress" || code === "shellLongRunning") {
        status = "tool_running";
        phase = "tool_running";
      } else if (code === "workProgress") {
        status = "work_running";
        phase = "work_running";
        countsAsActivity = true;
      } else if (eventType === "engine.warning" || notice.level === "warning") {
        status = "warning";
      } else if (notice.level === "progress") {
        status = "running";
      }
      if (!state.taskRun) return null;
      const ts = now();
      const livenessSig = `${status}\0${code}\0${detail}`;
      const previousLiveness = state.taskRun._lastLivenessEmit || null;
      if (
        previousLiveness?.sig === livenessSig &&
        Number.isFinite(previousLiveness.ts) &&
        ts - previousLiveness.ts < 750
      ) return state.taskRun.liveness || null;

      state.taskRun._lastLivenessEmit = { sig: livenessSig, ts };
      const liveness = updateTaskLiveness(state.taskRun, {
        status,
        detail,
        noticeCode: code,
        countsAsActivity,
      });
      if (phase && detail) {
        state.taskRun.phase = phase;
        state.taskRun.progress = {
          label: detail,
          value: progressValueFromNotice(notice),
        };
        state.taskRun.resumeState = {
          ...(state.taskRun.resumeState || {}),
          lastLivenessCode: code,
        };
      }
      emitTaskEvent(sessionId, "task.liveness.updated", {
        taskRunId: state.taskRun.id,
        liveness,
        notice: {
          code,
          level: notice.level || "",
          detail,
          progress: notice.progress && typeof notice.progress === "object" ? notice.progress : null,
        },
        taskRun: compactTaskRun(state.taskRun),
      });
      if (status === "no_visible_progress") {
        const risk = addTaskRisk(state.taskRun, {
          code: "NO_VISIBLE_PROGRESS",
          level: "info",
          message: detail || "NO_VISIBLE_PROGRESS",
        });
        emitTaskEvent(sessionId, "task.risk.detected", {
          taskRunId: state.taskRun.id,
          risk,
          taskRun: compactTaskRun(state.taskRun),
        });
      } else if (status === "warning") {
        const risk = addTaskRisk(state.taskRun, {
          code: code || "ENGINE_WARNING",
          level: "warning",
          message: detail || code || "ENGINE_WARNING",
        });
        emitTaskEvent(sessionId, "task.risk.detected", {
          taskRunId: state.taskRun.id,
          risk,
          taskRun: compactTaskRun(state.taskRun),
        });
      }
      return liveness;
    } catch (err) {
      log.warn("TaskRun liveness update failed: %s", err?.message || err);
      return null;
    }
  }

  return updateLivenessFromNotice;
}

module.exports = { createLivenessUpdater };
