const DEFAULT_RECENT_LIMIT = 3;
const SECOND_MS = 1_000;
const MINUTE_MS = 60 * SECOND_MS;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const MONTH_MS = 30 * DAY_MS;
const YEAR_MS = 365 * DAY_MS;
const ISO_WITH_TIMEZONE_PATTERN =
  /^(?<year>\d{4})-(?<month>\d{2})-(?<day>\d{2})T(?<hour>\d{2}):(?<minute>\d{2})(?::(?<second>\d{2})(?:\.\d+)?)?(?:Z|[+-](?<offsetHour>\d{2}):(?<offsetMinute>\d{2}))$/i;

function isValidIsoMatch(match) {
  const {
    year: yearText,
    month: monthText,
    day: dayText,
    hour: hourText,
    minute: minuteText,
    second: secondText,
    offsetHour: offsetHourText,
    offsetMinute: offsetMinuteText,
  } = match.groups;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText ?? 0);

  if (month < 1 || month > 12) return false;
  if (hour > 23 || minute > 59 || second > 59) return false;

  const calendarDate = new Date(0);
  calendarDate.setUTCHours(0, 0, 0, 0);
  calendarDate.setUTCFullYear(year, month - 1, day);
  if (
    calendarDate.getUTCFullYear() !== year
    || calendarDate.getUTCMonth() !== month - 1
    || calendarDate.getUTCDate() !== day
  ) {
    return false;
  }

  if (offsetHourText !== undefined) {
    const offsetHour = Number(offsetHourText);
    const offsetMinute = Number(offsetMinuteText);
    if (offsetHour > 23 || offsetMinute > 59) return false;
  }
  return true;
}

function timestampValue(value) {
  if (value instanceof Date) {
    const timestamp = value.getTime();
    return Number.isFinite(timestamp) ? timestamp : null;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value !== "string" || !value.trim()) return null;
  const normalized = value.trim();
  const match = ISO_WITH_TIMEZONE_PATTERN.exec(normalized);
  if (!match || !isValidIsoMatch(match)) return null;
  const timestamp = Date.parse(normalized);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function sessionTimestamp(session) {
  const updatedAt = timestampValue(session?.updatedAt);
  return updatedAt === null ? timestampValue(session?.createdAt) : updatedAt;
}

function normalizedLimit(limit) {
  if (typeof limit !== "number" || !Number.isFinite(limit)) return DEFAULT_RECENT_LIMIT;
  return Math.max(0, Math.floor(limit));
}

function compareSessionEntries(a, b) {
  if (a.timestamp === null && b.timestamp === null) return a.index - b.index;
  if (a.timestamp === null) return 1;
  if (b.timestamp === null) return -1;
  return b.timestamp - a.timestamp || a.index - b.index;
}

/**
 * Return a new session list with the most recently used session first.
 * Invalid timestamps keep their original relative order at the end so a
 * malformed legacy record can never make the sidebar unstable.
 */
export function sortSessionsByRecency(sessions) {
  const source = Array.isArray(sessions) ? sessions : [];
  return source
    .map((session, index) => ({
      session,
      index,
      timestamp: sessionTimestamp(session),
    }))
    .sort(compareSessionEntries)
    .map(({ session }) => session);
}

export function recentSessions(project, limit = DEFAULT_RECENT_LIMIT) {
  const sessions = Array.isArray(project?.sessions) ? project.sessions : [];
  return sortSessionsByRecency(sessions)
    .slice(0, normalizedLimit(limit))
}

export function latestSession(project) {
  return recentSessions(project, 1)[0] || null;
}

function roundedRelativeValue(diffMs, unitMs) {
  const magnitude = Math.round(Math.abs(diffMs) / unitMs);
  if (magnitude === 0) return 0;
  return diffMs < 0 ? -magnitude : magnitude;
}

function roundedRelativeUnit(diffMs, unitMs, unit, capacity, nextUnit) {
  const value = roundedRelativeValue(diffMs, unitMs);
  if (capacity && Math.abs(value) >= capacity) {
    return { value: value < 0 ? -1 : 1, unit: nextUnit };
  }
  return { value, unit };
}

export function relativeTimeValue(value, nowMs = Date.now()) {
  const timestamp = timestampValue(value);
  if (timestamp === null || !Number.isFinite(nowMs)) return null;

  const diffMs = timestamp - nowMs;
  const absoluteMs = Math.abs(diffMs);
  if (absoluteMs < MINUTE_MS) return { value: 0, unit: "second" };
  if (absoluteMs < HOUR_MS) {
    return roundedRelativeUnit(diffMs, MINUTE_MS, "minute", 60, "hour");
  }
  if (absoluteMs < DAY_MS) {
    return roundedRelativeUnit(diffMs, HOUR_MS, "hour", 24, "day");
  }
  if (absoluteMs < MONTH_MS) {
    return roundedRelativeUnit(diffMs, DAY_MS, "day", 30, "month");
  }
  if (absoluteMs < YEAR_MS) {
    return roundedRelativeUnit(diffMs, MONTH_MS, "month", 12, "year");
  }
  return { value: roundedRelativeValue(diffMs, YEAR_MS), unit: "year" };
}

export function searchWorkspaceTargets(projects, query) {
  const needle = String(query ?? "").trim().toLowerCase();
  if (!needle) return { workspaces: [], sessions: [] };

  const sourceProjects = Array.isArray(projects) ? projects : [];
  const workspaces = [];
  const sessions = [];

  sourceProjects.forEach((project, projectIndex) => {
    const workspaceText = `${project?.name || ""} ${project?.path || ""}`.toLowerCase();
    if (workspaceText.includes(needle)) workspaces.push(project);

    const projectSessions = Array.isArray(project?.sessions) ? project.sessions : [];
    projectSessions.forEach((session, sessionIndex) => {
      const title = String(session?.title || "").toLowerCase();
      if (!title.includes(needle)) return;
      sessions.push({
        project,
        session,
        projectIndex,
        sessionIndex,
        timestamp: sessionTimestamp(session),
      });
    });
  });

  sessions.sort((a, b) => {
    if (a.timestamp === null && b.timestamp !== null) return 1;
    if (a.timestamp !== null && b.timestamp === null) return -1;
    if (a.timestamp !== null && b.timestamp !== null && a.timestamp !== b.timestamp) {
      return b.timestamp - a.timestamp;
    }
    return a.projectIndex - b.projectIndex || a.sessionIndex - b.sessionIndex;
  });

  return {
    workspaces,
    sessions: sessions.map(({ project, session }) => ({ project, session })),
  };
}

export function sessionRelativeValue(session, nowMs) {
  const updated = relativeTimeValue(session?.updatedAt, nowMs);
  return updated || relativeTimeValue(session?.createdAt, nowMs);
}
