"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { scheduledTasksPath } = require("./config");

const TICK_MS = 60 * 1000;
const MISSED_GRACE_MS = 5 * 1000;
const DEFAULT_PERMISSION_MODE = "read_only";

function nowIso() {
  return new Date().toISOString();
}

function safeText(value, max = 2000) {
  return String(value || "").trim().slice(0, max);
}

function parseChineseNumber(input) {
  const raw = String(input || "").trim();
  if (!raw) return NaN;
  if (/^\d+$/.test(raw)) return Number(raw);
  const map = {
    零: 0,
    一: 1,
    二: 2,
    两: 2,
    三: 3,
    四: 4,
    五: 5,
    六: 6,
    七: 7,
    八: 8,
    九: 9,
    十: 10,
  };
  if (raw === "十") return 10;
  if (raw.startsWith("十")) return 10 + (map[raw[1]] || 0);
  if (raw.endsWith("十")) return (map[raw[0]] || 0) * 10;
  if (raw.includes("十")) {
    const [tens, ones] = raw.split("十");
    return (map[tens] || 0) * 10 + (map[ones] || 0);
  }
  return map[raw] ?? NaN;
}

function parseLooseNumber(input) {
  const raw = String(input || "").trim();
  if (!raw) return NaN;
  const normalized = raw.replace(/[٠-٩]/g, (digit) => String("٠١٢٣٤٥٦٧٨٩".indexOf(digit)));
  if (/^\d+$/.test(normalized)) return Number(normalized);
  const arabic = {
    واحد: 1,
    واحدة: 1,
    اثنين: 2,
    ساعتين: 2,
    دقيقتين: 2,
    يومين: 2,
    ثلاثة: 3,
    ثلاث: 3,
    أربعة: 4,
    اربع: 4,
    خمس: 5,
    خمسة: 5,
    ست: 6,
    ستة: 6,
    سبع: 7,
    سبعة: 7,
    ثمان: 8,
    ثمانية: 8,
    تسع: 9,
    تسعة: 9,
    عشر: 10,
    عشرة: 10,
  };
  return arabic[normalized] ?? parseChineseNumber(normalized);
}

function weekdayToNumber(value) {
  const text = String(value || "").trim().toLowerCase();
  const map = {
    一: 1,
    二: 2,
    三: 3,
    四: 4,
    五: 5,
    六: 6,
    日: 0,
    天: 0,
    "1": 1,
    "2": 2,
    "3": 3,
    "4": 4,
    "5": 5,
    "6": 6,
    "7": 0,
    mon: 1,
    monday: 1,
    tue: 2,
    tuesday: 2,
    wed: 3,
    wednesday: 3,
    thu: 4,
    thursday: 4,
    fri: 5,
    friday: 5,
    sat: 6,
    saturday: 6,
    sun: 0,
    sunday: 0,
    الأحد: 0,
    الاحد: 0,
    اثنين: 1,
    الإثنين: 1,
    الاثنين: 1,
    ثلاثاء: 2,
    الثلاثاء: 2,
    أربعاء: 3,
    الاربعاء: 3,
    الأربعاء: 3,
    خميس: 4,
    الخميس: 4,
    جمعة: 5,
    الجمعة: 5,
    سبت: 6,
    السبت: 6,
  };
  return map[text];
}

function parseTimeOfDay(text) {
  const source = String(text || "");
  const english = source.match(/\b(?:at\s*)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i);
  if (english) {
    let hour = Number(english[1]);
    const minute = english[2] == null ? 0 : Number(english[2]);
    const period = english[3].toLowerCase();
    if (period === "pm" && hour < 12) hour += 12;
    if (period === "am" && hour === 12) hour = 0;
    if (hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59) return { hour, minute };
  }
  const arabic = source.match(/(?:الساعة\s*)?([0-9٠-٩]{1,2})(?::([0-9٠-٩]{2}))?\s*(صباحاً|صباحا|مساءً|مساء)?/i);
  if (arabic && /(?:الساعة|صباح|مساء)/.test(arabic[0])) {
    let hour = parseLooseNumber(arabic[1]);
    const minute = arabic[2] == null ? 0 : parseLooseNumber(arabic[2]);
    const period = arabic[3] || "";
    if (period.startsWith("مساء") && hour < 12) hour += 12;
    if (period.startsWith("صباح") && hour === 12) hour = 0;
    if (hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59) return { hour, minute };
  }
  const match = source.match(/(?:(凌晨|早上|上午|中午|下午|晚上|夜里)\s*(\d{1,2}|[一二两三四五六七八九十]{1,3})(?:[:：点时](\d{1,2}|[一二两三四五六七八九十]{1,3})?)?|(\d{1,2}|[一二两三四五六七八九十]{1,3})\s*[:：点时]\s*(\d{1,2}|[一二两三四五六七八九十]{1,3})?)(?:\s*分)?/);
  if (!match) return null;
  let hour = parseChineseNumber(match[2] || match[4]);
  let minute = (match[3] == null && match[5] == null) ? 0 : parseChineseNumber(match[3] || match[5]);
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;
  const period = match[1] || "";
  if ((period === "下午" || period === "晚上" || period === "夜里") && hour < 12) hour += 12;
  if (period === "中午" && hour < 11) hour += 12;
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  return { hour, minute };
}

function normalizeTime(hour, minute, period = "") {
  let normalizedHour = Number(hour);
  let normalizedMinute = Number(minute);
  if (!Number.isFinite(normalizedHour) || !Number.isFinite(normalizedMinute)) return null;
  if ((period === "下午" || period === "晚上" || period === "夜里") && normalizedHour < 12) normalizedHour += 12;
  if (period === "中午" && normalizedHour < 11) normalizedHour += 12;
  if (normalizedHour < 0 || normalizedHour > 23 || normalizedMinute < 0 || normalizedMinute > 59) return null;
  return { hour: normalizedHour, minute: normalizedMinute };
}

function uniqueSortedTimes(times) {
  const seen = new Set();
  return times
    .filter((time) =>
      time
      && Number.isInteger(Number(time.hour))
      && Number(time.hour) >= 0
      && Number(time.hour) <= 23
      && Number.isInteger(Number(time.minute))
      && Number(time.minute) >= 0
      && Number(time.minute) <= 59)
    .map((time) => ({ hour: Number(time.hour), minute: Number(time.minute) }))
    .filter((time) => {
      const key = `${time.hour}:${time.minute}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => (a.hour * 60 + a.minute) - (b.hour * 60 + b.minute));
}

function finiteInt(value, min, max) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) return null;
  return number;
}

function normalizeScheduleSpec(schedule) {
  if (!schedule || typeof schedule !== "object") return null;
  if (schedule.type === "once") {
    const at = new Date(String(schedule.at || ""));
    if (Number.isNaN(at.getTime())) return null;
    return { type: "once", at: at.toISOString() };
  }
  if (schedule.type === "daily") {
    const hour = finiteInt(schedule.hour, 0, 23);
    const minute = finiteInt(schedule.minute ?? 0, 0, 59);
    if (hour == null || minute == null) return null;
    return { type: "daily", hour, minute };
  }
  if (schedule.type === "daily_times") {
    const times = uniqueSortedTimes(Array.isArray(schedule.times)
      ? schedule.times.map((time) => ({
          hour: finiteInt(time?.hour, 0, 23),
          minute: finiteInt(time?.minute ?? 0, 0, 59),
        }))
      : []);
    if (!times.length) return null;
    return { type: "daily_times", times };
  }
  if (schedule.type === "weekly") {
    const weekday = finiteInt(schedule.weekday, 0, 6);
    const hour = finiteInt(schedule.hour, 0, 23);
    const minute = finiteInt(schedule.minute ?? 0, 0, 59);
    if (weekday == null || hour == null || minute == null) return null;
    return { type: "weekly", weekday, hour, minute };
  }
  if (schedule.type === "weekdays_times") {
    const weekdays = Array.isArray(schedule.weekdays)
      ? [...new Set(schedule.weekdays.map((day) => finiteInt(day, 0, 6)).filter((day) => day != null))].sort((a, b) => a - b)
      : [];
    const times = uniqueSortedTimes(Array.isArray(schedule.times)
      ? schedule.times.map((time) => ({
          hour: finiteInt(time?.hour, 0, 23),
          minute: finiteInt(time?.minute ?? 0, 0, 59),
        }))
      : []);
    if (!weekdays.length || !times.length) return null;
    return { type: "weekdays_times", weekdays, times };
  }
  if (schedule.type === "monthly") {
    const dayOfMonth = finiteInt(schedule.dayOfMonth, 1, 31);
    const hour = finiteInt(schedule.hour, 0, 23);
    const minute = finiteInt(schedule.minute ?? 0, 0, 59);
    if (dayOfMonth == null || hour == null || minute == null) return null;
    return { type: "monthly", dayOfMonth, hour, minute };
  }
  if (schedule.type === "interval") {
    const every = finiteInt(schedule.every, 1, 10000);
    const unit = ["minute", "hour", "day"].includes(schedule.unit) ? schedule.unit : null;
    if (every == null || !unit) return null;
    return { type: "interval", every, unit };
  }
  if (schedule.type === "hourly") {
    const every = finiteInt(schedule.every ?? 1, 1, 24);
    const minute = finiteInt(schedule.minute ?? 0, 0, 59);
    if (every == null || minute == null) return null;
    return { type: "hourly", every, minute };
  }
  if (schedule.type === "daily_window_interval") {
    const startHour = finiteInt(schedule.startHour, 0, 23);
    const startMinute = finiteInt(schedule.startMinute ?? 0, 0, 59);
    const endHour = finiteInt(schedule.endHour, 0, 23);
    const endMinute = finiteInt(schedule.endMinute ?? 0, 0, 59);
    const every = finiteInt(schedule.every ?? 1, 1, 24);
    const minute = finiteInt(schedule.minute ?? startMinute ?? 0, 0, 59);
    if (startHour == null || startMinute == null || endHour == null || endMinute == null || every == null || minute == null) return null;
    if ((endHour * 60 + endMinute) < (startHour * 60 + startMinute)) return null;
    return { type: "daily_window_interval", startHour, startMinute, endHour, endMinute, every, unit: "hour", minute };
  }
  return null;
}

function extractChineseTimeList(text) {
  const source = String(text || "");
  const times = [];
  const pattern = /(?:(凌晨|早上|上午|中午|下午|晚上|夜里)\s*)?(\d{1,2}|[一二两三四五六七八九十]{1,3})\s*(?:(?:[:：]\s*(\d{1,2}|[一二两三四五六七八九十]{1,3}))|(?:[点时]\s*(半|(\d{1,2}|[一二两三四五六七八九十]{1,3})\s*分)?))/g;
  let match = null;
  while ((match = pattern.exec(source))) {
    const hour = parseChineseNumber(match[2]);
    const minute = match[4] === "半" ? 30 : match[3] != null ? parseChineseNumber(match[3]) : match[5] != null ? parseChineseNumber(match[5]) : 0;
    times.push(normalizeTime(hour, minute, match[1] || ""));
  }
  return uniqueSortedTimes(times);
}

function extractChineseHourlyWindow(text) {
  const source = String(text || "");
  if (!/(每(?:个)?整点|每(?:个)?小时|每小时)/.test(source)) return null;
  const number = "(\\d{1,2}|[一二两三四五六七八九十]{1,3})";
  const period = "(凌晨|早上|上午|中午|下午|晚上|夜里)";
  const pattern = new RegExp(`(?:${period}\\s*)?${number}\\s*(?:点|时)?\\s*(?:到|至|[-—~～])\\s*(?:${period}\\s*)?${number}\\s*(?:点|时)?`);
  const match = source.match(pattern);
  if (!match) return null;

  const startPeriod = match[1] || "";
  const startHour = parseChineseNumber(match[2]);
  const endPeriod = match[3] || startPeriod;
  const endHour = parseChineseNumber(match[4]);
  const start = normalizeTime(startHour, 0, startPeriod);
  const end = normalizeTime(endHour, 0, endPeriod);
  if (!start || !end) return null;
  if (end.hour < start.hour || (end.hour === start.hour && end.minute < start.minute)) return null;
  return {
    type: "daily_window_interval",
    startHour: start.hour,
    startMinute: start.minute,
    endHour: end.hour,
    endMinute: end.minute,
    every: 1,
    unit: "hour",
    minute: /半点/.test(source) ? 30 : 0,
  };
}

function startOfMinute(date) {
  const next = new Date(date);
  next.setSeconds(0, 0);
  return next;
}

function nextDaily(schedule, from = new Date()) {
  const next = startOfMinute(from);
  next.setHours(schedule.hour, schedule.minute, 0, 0);
  if (next.getTime() <= from.getTime() + MISSED_GRACE_MS) {
    next.setDate(next.getDate() + 1);
  }
  return next;
}

function nextDailyTimes(schedule, from = new Date()) {
  const times = uniqueSortedTimes(Array.isArray(schedule.times) ? schedule.times : []);
  if (!times.length) return null;
  for (const time of times) {
    const next = startOfMinute(from);
    next.setHours(time.hour, time.minute, 0, 0);
    if (next.getTime() > from.getTime() + MISSED_GRACE_MS) return next;
  }
  const first = times[0];
  const next = startOfMinute(from);
  next.setDate(next.getDate() + 1);
  next.setHours(first.hour, first.minute, 0, 0);
  return next;
}

function nextWeekly(schedule, from = new Date()) {
  const next = startOfMinute(from);
  next.setHours(schedule.hour, schedule.minute, 0, 0);
  const current = next.getDay();
  let delta = (schedule.weekday - current + 7) % 7;
  if (delta === 0 && next.getTime() <= from.getTime() + MISSED_GRACE_MS) delta = 7;
  next.setDate(next.getDate() + delta);
  return next;
}

function nextWeekdaysTimes(schedule, from = new Date()) {
  const weekdays = Array.isArray(schedule.weekdays) ? schedule.weekdays : [];
  const times = uniqueSortedTimes(Array.isArray(schedule.times) ? schedule.times : []);
  if (!weekdays.length || !times.length) return null;
  for (let dayOffset = 0; dayOffset <= 7; dayOffset += 1) {
    const base = startOfMinute(from);
    base.setDate(base.getDate() + dayOffset);
    if (!weekdays.includes(base.getDay())) continue;
    for (const time of times) {
      const next = new Date(base);
      next.setHours(time.hour, time.minute, 0, 0);
      if (next.getTime() > from.getTime() + MISSED_GRACE_MS) return next;
    }
  }
  return null;
}

function nextMonthly(schedule, from = new Date()) {
  const day = Math.min(31, Math.max(1, Number(schedule.dayOfMonth)));
  for (let monthOffset = 0; monthOffset <= 13; monthOffset += 1) {
    const next = startOfMinute(from);
    next.setMonth(next.getMonth() + monthOffset, 1);
    const lastDay = new Date(next.getFullYear(), next.getMonth() + 1, 0).getDate();
    next.setDate(Math.min(day, lastDay));
    next.setHours(schedule.hour, schedule.minute, 0, 0);
    if (next.getTime() > from.getTime() + MISSED_GRACE_MS) return next;
  }
  return null;
}

function nextInterval(schedule, from = new Date()) {
  const unitMs = schedule.unit === "minute"
    ? 60 * 1000
    : schedule.unit === "day"
      ? 24 * 60 * 60 * 1000
      : 60 * 60 * 1000;
  return new Date(from.getTime() + Math.max(1, schedule.every) * unitMs);
}

function nextHourly(schedule, from = new Date()) {
  const every = Math.max(1, Number(schedule.every) || 1);
  const minute = Number.isFinite(Number(schedule.minute)) ? Number(schedule.minute) : 0;
  const next = startOfMinute(from);
  next.setMinutes(Math.min(59, Math.max(0, minute)), 0, 0);
  if (next.getTime() <= from.getTime() + MISSED_GRACE_MS) {
    next.setHours(next.getHours() + every);
  }
  return next;
}

function nextDailyWindowInterval(schedule, from = new Date()) {
  const every = Math.max(1, Number(schedule.every) || 1);
  const minute = Number.isFinite(Number(schedule.minute)) ? Math.min(59, Math.max(0, Number(schedule.minute))) : 0;
  const startHour = Math.min(23, Math.max(0, Number(schedule.startHour)));
  const endHour = Math.min(23, Math.max(0, Number(schedule.endHour)));
  if (!Number.isFinite(startHour) || !Number.isFinite(endHour) || endHour < startHour) return null;

  const candidate = startOfMinute(from);
  candidate.setMinutes(minute, 0, 0);
  if (candidate.getHours() < startHour) {
    candidate.setHours(startHour);
    return candidate;
  }
  if (candidate.getHours() > endHour || candidate.getTime() <= from.getTime() + MISSED_GRACE_MS) {
    candidate.setHours(candidate.getHours() + every);
  }
  if (candidate.getHours() <= endHour && candidate.getHours() >= startHour) return candidate;

  const tomorrow = startOfMinute(from);
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(startHour, minute, 0, 0);
  return tomorrow;
}

function computeNextRunAt(schedule, from = new Date()) {
  schedule = normalizeScheduleSpec(schedule);
  if (!schedule) return null;
  if (schedule.type === "once") return new Date(schedule.at).toISOString();
  if (schedule.type === "daily") return nextDaily(schedule, from).toISOString();
  if (schedule.type === "daily_times") return nextDailyTimes(schedule, from)?.toISOString() || null;
  if (schedule.type === "weekly") return nextWeekly(schedule, from).toISOString();
  if (schedule.type === "weekdays_times") return nextWeekdaysTimes(schedule, from)?.toISOString() || null;
  if (schedule.type === "monthly") return nextMonthly(schedule, from)?.toISOString() || null;
  if (schedule.type === "interval") return nextInterval(schedule, from).toISOString();
  if (schedule.type === "hourly") return nextHourly(schedule, from).toISOString();
  if (schedule.type === "daily_window_interval") return nextDailyWindowInterval(schedule, from)?.toISOString() || null;
  return null;
}

function describeSchedule(schedule) {
  schedule = normalizeScheduleSpec(schedule);
  if (!schedule) return "";
  if (schedule.type === "once") {
    return `一次性 ${new Date(schedule.at).toLocaleString("zh-CN", { hour12: false })}`;
  }
  if (schedule.type === "daily") {
    return `每天 ${String(schedule.hour).padStart(2, "0")}:${String(schedule.minute).padStart(2, "0")}`;
  }
  if (schedule.type === "daily_times") {
    const times = uniqueSortedTimes(Array.isArray(schedule.times) ? schedule.times : []);
    return `每天 ${times.map((time) => `${String(time.hour).padStart(2, "0")}:${String(time.minute).padStart(2, "0")}`).join(" / ")}`;
  }
  if (schedule.type === "weekly") {
    const names = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
    return `每${names[schedule.weekday] || "周"} ${String(schedule.hour).padStart(2, "0")}:${String(schedule.minute).padStart(2, "0")}`;
  }
  if (schedule.type === "weekdays_times") {
    const names = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
    const weekdays = schedule.weekdays.map((day) => names[day]).join(" / ");
    const times = schedule.times.map((time) => `${String(time.hour).padStart(2, "0")}:${String(time.minute).padStart(2, "0")}`).join(" / ");
    return `每${weekdays} ${times}`;
  }
  if (schedule.type === "monthly") {
    return `每月 ${schedule.dayOfMonth} 日 ${String(schedule.hour).padStart(2, "0")}:${String(schedule.minute).padStart(2, "0")}`;
  }
  if (schedule.type === "interval") {
    const unit = schedule.unit === "minute" ? "分钟" : schedule.unit === "day" ? "天" : "小时";
    return `每隔 ${schedule.every} ${unit}`;
  }
  if (schedule.type === "hourly") {
    const minute = Number(schedule.minute) || 0;
    if (minute === 0) return schedule.every > 1 ? `每隔 ${schedule.every} 小时整点` : "每小时整点";
    return schedule.every > 1
      ? `每隔 ${schedule.every} 小时 ${String(minute).padStart(2, "0")} 分`
      : `每小时 ${String(minute).padStart(2, "0")} 分`;
  }
  if (schedule.type === "daily_window_interval") {
    const start = `${String(schedule.startHour).padStart(2, "0")}:${String(schedule.startMinute || 0).padStart(2, "0")}`;
    const end = `${String(schedule.endHour).padStart(2, "0")}:${String(schedule.endMinute || 0).padStart(2, "0")}`;
    const minute = Number(schedule.minute) || 0;
    const cadence = minute === 0 ? "每小时整点" : `每小时 ${String(minute).padStart(2, "0")} 分`;
    return `每天 ${start}-${end} ${cadence}`;
  }
  return "";
}

function stripScheduleWords(text) {
  return String(text || "")
    .replace(/以后/g, "")
    .replace(/请?帮我/g, "")
    .replace(/每(?:周|星期)[一二三四五六日天1-7]\s*(?:到|至|-|~|～)\s*(?:周|星期)?[一二三四五六日天1-7]/g, "")
    .replace(/(每天|每日|天天|每(?:个)?整点|每(?:个)?小时|每周[一二三四五六日天1-7]?|每星期[一二三四五六日天1-7]?|每隔\s*[\d一二两三四五六七八九十]+\s*(分钟|小时|天)|every\s+\d+\s*(minutes?|hours?|days?)|every\s+hour|hourly|every\s+day|daily|every\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday))/gi, "")
    .replace(/(كل\s+(ساعة|يوم|الأحد|الاحد|اثنين|الإثنين|الاثنين|ثلاثاء|الثلاثاء|أربعاء|الأربعاء|الاربعاء|خميس|الخميس|جمعة|الجمعة|سبت|السبت)|كل\s*([0-9٠-٩]+|واحد|واحدة|اثنين|ساعتين|دقيقتين|يومين|ثلاثة|ثلاث|أربعة|اربع|خمسة|خمس|ستة|ست|سبعة|سبع|ثمانية|ثمان|تسعة|تسع|عشرة|عشر)\s*(دقيقة|دقائق|ساعة|ساعات|يوم|أيام))/gi, "")
    .replace(/(?:الساعة\s*)[0-9٠-٩]{1,2}(?::[0-9٠-٩]{2})?\s*(?:صباحاً|صباحا|مساءً|مساء)?|[0-9٠-٩]{1,2}(?::[0-9٠-٩]{2})?\s*(?:صباحاً|صباحا|مساءً|مساء)/gi, "")
    .replace(/(?:(凌晨|早上|上午|中午|下午|晚上|夜里)\s*)?(\d{1,2}|[一二两三四五六七八九十]{1,3})\s*(?:点|时)?\s*(?:到|至|[-—~～])\s*(?:(凌晨|早上|上午|中午|下午|晚上|夜里)\s*)?(\d{1,2}|[一二两三四五六七八九十]{1,3})\s*(?:点|时)?/g, "")
    .replace(/(?:(凌晨|早上|上午|中午|下午|晚上|夜里)\s*)?(\d{1,2}|[一二两三四五六七八九十]{1,3})\s*(?:(?:[:：]\s*(\d{1,2}|[一二两三四五六七八九十]{1,3}))|(?:[点时]\s*(半|(\d{1,2}|[一二两三四五六七八九十]{1,3})\s*分)?))/g, "")
    .replace(/[，,。.\s]+/g, " ")
    .trim();
}

function sanitizeScheduledTaskPrompt(text) {
  let output = stripScheduleWords(text);
  output = output
    .replace(/^(?:好的|可以|请|麻烦|帮我|为我|给我|我来|让我)?\s*(?:创建|建立|新增|设置|安排|配置|生成)\s*(?:一个|一条|每日|每天|定时|自动|计划|任务|提醒|的|\s)*/i, "")
    .replace(/^(?:定时|自动|计划)?任务[:：\s]*/i, "")
    .replace(/[，,。.\s]+/g, " ")
    .trim();
  return output || stripScheduleWords(text) || safeText(text, 4000);
}

function parseScheduleFromText(text, from = new Date()) {
  const source = safeText(text, 2000);

  const hourlyWindow = extractChineseHourlyWindow(source);
  if (hourlyWindow) {
    return {
      ok: true,
      schedule: hourlyWindow,
      scheduleText: describeSchedule(hourlyWindow),
      nextRunAt: computeNextRunAt(hourlyWindow, from),
    };
  }

  if (/(每天|每日|天天)/.test(source)) {
    const times = extractChineseTimeList(source);
    if (times.length > 1) {
      const schedule = { type: "daily_times", times };
      return { ok: true, schedule, scheduleText: describeSchedule(schedule), nextRunAt: computeNextRunAt(schedule, from) };
    }
  }

  const time = parseTimeOfDay(source) || { hour: 9, minute: 0 };

  if (/每(?:个)?整点|每(?:个)?小时|每小时/.test(source)) {
    const schedule = { type: "hourly", every: 1, minute: /半点/.test(source) ? 30 : 0 };
    return { ok: true, schedule, scheduleText: describeSchedule(schedule), nextRunAt: computeNextRunAt(schedule, from) };
  }

  const interval = source.match(/(?:每隔|每)\s*(\d+|[一二两三四五六七八九十]{1,3})\s*(分钟|小时|天)/);
  if (interval) {
    const every = parseChineseNumber(interval[1]);
    const unit = interval[2] === "分钟" ? "minute" : interval[2] === "天" ? "day" : "hour";
    if (Number.isFinite(every) && every > 0) {
      const schedule = { type: "interval", every, unit };
      return { ok: true, schedule, scheduleText: describeSchedule(schedule), nextRunAt: computeNextRunAt(schedule, from) };
    }
  }

  const englishInterval = source.match(/every\s+(\d+)\s*(minutes?|hours?|days?)/i);
  if (englishInterval) {
    const every = Number(englishInterval[1]);
    const unitText = englishInterval[2].toLowerCase();
    const unit = unitText.startsWith("minute") ? "minute" : unitText.startsWith("day") ? "day" : "hour";
    const schedule = { type: "interval", every, unit };
    return { ok: true, schedule, scheduleText: describeSchedule(schedule), nextRunAt: computeNextRunAt(schedule, from) };
  }

  if (/\b(every\s+hour|hourly)\b/i.test(source)) {
    const schedule = { type: "hourly", every: 1, minute: /\bhalf\s+past\b/i.test(source) ? 30 : 0 };
    return { ok: true, schedule, scheduleText: describeSchedule(schedule), nextRunAt: computeNextRunAt(schedule, from) };
  }

  const arabicInterval = source.match(/كل\s*([0-9٠-٩]+|واحد|واحدة|اثنين|ساعتين|دقيقتين|يومين|ثلاثة|ثلاث|أربعة|اربع|خمسة|خمس|ستة|ست|سبعة|سبع|ثمانية|ثمان|تسعة|تسع|عشرة|عشر)\s*(دقيقة|دقائق|ساعة|ساعات|يوم|أيام)/i);
  if (arabicInterval) {
    const every = parseLooseNumber(arabicInterval[1]);
    const unitText = arabicInterval[2];
    const unit = unitText.startsWith("دقيقة") || unitText.startsWith("دقائق") ? "minute" : unitText.startsWith("يوم") || unitText.startsWith("أيام") ? "day" : "hour";
    if (Number.isFinite(every) && every > 0) {
      const schedule = { type: "interval", every, unit };
      return { ok: true, schedule, scheduleText: describeSchedule(schedule), nextRunAt: computeNextRunAt(schedule, from) };
    }
  }

  if (/كل\s+ساعة/.test(source)) {
    const schedule = { type: "hourly", every: 1, minute: 0 };
    return { ok: true, schedule, scheduleText: describeSchedule(schedule), nextRunAt: computeNextRunAt(schedule, from) };
  }

  const englishWeekly = source.match(/every\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tue|wed|thu|fri|sat|sun)\b/i);
  if (englishWeekly) {
    const weekday = weekdayToNumber(englishWeekly[1]);
    if (weekday != null) {
      const schedule = { type: "weekly", weekday, hour: time.hour, minute: time.minute };
      return { ok: true, schedule, scheduleText: describeSchedule(schedule), nextRunAt: computeNextRunAt(schedule, from) };
    }
  }

  const arabicWeekly = source.match(/كل\s+(الأحد|الاحد|اثنين|الإثنين|الاثنين|ثلاثاء|الثلاثاء|أربعاء|الأربعاء|الاربعاء|خميس|الخميس|جمعة|الجمعة|سبت|السبت)/i);
  if (arabicWeekly) {
    const weekday = weekdayToNumber(arabicWeekly[1]);
    if (weekday != null) {
      const schedule = { type: "weekly", weekday, hour: time.hour, minute: time.minute };
      return { ok: true, schedule, scheduleText: describeSchedule(schedule), nextRunAt: computeNextRunAt(schedule, from) };
    }
  }

  const weekly = source.match(/每(?:周|星期)\s*([一二三四五六日天1-7])/);
  if (weekly) {
    const weekday = weekdayToNumber(weekly[1]);
    if (weekday != null) {
      const schedule = { type: "weekly", weekday, hour: time.hour, minute: time.minute };
      return { ok: true, schedule, scheduleText: describeSchedule(schedule), nextRunAt: computeNextRunAt(schedule, from) };
    }
  }

  if (/(每天|每日|天天)/.test(source)) {
    const schedule = { type: "daily", hour: time.hour, minute: time.minute };
    return { ok: true, schedule, scheduleText: describeSchedule(schedule), nextRunAt: computeNextRunAt(schedule, from) };
  }

  if (/\b(every day|daily)\b/i.test(source)) {
    const schedule = { type: "daily", hour: time.hour, minute: time.minute };
    return { ok: true, schedule, scheduleText: describeSchedule(schedule), nextRunAt: computeNextRunAt(schedule, from) };
  }

  if (/كل\s+يوم|يومياً|يوميا/.test(source)) {
    const schedule = { type: "daily", hour: time.hour, minute: time.minute };
    return { ok: true, schedule, scheduleText: describeSchedule(schedule), nextRunAt: computeNextRunAt(schedule, from) };
  }

  return { ok: false, error: "SCHEDULE_NOT_FOUND" };
}

function buildTaskPrompt(task) {
  const cleanedPrompt = sanitizeScheduledTaskPrompt(task.prompt);
  return [
    `【自动任务执行】`,
    `这是 Lily Workbench 已按计划触发的一次运行，不是创建或修改定时任务的请求。`,
    `任务：${task.title}`,
    "",
    "任务内容：",
    cleanedPrompt,
    "",
    "执行边界：只完成“任务内容”，不要创建、修改、删除或写入任何定时任务配置。",
  ].join("\n");
}

class ScheduledTaskManager {
  constructor() {
    this.tasks = [];
    this.runs = [];
    this.ctx = null;
    this._timer = null;
    this._runningRunIds = new Set();
  }

  load() {
    let parsed = null;
    try {
      parsed = JSON.parse(fs.readFileSync(scheduledTasksPath(), "utf8"));
    } catch {
      parsed = null;
    }
    this.tasks = Array.isArray(parsed?.tasks) ? parsed.tasks.map((task) => this._normalizeTask(task)).filter(Boolean) : [];
    this.runs = Array.isArray(parsed?.runs) ? parsed.runs.slice(-300) : [];
    const now = nowIso();
    for (const run of this.runs) {
      if (run.status === "running" || run.status === "queued") {
        run.status = "interrupted";
        run.finishedAt = now;
        run.error = "应用关闭或重启，自动任务已中断。";
      }
    }
    this.save();
  }

  start(ctx) {
    this.ctx = ctx;
    this.stop();
    this._timer = setInterval(() => void this.tick(), TICK_MS);
    setTimeout(() => void this.tick({ startup: true }), 1200);
  }

  stop() {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
  }

  save() {
    const filePath = scheduledTasksPath();
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify({ tasks: this.tasks, runs: this.runs.slice(-300) }, null, 2), "utf8");
  }

  parseDraft({ text, sessionId, projectId }) {
    const prompt = safeText(text, 4000);
    if (!prompt) return { ok: false, error: "EMPTY" };
    const parsed = parseScheduleFromText(prompt);
    if (!parsed.ok) return parsed;
    const taskPrompt = sanitizeScheduledTaskPrompt(prompt);
    const title = taskPrompt.slice(0, 48) || "自动任务";
    return {
      ok: true,
      draft: {
        title,
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

  async parseDraftSmart({ text, sessionId, projectId }) {
    const prompt = safeText(text, 4000);
    if (!prompt) return { ok: false, error: "EMPTY" };
    const modelParser = this.aiDraftParser || require("./scheduled-task-ai-draft").parseScheduledTaskDraftWithModel;
    const modelResult = await modelParser({
      text: prompt,
      sessionId,
      projectId,
      now: nowIso(),
    });
    if (modelResult?.ok) {
      return { ...modelResult, source: modelResult.source || "model" };
    }
    const fallback = this.parseDraft({ text: prompt, sessionId, projectId });
    if (fallback?.ok) {
      return {
        ...fallback,
        source: "local_fallback",
        modelError: modelResult?.error || null,
      };
    }
    return {
      ok: false,
      error: modelResult?.error || fallback?.error || "SCHEDULE_NOT_FOUND",
      fallbackError: fallback?.error || null,
    };
  }

  create(payload = {}) {
    const rawPrompt = safeText(payload.prompt, 4000);
    const prompt = sanitizeScheduledTaskPrompt(rawPrompt);
    const title = safeText(payload.title, 80) || prompt.slice(0, 48) || "自动任务";
    const normalizedSchedule = normalizeScheduleSpec(payload.schedule);
    const parsed = normalizedSchedule
      ? { ok: true, schedule: normalizedSchedule, scheduleText: describeSchedule(normalizedSchedule), nextRunAt: computeNextRunAt(normalizedSchedule) }
      : parseScheduleFromText(payload.scheduleText || rawPrompt || prompt);
    if (!prompt) return { ok: false, error: "EMPTY" };
    if (!payload.sessionId || !payload.projectId) return { ok: false, error: "MISSING_SCOPE" };
    if (!parsed.ok || !parsed.nextRunAt) return { ok: false, error: parsed.error || "INVALID_SCHEDULE" };
    const now = nowIso();
    const task = this._normalizeTask({
      id: `sched_${crypto.randomUUID()}`,
      workspaceId: payload.projectId,
      projectId: payload.projectId,
      sessionId: payload.sessionId,
      title,
      prompt,
      schedule: parsed.schedule,
      scheduleText: payload.scheduleText || parsed.scheduleText,
      permissionMode: payload.permissionMode || DEFAULT_PERMISSION_MODE,
      enabled: payload.enabled !== false,
      status: "scheduled",
      lastRunAt: null,
      nextRunAt: parsed.nextRunAt,
      missedRunPolicy: "run_once_on_launch",
      createdAt: now,
      updatedAt: now,
    });
    this.tasks.push(task);
    this.save();
    return { ok: true, task };
  }

  list(filter = {}) {
    const sessionId = filter.sessionId ? String(filter.sessionId) : "";
    const projectId = filter.projectId ? String(filter.projectId) : "";
    return {
      ok: true,
      tasks: this.tasks
        .filter((task) => !sessionId || task.sessionId === sessionId)
        .filter((task) => !projectId || task.projectId === projectId)
        .map((task) => ({ ...task, lastRun: this.runs.filter((run) => run.taskId === task.id).at(-1) || null })),
    };
  }

  setEnabled(taskId, enabled) {
    const task = this._findTask(taskId);
    if (!task) return { ok: false, error: "NOT_FOUND" };
    task.enabled = Boolean(enabled);
    task.status = task.enabled ? "scheduled" : "paused";
    task.updatedAt = nowIso();
    if (task.enabled && !task.nextRunAt) task.nextRunAt = computeNextRunAt(task.schedule);
    this.save();
    return { ok: true, task };
  }

  remove(taskId) {
    const existing = this._findTask(taskId);
    if (!existing) return { ok: false, error: "NOT_FOUND" };
    if (existing.status === "queued" || existing.status === "running") {
      return { ok: false, error: "TASK_ACTIVE" };
    }
    const before = this.tasks.length;
    this.tasks = this.tasks.filter((task) => task.id !== taskId);
    if (before === this.tasks.length) return { ok: false, error: "NOT_FOUND" };
    this.save();
    return { ok: true };
  }

  runNow(taskId) {
    const task = this._findTask(taskId);
    if (!task) return { ok: false, error: "NOT_FOUND" };
    return this._runTask(task, { manual: true });
  }

  async tick() {
    const now = Date.now();
    for (const task of this.tasks) {
      if (!task.enabled) continue;
      if (task.status === "queued" || task.status === "running") continue;
      if (!task.nextRunAt) {
        task.nextRunAt = computeNextRunAt(task.schedule);
        continue;
      }
      if (Date.parse(task.nextRunAt) > now) continue;
      await this._runTask(task, { scheduled: true });
    }
  }

  completeRun(sessionId, turnId, terminalType, payload = {}) {
    const run = [...this.runs].reverse().find(
      (item) => item.sessionId === sessionId && item.turnId === turnId && (item.status === "running" || item.status === "queued"),
    );
    if (!run) return false;
    run.status = terminalType === "turn.completed" ? "succeeded" : terminalType.replace(/^turn\./, "");
    run.finishedAt = nowIso();
    run.error = terminalType === "turn.completed" ? null : payload?.error || payload?.errorCode || terminalType;
    this._runningRunIds.delete(run.id);
    const task = this._findTask(run.taskId);
    if (task) {
      task.status = task.enabled ? "scheduled" : "paused";
      task.lastRunAt = run.finishedAt;
      task.nextRunAt = task.enabled ? computeNextRunAt(task.schedule, new Date()) : null;
      task.updatedAt = nowIso();
    }
    this.save();
    return true;
  }

  _runTask(task, opts = {}) {
    if (!this.ctx?.turnOrchestrator) return { ok: false, error: "NOT_READY" };
    if (task.status === "queued" || task.status === "running") {
      return { ok: false, error: "ALREADY_RUNNING" };
    }
    const session = this.ctx.sessionManager?.findById?.(task.sessionId);
    const project = this.ctx.projectManager?.find?.(task.projectId);
    if (!session || !project) {
      task.enabled = false;
      task.status = "paused";
      task.updatedAt = nowIso();
      const run = this._appendRun(task, "skipped", {
        error: !session ? "原会话不存在，自动任务已暂停。" : "原工作区不存在，自动任务已暂停。",
      });
      this.save();
      return { ok: false, error: "SCOPE_MISSING", run };
    }

    const run = this._appendRun(task, "queued", { manual: Boolean(opts.manual) });
    task.status = "queued";
    task.updatedAt = nowIso();
    task.nextRunAt = computeNextRunAt(task.schedule, new Date());
    this.save();
    const resultPromise = this.ctx.turnOrchestrator.sendUserMessage(task.sessionId, buildTaskPrompt(task), [], {
      recordUser: true,
      spawnEngine: true,
      skipVision: true,
      skipDocument: true,
      scheduledTaskId: task.id,
      scheduledTaskRunId: run.id,
      scheduledTaskTitle: task.title,
    });
    Promise.resolve(resultPromise)
      .then((result) => {
        if (!result?.ok) {
          run.status = "failed";
          run.finishedAt = nowIso();
          run.error = result?.detail || result?.error || "自动任务启动失败。";
          task.status = task.enabled ? "scheduled" : "paused";
          this.save();
          return;
        }
        if (result.queued) {
          run.status = "queued";
          run.queueItemId = result.itemId || null;
        } else {
          run.status = "running";
          run.turnId = result.turnId || null;
          this._runningRunIds.add(run.id);
        }
        this.save();
      })
      .catch((err) => {
        run.status = "failed";
        run.finishedAt = nowIso();
        run.error = err?.message || "自动任务启动失败。";
        task.status = task.enabled ? "scheduled" : "paused";
        this.save();
      });
    return { ok: true, queued: true, run };
  }

  markRunStarted(runId, turnId) {
    const run = this.runs.find((item) => item.id === runId);
    if (!run) return false;
    run.status = "running";
    run.turnId = turnId || run.turnId || null;
    this._runningRunIds.add(run.id);
    const task = this._findTask(run.taskId);
    if (task) task.status = "running";
    this.save();
    return true;
  }

  _appendRun(task, status, extra = {}) {
    const run = {
      id: `run_${crypto.randomUUID()}`,
      taskId: task.id,
      sessionId: task.sessionId,
      projectId: task.projectId,
      status,
      startedAt: nowIso(),
      finishedAt: status === "skipped" ? nowIso() : null,
      turnId: null,
      error: extra.error || null,
      manual: Boolean(extra.manual),
    };
    this.runs.push(run);
    if (this.runs.length > 300) this.runs.splice(0, this.runs.length - 300);
    return run;
  }

  _normalizeTask(task) {
    if (!task || typeof task !== "object") return null;
    const schedule = normalizeScheduleSpec(task.schedule);
    const id = String(task.id || "").trim() || `sched_${crypto.randomUUID()}`;
    const projectId = String(task.projectId || task.workspaceId || "").trim();
    const sessionId = String(task.sessionId || "").trim();
    const prompt = safeText(task.prompt, 4000);
    if (!projectId || !sessionId || !prompt || !schedule) return null;
    const enabled = task.enabled !== false;
    return {
      id,
      workspaceId: projectId,
      projectId,
      sessionId,
      title: safeText(task.title, 80) || "自动任务",
      prompt,
      schedule,
      scheduleText: safeText(task.scheduleText, 120) || describeSchedule(schedule),
      permissionMode: task.permissionMode || DEFAULT_PERMISSION_MODE,
      enabled,
      status: enabled ? (task.status === "running" || task.status === "queued" ? "scheduled" : task.status || "scheduled") : "paused",
      lastRunAt: task.lastRunAt || null,
      nextRunAt: enabled ? (task.nextRunAt || computeNextRunAt(schedule)) : null,
      missedRunPolicy: task.missedRunPolicy || "run_once_on_launch",
      createdAt: task.createdAt || nowIso(),
      updatedAt: task.updatedAt || nowIso(),
    };
  }

  _findTask(taskId) {
    const id = String(taskId || "");
    return this.tasks.find((task) => task.id === id) || null;
  }
}

module.exports = {
  ScheduledTaskManager,
  buildTaskPrompt,
  computeNextRunAt,
  describeSchedule,
  normalizeScheduleSpec,
  parseScheduleFromText,
  sanitizeScheduledTaskPrompt,
};
