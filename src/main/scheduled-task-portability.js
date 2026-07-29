"use strict";

const {
  DEFAULT_PERMISSION_MODE,
  describeSchedule,
  normalizeScheduleSpec,
  safeText,
} = require("./schedule-parser");

const AUTOMATION_SCHEMA_VERSION = 1;
const AUTOMATIONS_ENTRY = ".lilyspace/automations.json";
const MAX_AUTOMATIONS_BYTES = 256 * 1024;
function normalizeTemplate(value) {
  if (!value || typeof value !== "object") return null;
  const title = safeText(value.title, 80);
  const prompt = safeText(value.prompt, 4000);
  const schedule = normalizeScheduleSpec(value.schedule);
  if (!prompt || !schedule) return null;
  return {
    title: title || prompt.slice(0, 48) || "Scheduled Task",
    prompt,
    schedule,
    scheduleText: safeText(value.scheduleText, 120) || describeSchedule(schedule),
    permissionMode: DEFAULT_PERMISSION_MODE,
  };
}

function normalizeTaskTemplates(value) {
  const rawTasks = Array.isArray(value)
    ? value
    : Array.isArray(value?.tasks)
      ? value.tasks
      : [];
  const templates = [];
  const skipped = [];
  for (let index = 0; index < rawTasks.length; index += 1) {
    const template = normalizeTemplate(rawTasks[index]);
    if (template) templates.push(template);
    else skipped.push({ index, reason: "INVALID_AUTOMATION_TEMPLATE" });
  }
  return { templates, skipped };
}

function exportTaskTemplates(tasks, selectedTaskIds) {
  const selected = new Set(
    (Array.isArray(selectedTaskIds) ? selectedTaskIds : [])
      .map((id) => String(id || "").trim())
      .filter(Boolean),
  );
  const candidates = (Array.isArray(tasks) ? tasks : [])
    .filter((task) => selected.has(String(task?.id || "")));
  return normalizeTaskTemplates(candidates).templates;
}

function previewProjectTasks(manager, projectId) {
  const result = manager?.list?.({ projectId: String(projectId || ""), sessionId: "" });
  return (Array.isArray(result?.tasks) ? result.tasks : []).map((task) => ({
    id: String(task.id || ""),
    title: safeText(task.title, 80) || "Scheduled Task",
    prompt: safeText(task.prompt, 4000),
    schedule: normalizeScheduleSpec(task.schedule),
    scheduleText: safeText(task.scheduleText, 120) || describeSchedule(task.schedule),
    permissionMode: DEFAULT_PERMISSION_MODE,
    enabled: task.enabled !== false,
  })).filter((task) => task.id && task.prompt && task.schedule);
}

function importPausedTaskTemplates(manager, templates, scope) {
  if (!manager?.importPausedTemplates) return { ok: false, error: "SCHEDULER_UNAVAILABLE" };
  return manager.importPausedTemplates(templates, scope);
}

function writeAutomationEntry(zip, value) {
  const normalized = normalizeTaskTemplates(value);
  if (normalized.templates.length) {
    zip.file(AUTOMATIONS_ENTRY, JSON.stringify({
      schemaVersion: AUTOMATION_SCHEMA_VERSION,
      tasks: normalized.templates,
    }, null, 2));
  }
  return normalized.templates.length;
}

async function readAutomationEntry(entry) {
  if (!entry) return { automationTemplates: [], skippedAutomations: [] };
  const declaredSize = Number(entry?._data?.uncompressedSize || 0);
  if (declaredSize > MAX_AUTOMATIONS_BYTES) {
    return {
      automationTemplates: [],
      skippedAutomations: [{ index: -1, reason: "AUTOMATIONS_TOO_LARGE" }],
    };
  }
  let value;
  try {
    const text = await entry.async("string");
    if (Buffer.byteLength(text, "utf8") > MAX_AUTOMATIONS_BYTES) {
      return {
        automationTemplates: [],
        skippedAutomations: [{ index: -1, reason: "AUTOMATIONS_TOO_LARGE" }],
      };
    }
    value = JSON.parse(text);
  } catch {
    return {
      automationTemplates: [],
      skippedAutomations: [{ index: -1, reason: "AUTOMATIONS_CORRUPT" }],
    };
  }
  if (Number(value?.schemaVersion || 0) > AUTOMATION_SCHEMA_VERSION) {
    return {
      automationTemplates: [],
      skippedAutomations: [{ index: -1, reason: "AUTOMATIONS_TOO_NEW" }],
    };
  }
  const normalized = normalizeTaskTemplates(value);
  return {
    automationTemplates: normalized.templates,
    skippedAutomations: normalized.skipped,
  };
}

module.exports = {
  AUTOMATIONS_ENTRY,
  AUTOMATION_SCHEMA_VERSION,
  MAX_AUTOMATIONS_BYTES,
  exportTaskTemplates,
  importPausedTaskTemplates,
  normalizeTaskTemplates,
  previewProjectTasks,
  readAutomationEntry,
  writeAutomationEntry,
};
