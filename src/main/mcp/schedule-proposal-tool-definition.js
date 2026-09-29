"use strict";

const { z } = require("zod");
const {
  computeNextRunAt,
  describeSchedule,
  normalizeScheduleSpec,
  sanitizeScheduledTaskPrompt,
} = require("../schedule-parser");

// The agent's way to schedule work the user asked for. Before this the only
// path was a keyword pre-check on the user's message; "没五分钟查看小米汽车销量"
// (每 typed as 没) passed it by, reached the model, and the model — with no tool
// to act — told the user a task was registered and a card would appear. It
// never did (2026-09-29). This tool only PROPOSES: the host shows the same
// confirmation card, and nothing is created until the user confirms.
function buildScheduleProposalToolDefinition({ executionSurface, mcpServerName } = {}) {
  return {
    id: "lily_schedule_propose",
    name: "lily_schedule_propose",
    group: "scheduled-tasks",
    requiredSkillIds: [],
    executionSurface,
    mcpServerName,
    description: "Propose a scheduled or recurring task when the user asks for work to run later or repeatedly (\"每 5 分钟检查…\", \"every morning at 9 send…\"). The user sees a confirmation card under your answer and the task is created ONLY after they confirm — say so; never claim it is already scheduled. Schedule types: once {at: ISO-8601 with the user's UTC offset}; interval {every, unit: minute|hour|day}; hourly {every, minute}; daily {hour, minute}; daily_times {times:[{hour,minute}]}; weekly {weekday 0=Sunday, hour, minute}; weekdays_times {weekdays:[0-6], times}; monthly {dayOfMonth, hour, minute}; daily_window_interval {startHour, startMinute, endHour, endMinute, every, minute}.",
    inputSchema: {
      title: z.string().min(1).max(80).describe("short title, in the user's language"),
      prompt: z.string().min(1).max(2000).describe("what to do each time it runs, written as a self-contained request, without schedule words"),
      schedule: z.object({
        type: z.enum(["once", "interval", "hourly", "daily", "daily_times", "weekly", "weekdays_times", "monthly", "daily_window_interval"]),
        at: z.string().optional(),
        every: z.number().int().positive().optional(),
        unit: z.enum(["minute", "hour", "day"]).optional(),
        hour: z.number().int().min(0).max(23).optional(),
        minute: z.number().int().min(0).max(59).optional(),
        weekday: z.number().int().min(0).max(6).optional(),
        weekdays: z.array(z.number().int().min(0).max(6)).max(7).optional(),
        times: z.array(z.object({ hour: z.number().int().min(0).max(23), minute: z.number().int().min(0).max(59) })).max(24).optional(),
        dayOfMonth: z.number().int().min(1).max(31).optional(),
        startHour: z.number().int().min(0).max(23).optional(),
        startMinute: z.number().int().min(0).max(59).optional(),
        endHour: z.number().int().min(0).max(23).optional(),
        endMinute: z.number().int().min(0).max(59).optional(),
      }).describe("when it runs; interpret times in the user's local timezone"),
    },
    annotations: { readOnlyHint: true },
    handler: async ({ title, prompt, schedule }) => {
      const normalized = normalizeScheduleSpec(schedule);
      if (!normalized) return { ok: false, error: "INVALID_SCHEDULE", message: "The schedule is not one of the supported shapes; fix it and propose again." };
      const nextRunAt = computeNextRunAt(normalized);
      if (!nextRunAt) return { ok: false, error: "SCHEDULE_NOT_RUNNABLE", message: "This schedule has no future run (a one-time moment in the past?)." };
      const taskPrompt = sanitizeScheduledTaskPrompt(prompt);
      if (!taskPrompt) return { ok: false, error: "EMPTY_PROMPT", message: "Describe what the task should do each time it runs." };
      return {
        ok: true,
        proposal: { title, prompt: taskPrompt, schedule: normalized },
        scheduleText: describeSchedule(normalized),
        nextRunAt,
        pendingUserConfirmation: true,
        message: "A confirmation card is shown under your answer; the task is created only after the user confirms. Tell the user to confirm it there.",
      };
    },
  };
}

module.exports = { buildScheduleProposalToolDefinition };
