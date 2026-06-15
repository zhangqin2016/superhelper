"use strict";

const { getServiceSettings } = require("./service-client");
const { normalizeToLilyEnv } = require("./agent-env");
const {
  computeNextRunAt,
  describeSchedule,
  normalizeScheduleSpec,
  sanitizeScheduledTaskPrompt,
} = require("./schedule-parser");

const REQUEST_TIMEOUT_MS = 12_000;

function buildLilyEnv() {
  const { loadSettingsEnv } = require("./agent-settings");
  const { getActivePresetEnv, getUserApiEnv } = require("./model-presets");
  const { getRemoteRuntimeEnvSync } = require("./remote-config");
  return normalizeToLilyEnv({
    ...loadSettingsEnv(),
    ...getRemoteRuntimeEnvSync(),
    ...getActivePresetEnv(),
    ...getUserApiEnv(),
  });
}

function resolveMessagesUrl(baseUrl) {
  const raw = String(baseUrl || "").trim();
  if (!raw) return "";
  const serviceBase = getServiceSettings().apiBaseUrl;
  const absolute = /^https?:\/\//i.test(raw)
    ? raw
    : new URL(raw.replace(/^\/+/, ""), `${serviceBase.replace(/\/+$/, "")}/`).toString();
  const clean = absolute.replace(/\/+$/, "");
  if (/\/v1\/messages$/i.test(clean)) return clean;
  if (/\/v1$/i.test(clean)) return `${clean}/messages`;
  return `${clean}/v1/messages`;
}

function modelIdFromEnv(env) {
  return env.LILY_MODEL_HAIKU || env.LILY_MODEL || env.LILY_MODEL_SONNET || env.LILY_MODEL_OPUS || "";
}

function extractText(responseJson) {
  if (typeof responseJson?.content === "string") return responseJson.content;
  if (Array.isArray(responseJson?.content)) {
    return responseJson.content
      .map((item) => typeof item === "string" ? item : item?.text || "")
      .join("")
      .trim();
  }
  if (typeof responseJson?.choices?.[0]?.message?.content === "string") {
    return responseJson.choices[0].message.content;
  }
  return "";
}

function parseJsonObject(text) {
  const raw = String(text || "").trim();
  if (!raw) return null;
  const unfenced = raw
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  try {
    return JSON.parse(unfenced);
  } catch {
    const start = unfenced.indexOf("{");
    const end = unfenced.lastIndexOf("}");
    if (start < 0 || end <= start) return null;
    try {
      return JSON.parse(unfenced.slice(start, end + 1));
    } catch {
      return null;
    }
  }
}

function normalizeModelDraft(raw, payload = {}) {
  if (!raw || typeof raw !== "object") return { ok: false, error: "AI_DRAFT_INVALID_JSON" };
  const schedule = normalizeScheduleSpec(raw.schedule);
  if (!schedule) return { ok: false, error: "AI_DRAFT_INVALID_SCHEDULE" };
  const nextRunAt = computeNextRunAt(schedule);
  if (!nextRunAt) return { ok: false, error: "AI_DRAFT_INVALID_NEXT_RUN" };
  const prompt = sanitizeScheduledTaskPrompt(raw.prompt || raw.task || payload.text || "");
  if (!prompt) return { ok: false, error: "AI_DRAFT_INVALID_PROMPT" };
  const title = sanitizeScheduledTaskPrompt(raw.title || prompt).slice(0, 80) || "Scheduled Task";
  return {
    ok: true,
    source: "model",
    draft: {
      title,
      prompt,
      schedule,
      scheduleText: describeSchedule(schedule),
      nextRunAt,
      permissionMode: "read_only",
      sessionId: payload.sessionId,
      projectId: payload.projectId,
    },
  };
}

function systemPrompt() {
  return [
    "You convert a user's natural-language scheduled task request into one strict JSON object.",
    "Return JSON only. No markdown. No explanation.",
    "The user may write Chinese, English, or Arabic. Preserve the task language in title/prompt.",
    "Never execute the task. Only draft a schedule.",
    "If the user says not to create/schedule/remind, or only describes content such as hourly forecasts, hourly charts, or plan text, return {}.",
    "Use local time unless the user explicitly gives a timezone.",
    "Supported schedule schemas:",
    '{"type":"once","at":"ISO-8601 datetime"}',
    '{"type":"daily","hour":0-23,"minute":0-59}',
    '{"type":"daily_times","times":[{"hour":0-23,"minute":0-59}]}',
    '{"type":"weekly","weekday":0-6,"hour":0-23,"minute":0-59} where 0=Sunday',
    '{"type":"weekdays_times","weekdays":[0-6],"times":[{"hour":0-23,"minute":0-59}]}',
    '{"type":"monthly","dayOfMonth":1-31,"hour":0-23,"minute":0-59}',
    '{"type":"interval","every":positive integer,"unit":"minute"|"hour"|"day"}',
    '{"type":"hourly","every":positive integer,"minute":0-59}',
    '{"type":"daily_window_interval","startHour":0-23,"startMinute":0-59,"endHour":0-23,"endMinute":0-59,"every":positive integer,"unit":"hour","minute":0-59}',
    'Output shape: {"title":"short title","prompt":"task to send when due, without schedule words","schedule":{...}}',
    "For ranges such as Monday to Friday at 10 and 11, use weekdays_times.",
  ].join("\n");
}

async function callMessagesApi({ url, apiKey, model, text, now }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        authorization: `Bearer ${apiKey}`,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model,
        max_tokens: 700,
        temperature: 0,
        system: systemPrompt(),
        messages: [{
          role: "user",
          content: `Now: ${now}\nUser request: ${text}`,
        }],
      }),
    });
    const json = await response.json().catch(() => ({}));
    if (!response.ok) {
      return { ok: false, error: "AI_DRAFT_REQUEST_FAILED", status: response.status, detail: json?.error?.message || json?.message || "" };
    }
    return { ok: true, json };
  } catch (error) {
    return { ok: false, error: "AI_DRAFT_REQUEST_FAILED", detail: error?.message || String(error) };
  } finally {
    clearTimeout(timer);
  }
}

async function parseScheduledTaskDraftWithModel(payload = {}) {
  const text = String(payload.text || "").trim();
  if (!text) return { ok: false, error: "EMPTY" };
  const env = buildLilyEnv();
  const url = resolveMessagesUrl(env.LILY_API_BASE_URL);
  const apiKey = String(env.LILY_API_KEY || "").trim();
  const model = modelIdFromEnv(env);
  if (!url || !apiKey || !model || apiKey.startsWith("$")) {
    return { ok: false, error: "AI_DRAFT_NOT_CONFIGURED" };
  }
  const result = await callMessagesApi({
    url,
    apiKey,
    model,
    text,
    now: payload.now || new Date().toISOString(),
  });
  if (!result.ok) return result;
  return normalizeModelDraft(parseJsonObject(extractText(result.json)), payload);
}

module.exports = {
  parseScheduledTaskDraftWithModel,
  normalizeModelDraft,
  resolveMessagesUrl,
};
