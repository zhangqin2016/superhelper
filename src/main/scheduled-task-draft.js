"use strict";

/**
 * Turning a sentence into a schedule draft: the model first (with the user's
 * local clock), the local regex parser as the fallback. Pure; the manager only
 * supplies an optional test-time parser override.
 */
const {
  hasScheduledTaskNegation,
  parseScheduleFromText,
  sanitizeScheduledTaskPrompt,
  nowIso,
  safeText,
  DEFAULT_PERMISSION_MODE,
} = require("./schedule-parser");
const { parseScheduledTaskDraftWithModel } = require("./scheduled-task-ai-draft");

function parseDraft({ text, sessionId, projectId } = {}) {
  const prompt = safeText(text, 4000);
  if (!prompt) return { ok: false, error: "EMPTY" };
  if (hasScheduledTaskNegation(prompt)) return { ok: false, error: "SCHEDULE_NEGATED" };
  const parsed = parseScheduleFromText(prompt);
  if (!parsed.ok) return parsed;
  const taskPrompt = sanitizeScheduledTaskPrompt(prompt);
  return {
    ok: true,
    draft: {
      title: taskPrompt.slice(0, 48) || "Scheduled Task",
      prompt: taskPrompt,
      schedule: parsed.schedule,
      scheduleText: parsed.scheduleText,
      nextRunAt: parsed.nextRunAt,
      permissionMode: DEFAULT_PERMISSION_MODE,
      sessionId,
      projectId,
    },
  };
}

async function parseDraftSmart(manager, { text, sessionId, projectId } = {}) {
  const prompt = safeText(text, 4000);
  if (!prompt) return { ok: false, error: "EMPTY" };
  if (hasScheduledTaskNegation(prompt)) return { ok: false, error: "SCHEDULE_NEGATED" };
  const modelResult = await (manager?.aiDraftParser || parseScheduledTaskDraftWithModel)({
    text: prompt,
    sessionId,
    projectId,
    now: nowIso(),
  });
  if (modelResult?.ok) return { ...modelResult, draft: { ...modelResult.draft, permissionMode: DEFAULT_PERMISSION_MODE }, source: modelResult.source || "model" };
  const fallback = parseDraft({ text: prompt, sessionId, projectId });
  if (fallback?.ok) {
    return { ...fallback, source: "local_fallback", modelError: modelResult?.error || null };
  }
  return {
    ok: false,
    error: modelResult?.error || fallback?.error || "SCHEDULE_NOT_FOUND",
    fallbackError: fallback?.error || null,
  };
}


module.exports = { parseDraft, parseDraftSmart };
