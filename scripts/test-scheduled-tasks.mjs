#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import module from "node:module";

const require = module.createRequire(import.meta.url);
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "lily-scheduled-tasks-"));
const userData = path.join(tempRoot, "userData");
const electronPath = require.resolve("electron");

require.cache[electronPath] = {
  id: electronPath,
  filename: electronPath,
  loaded: true,
  exports: {
    app: {
      getPath: (name) => {
        if (name === "userData") return userData;
        if (name === "home") return tempRoot;
        if (name === "documents") return tempRoot;
        return tempRoot;
      },
    },
  },
};

const {
  ScheduledTaskManager,
  buildTaskPrompt,
  computeNextRunAt,
  normalizeScheduleSpec,
  parseScheduleFromText,
  sanitizeScheduledTaskPrompt,
} = require("../src/main/scheduled-tasks.js");
const {
  normalizeModelDraft,
  resolveMessagesUrl,
  resolveModelRequest,
} = require("../src/main/scheduled-task-ai-draft.js");
const {
  looksLikeScheduledTaskIntent,
} = require("../src/main/scheduled-task-intent.js");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertSchedule(text, expectedType) {
  const result = parseScheduleFromText(text, new Date(2026, 5, 9, 0, 0, 0));
  assert(result.ok, `schedule should parse: ${text}`);
  assert(result.schedule.type === expectedType, `expected ${expectedType}, got ${JSON.stringify(result.schedule)}`);
  assert(result.nextRunAt, "nextRunAt is required");
  return result;
}

function assertLocalTime(isoValue, expectedHour, expectedMinute, message) {
  const date = new Date(isoValue);
  assert(date.getHours() === expectedHour && date.getMinutes() === expectedMinute, `${message}: ${isoValue}`);
}

async function flushMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
}

try {
  fs.mkdirSync(userData, { recursive: true });
  assert(looksLikeScheduledTaskIntent("每天上午 9 点到 12 点，每个整点提醒我整理待办"), "chat intent should catch natural scheduled task text");
  assert(looksLikeScheduledTaskIntent("每周一到周五 早上10点 11点整理我的待办"), "chat intent should catch weekday range text");
  assert(looksLikeScheduledTaskIntent("帮我创建定时任务，每小时检查一次服务状态"), "chat intent should catch explicit scheduled task creation");
  assert(!looksLikeScheduledTaskIntent("今天下午帮我分析这个设计是否合理"), "chat intent should not catch ordinary time references");
  assert(!looksLikeScheduledTaskIntent("知识方案里需要有逐小时预报，不是创建定时任务"), "chat intent must honor explicit scheduled-task negation");
  assert(!looksLikeScheduledTaskIntent("这个天气页面要展示逐小时预报和每天趋势"), "chat intent should not catch schedule words used as content description");
  assert(!looksLikeScheduledTaskIntent("方案里包含每小时价格刷新，但不是创建定时任务"), "chat intent should not catch negated hourly feature descriptions");
  assert(!looksLikeScheduledTaskIntent("每天整理重点", [{ name: "a.txt" }]), "chat intent should not intercept attached-file turns");
  assert(
    sanitizeScheduledTaskPrompt("创建每日 10:00 自动任务同步 Bug") === "同步 Bug",
    "stored scheduled task prompt must remove creation/schedule intent",
  );
  assert(
    sanitizeScheduledTaskPrompt("每周一到周五 早上10点 11点整理我的待办") === "整理我的待办",
    "stored scheduled task prompt must remove weekday/time intent",
  );
  const executionPrompt = buildTaskPrompt({ title: "创建每日 10:00 自动任务同步 Bug", prompt: "创建每日 10:00 自动任务同步 Bug" });
  assert(executionPrompt.includes("Task: 同步 Bug"), `execution prompt title should be sanitized: ${executionPrompt}`);
  assert(executionPrompt.includes("Task content:\n同步 Bug"), `execution prompt should contain only task content: ${executionPrompt}`);
  assert(executionPrompt.includes("NOT a request to create or modify any scheduled task"), "execution prompt should declare scheduled-run boundary");
  assertSchedule("每天早上 9 点帮我整理昨天的工作日志", "daily");
  assertSchedule("每周一 10:30 生成周报", "weekly");
  assertSchedule("每隔 2 小时检查一次构建状态", "interval");
  const multiDaily = assertSchedule("每天 10点 13点 18点整理待办", "daily_times");
  assert(
    multiDaily.scheduleText === "Daily at 10:00 / 13:00 / 18:00",
    `multi daily schedule text should be readable: ${multiDaily.scheduleText}`,
  );
  assertLocalTime(multiDaily.nextRunAt, 10, 0, "multi daily should pick the next listed local time");
  const dailyWindow = assertSchedule("上午9点到12点 每个整点 整理我的待办", "daily_window_interval");
  assert(
    dailyWindow.scheduleText === "Daily 09:00-12:00 on the hour",
    `daily window schedule text should be readable: ${dailyWindow.scheduleText}`,
  );
  assertLocalTime(dailyWindow.nextRunAt, 9, 0, "daily window should pick today's start when not reached");
  const dailyWindowDuring = parseScheduleFromText("上午9点到12点 每个整点 整理我的待办", new Date(2026, 5, 9, 9, 13, 0));
  assertLocalTime(dailyWindowDuring.nextRunAt, 10, 0, "daily window should advance to next hour inside window");
  const dailyWindowAfter = parseScheduleFromText("上午9点到12点 每个整点 整理我的待办", new Date(2026, 5, 9, 12, 1, 0));
  assertLocalTime(dailyWindowAfter.nextRunAt, 9, 0, "daily window should roll to tomorrow after window");
  const normalizedWindow = normalizeScheduleSpec({
    type: "daily_window_interval",
    startHour: 9,
    endHour: 12,
    every: 1,
    minute: 0,
  });
  assert(normalizedWindow?.startMinute === 0 && normalizedWindow?.endMinute === 0, `model JSON schedule should normalize: ${JSON.stringify(normalizedWindow)}`);
  const normalizedWeekdaysTimes = normalizeScheduleSpec({
    type: "weekdays_times",
    weekdays: [1, 2, 3, 4, 5],
    times: [{ hour: 10 }, { hour: 11, minute: 0 }],
  });
  assert(
    normalizedWeekdaysTimes?.weekdays?.length === 5 && normalizedWeekdaysTimes?.times?.length === 2,
    `model weekday/time schedule should normalize: ${JSON.stringify(normalizedWeekdaysTimes)}`,
  );
  const weekdaysNext = computeNextRunAt(normalizedWeekdaysTimes, new Date(2026, 5, 9, 10, 30, 0));
  assertLocalTime(weekdaysNext, 11, 0, "weekday/time schedule should pick the next configured time");
  const modelDraft = normalizeModelDraft({
    title: "整理我的待办",
    prompt: "整理我的待办",
    schedule: {
      type: "weekdays_times",
      weekdays: [1, 2, 3, 4, 5],
      times: [{ hour: 10 }, { hour: 11 }],
    },
  }, { text: "每周一到周五 10 点 11 点整理我的待办", sessionId: "s1", projectId: "p1" });
  assert(modelDraft.ok, `model draft JSON should normalize: ${JSON.stringify(modelDraft)}`);
  assert(modelDraft.draft.scheduleText === "Mon / Tue / Wed / Thu / Fri at 10:00 / 11:00", `model draft schedule text should be readable: ${modelDraft.draft.scheduleText}`);
  assert(resolveMessagesUrl("/llm/deepseek") === "https://lilych.lilywb.cn/llm/deepseek/v1/messages", "legacy messages helper should still resolve against service api base");
  assert(
    resolveModelRequest({ baseUrl: "/llm/deepseek", protocol: "anthropic" }).url === "https://lilych.lilywb.cn/llm/deepseek/v1/messages",
    "anthropic model draft endpoint should use /v1/messages",
  );
  assert(
    resolveModelRequest({ baseUrl: "/llm/iluvatar-vllm/v1", protocol: "openai" }).url === "https://lilych.lilywb.cn/llm/iluvatar-vllm/v1/chat/completions",
    "openai model draft endpoint should use /chat/completions",
  );
  const invalidWindow = normalizeScheduleSpec({
    type: "daily_window_interval",
    startHour: 18,
    endHour: 9,
  });
  assert(!invalidWindow, `invalid model JSON schedule should be rejected: ${JSON.stringify(invalidWindow)}`);
  const hourlyOnTheHour = assertSchedule("每个整点提醒我的待办事项有哪些", "hourly");
  assert(hourlyOnTheHour.schedule.minute === 0, `on-the-hour schedule should use minute 0: ${JSON.stringify(hourlyOnTheHour.schedule)}`);
  const hourlyPlain = assertSchedule("每小时检查一次服务状态", "hourly");
  assert(hourlyPlain.schedule.every === 1, `hourly schedule should repeat every hour: ${JSON.stringify(hourlyPlain.schedule)}`);
  const dailyWithPlainNumber = assertSchedule("每天整理 3 个重点问题", "daily");
  assert(dailyWithPlainNumber.schedule.hour === 9, `plain content number should not become a time: ${JSON.stringify(dailyWithPlainNumber.schedule)}`);
  const english = assertSchedule("every day at 9am summarize yesterday's work log", "daily");
  assert(english.schedule.hour === 9, `english am time should parse: ${JSON.stringify(english.schedule)}`);
  const englishHourly = assertSchedule("hourly summarize open todos", "hourly");
  assert(englishHourly.schedule.minute === 0, `english hourly should run on the hour: ${JSON.stringify(englishHourly.schedule)}`);
  const arabicDaily = assertSchedule("كل يوم الساعة 9 صباحاً لخّص سجل عمل الأمس", "daily");
  assert(arabicDaily.schedule.hour === 9, `arabic daily time should parse: ${JSON.stringify(arabicDaily.schedule)}`);
  const arabicWeekly = assertSchedule("كل اثنين الساعة 10 صباحاً أنشئ تقريراً أسبوعياً", "weekly");
  assert(arabicWeekly.schedule.weekday === 1 && arabicWeekly.schedule.hour === 10, `arabic weekly should parse: ${JSON.stringify(arabicWeekly.schedule)}`);
  const arabicHourly = assertSchedule("كل ساعة افحص حالة البناء", "hourly");
  assert(arabicHourly.schedule.minute === 0, `arabic hourly should run on the hour: ${JSON.stringify(arabicHourly.schedule)}`);
  const arabicInterval = assertSchedule("كل 2 ساعة افحص حالة البناء", "interval");
  assert(arabicInterval.schedule.every === 2 && arabicInterval.schedule.unit === "hour", `arabic interval should parse: ${JSON.stringify(arabicInterval.schedule)}`);
  const from = new Date("2026-06-08T09:00:02.000Z");
  const next = computeNextRunAt({ type: "weekly", weekday: 1, hour: 9, minute: 0 }, from);
  assert(Date.parse(next) - from.getTime() > 6 * 24 * 60 * 60 * 1000, `weekly schedule should move past grace window: ${next}`);
  const nextHourly = computeNextRunAt({ type: "hourly", every: 1, minute: 0 }, new Date(2026, 5, 8, 9, 13, 0));
  assertLocalTime(nextHourly, 10, 0, "hourly schedule should align to next full local hour");

  const sent = [];
  const manager = new ScheduledTaskManager();
  manager.load();
  manager.start({
    sessionManager: {
      findById: (id) => (id === "s1" ? { id: "s1", projectId: "p1" } : null),
    },
    projectManager: {
      find: (id) => (id === "p1" ? { id: "p1", path: tempRoot } : null),
    },
    turnOrchestrator: {
      sendUserMessage: async (sessionId, text, files, opts) => {
        sent.push({ sessionId, text, files, opts });
        return { ok: true, turnId: `turn_${sent.length}` };
      },
    },
  });
  manager.stop();

  const draft = manager.parseDraft({
    text: "每天早上 9 点整理项目风险",
    sessionId: "s1",
    projectId: "p1",
  });
  assert(draft.ok && draft.draft.sessionId === "s1", `draft failed: ${JSON.stringify(draft)}`);
  const multiDraft = manager.parseDraft({
    text: "每天 10点 13点 18点整理待办",
    sessionId: "s1",
    projectId: "p1",
  });
  assert(multiDraft.ok, `multi daily draft failed: ${JSON.stringify(multiDraft)}`);
  assert(multiDraft.draft.title === "整理待办", `multi daily title should be clean: ${multiDraft.draft.title}`);
  assert(multiDraft.draft.scheduleText === "Daily at 10:00 / 13:00 / 18:00", `multi daily draft schedule should be readable: ${multiDraft.draft.scheduleText}`);
  const windowDraft = manager.parseDraft({
    text: "上午9点到12点 每个整点 整理我的待办",
    sessionId: "s1",
    projectId: "p1",
  });
  assert(windowDraft.ok, `daily window draft failed: ${JSON.stringify(windowDraft)}`);
  assert(windowDraft.draft.title === "整理我的待办", `daily window title should be clean: ${windowDraft.draft.title}`);
  assert(windowDraft.draft.scheduleText === "Daily 09:00-12:00 on the hour", `daily window draft schedule should be readable: ${windowDraft.draft.scheduleText}`);
  manager.aiDraftParser = async () => ({
    ok: true,
    draft: {
      title: "整理我的待办",
      prompt: "整理我的待办",
      sessionId: "s1",
      projectId: "p1",
      schedule: normalizedWeekdaysTimes,
      scheduleText: "每周一 / 周二 / 周三 / 周四 / 周五 10:00 / 11:00",
      nextRunAt: computeNextRunAt(normalizedWeekdaysTimes),
      permissionMode: "read_only",
    },
  });
  const smartDraft = await manager.parseDraftSmart({
    text: "每周一到周五 早上10点 11点整理我的待办",
    sessionId: "s1",
    projectId: "p1",
  });
  assert(smartDraft.ok && smartDraft.source === "model", `smart draft should use model JSON: ${JSON.stringify(smartDraft)}`);
  assert(smartDraft.draft.schedule.type === "weekdays_times", `smart draft should preserve model schedule type: ${JSON.stringify(smartDraft.draft.schedule)}`);
  const minuteDraft = manager.parseDraft({
    text: "每天 10点13分整理待办",
    sessionId: "s1",
    projectId: "p1",
  });
  assert(minuteDraft.ok, `minute draft failed: ${JSON.stringify(minuteDraft)}`);
  assert(minuteDraft.draft.scheduleText === "Daily at 10:13", `minute draft should preserve explicit minute: ${minuteDraft.draft.scheduleText}`);
  const created = manager.create(draft.draft);
  assert(created.ok, `create failed: ${JSON.stringify(created)}`);
  const createdFromJson = manager.create({
    title: "整理我的待办",
    prompt: "整理我的待办",
    sessionId: "s1",
    projectId: "p1",
    schedule: {
      type: "daily_window_interval",
      startHour: 9,
      endHour: 12,
      every: 1,
      minute: 0,
    },
  });
  assert(createdFromJson.ok, `create from model JSON failed: ${JSON.stringify(createdFromJson)}`);
  assert(createdFromJson.task.scheduleText === "Daily 09:00-12:00 on the hour", `created JSON task should be readable: ${createdFromJson.task.scheduleText}`);
  created.task.nextRunAt = "2026-01-01T00:00:00.000Z";
  await manager.tick();
  await flushMicrotasks();
  assert(sent.length === 1, "due scheduled task should send exactly once");
  assert(sent[0].opts.scheduledTaskRunId, "scheduled run id should be passed into turn orchestrator");
  // Unattended fire must be non-interactive — no permission prompt can hang it.
  // "plan" never prompts (mutations are denied rather than asked).
  assert(sent[0].opts.permissionMode === "plan",
    `scheduled fire must force plan (non-interactive), got: ${sent[0].opts.permissionMode}`);
  assert(sent[0].opts.queueOrigin === "scheduled_task", `scheduled fire must identify its queue origin: ${sent[0].opts.queueOrigin}`);
  assert(sent[0].opts.queueVisibility === "background", `scheduled fire must stay out of composer queue UI: ${sent[0].opts.queueVisibility}`);
  const runningRun = manager.runs.find((run) => run.id === sent[0].opts.scheduledTaskRunId);
  assert(runningRun?.status === "running", `run should be running: ${JSON.stringify(runningRun)}`);
  manager.completeRun("s1", runningRun.turnId, "turn.completed", {});
  assert(runningRun.status === "succeeded", `run should complete: ${JSON.stringify(runningRun)}`);

  const queuedManager = new ScheduledTaskManager();
  const manualSent = [];
  queuedManager.load();
  queuedManager.start({
    sessionManager: {
      findById: (id) => (id === "s1" ? { id: "s1", projectId: "p1" } : null),
    },
    projectManager: {
      find: () => ({ id: "p1", path: tempRoot }),
    },
    turnOrchestrator: {
      sendUserMessage: async (sessionId, text, files, opts) => {
        manualSent.push({ opts });
        return { ok: true, queued: true, itemId: "queue_1" };
      },
    },
  });
  queuedManager.stop();
  const negatedDraft = await queuedManager.parseDraftSmart({
    text: "知识方案里需要有逐小时预报，不是创建定时任务",
    sessionId: "s1",
    projectId: "p1",
  });
  assert(!negatedDraft.ok && negatedDraft.error === "SCHEDULE_NEGATED", `negated draft should be rejected before model parsing: ${JSON.stringify(negatedDraft)}`);
  const queuedTask = queuedManager.create({
    prompt: "每隔 1 小时检查状态",
    sessionId: "s1",
    projectId: "p1",
  }).task;
  const queued = queuedManager.runNow(queuedTask.id);
  await flushMicrotasks();
  assert(queued.ok, `manual run should queue: ${JSON.stringify(queued)}`);
  // Manual run-now: user is present, keep the session's mode (no override).
  assert(manualSent[0]?.opts.permissionMode === undefined,
    `manual run must not force a permission mode, got: ${manualSent[0]?.opts.permissionMode}`);
  assert(manualSent[0]?.opts.queueVisibility === "background",
    `manual scheduled run must still stay out of composer queue UI, got: ${manualSent[0]?.opts.queueVisibility}`);
  const duplicate = queuedManager.runNow(queuedTask.id);
  assert(!duplicate.ok && duplicate.error === "ALREADY_RUNNING", `duplicate run should be blocked: ${JSON.stringify(duplicate)}`);
  const activeRemove = queuedManager.remove(queuedTask.id);
  assert(!activeRemove.ok && activeRemove.error === "TASK_ACTIVE", `active task removal should be blocked: ${JSON.stringify(activeRemove)}`);
  const queuedRun = queuedManager.runs.at(-1);
  assert(queuedRun.status === "queued", `run should remain queued: ${JSON.stringify(queuedRun)}`);
  const cancelledQueued = queuedManager.completeQueuedRun(queuedRun.id, "turn.interrupted", { errorCode: "QUEUE_CANCELLED" });
  assert(cancelledQueued, "queued run should be cancellable before it starts");
  assert(queuedRun.status === "interrupted", `cancelled queued run should finish interrupted: ${JSON.stringify(queuedRun)}`);
  assert(queuedTask.status === "scheduled", `cancelled queued task should return to scheduled: ${JSON.stringify(queuedTask)}`);
  const rerunAfterCancel = queuedManager.runNow(queuedTask.id);
  await flushMicrotasks();
  assert(rerunAfterCancel.ok, `cancelled queued task should be runnable again: ${JSON.stringify(rerunAfterCancel)}`);
  const failedQueuedRun = queuedManager.runs.at(-1);
  const failedQueued = queuedManager.completeQueuedRun(failedQueuedRun.id, "turn.failed", { errorCode: "NO_SESSION" });
  assert(failedQueued, "queued run should be fail-able when queue dispatch drops it");
  assert(failedQueuedRun.status === "failed" && failedQueuedRun.error === "NO_SESSION", `failed queued run should persist error: ${JSON.stringify(failedQueuedRun)}`);
  const queuedAgain = queuedManager.runNow(queuedTask.id);
  await flushMicrotasks();
  assert(queuedAgain.ok, `failed queued task should be runnable again: ${JSON.stringify(queuedAgain)}`);
  const queuedRunAgain = queuedManager.runs.at(-1);
  queuedManager.markRunStarted(queuedRun.id, "turn_q");
  assert(queuedRun.status === "interrupted", "completed queued runs should not be restarted by stale ids");
  queuedManager.markRunStarted(queuedRunAgain.id, "turn_q");
  queuedManager.completeRun("s1", "turn_q", "turn.interrupted", { errorCode: "USER_STOPPED" });
  assert(queuedRunAgain.status === "interrupted", `queued run should finish interrupted after it starts: ${JSON.stringify(queuedRunAgain)}`);

  const missingScope = queuedManager.create({
    prompt: "每天早上 9 点做不存在的事",
    sessionId: "missing",
    projectId: "p1",
  });
  assert(!missingScope.ok && missingScope.error === "SCOPE_MISSING",
    `missing scope must be rejected before persistence: ${JSON.stringify(missingScope)}`);

  console.log("scheduled-tasks: ok");
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}
