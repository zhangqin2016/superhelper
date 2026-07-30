"use strict";

const { types } = require("node:util");
const { isWellFormedUtf16 } = require("./macro-unicode");

const ALLOWED_KEYS = new Set([
  "char", "idleDuration", "locale", "now", "original", "seed", "timeZone", "user",
]);
const DANGEROUS_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const STRING_KEYS = new Set(["char", "locale", "original", "seed", "timeZone", "user"]);
const MAX_DATE_MILLISECONDS = 8.64e15;
// String snapshots use canonical UTC ISO with optional 1-3 digit milliseconds.
const ISO_UTC_INSTANT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z$/;

function invalid() {
  return { ok: false };
}

function parseNow(value) {
  let milliseconds;
  if (value instanceof Date) milliseconds = Date.prototype.getTime.call(value);
  else if (typeof value === "number") milliseconds = value;
  else if (typeof value === "string") {
    const match = ISO_UTC_INSTANT.exec(value);
    if (!match) return null;
    const components = match.slice(1, 7).map(Number);
    const [year, month, day, hour, minute, second] = components;
    const millisecond = Number((match[7] || "").padEnd(3, "0"));
    const instant = new Date(0);
    instant.setUTCFullYear(year, month - 1, day);
    instant.setUTCHours(hour, minute, second, millisecond);
    milliseconds = instant.getTime();
    if (instant.getUTCFullYear() !== year
        || instant.getUTCMonth() !== month - 1
        || instant.getUTCDate() !== day
        || instant.getUTCHours() !== hour
        || instant.getUTCMinutes() !== minute
        || instant.getUTCSeconds() !== second
        || instant.getUTCMilliseconds() !== millisecond) {
      return null;
    }
  }
  else return null;
  if (!Number.isFinite(milliseconds) || Math.abs(milliseconds) > MAX_DATE_MILLISECONDS) return null;
  return milliseconds;
}

function buildFormatters(locale, timeZone) {
  if (/(?:^|-)(?:u|x)-/i.test(locale)) return null;
  const canonical = Intl.getCanonicalLocales(locale);
  if (canonical.length !== 1
      || Intl.DateTimeFormat.supportedLocalesOf(canonical, { localeMatcher: "lookup" }).length !== 1) {
    return null;
  }
  const pinnedLocale = canonical[0];
  const base = { localeMatcher: "lookup", timeZone };
  const probe = new Intl.DateTimeFormat(pinnedLocale, base);
  if (probe.resolvedOptions().locale !== pinnedLocale) return null;
  return Object.freeze({
    date: new Intl.DateTimeFormat(pinnedLocale, {
      ...base,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }),
    parts: new Intl.DateTimeFormat("en-US-u-ca-gregory-nu-latn", {
      ...base,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    }),
    time: new Intl.DateTimeFormat(pinnedLocale, {
      ...base,
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    }),
    weekday: new Intl.DateTimeFormat(pinnedLocale, {
      ...base,
      weekday: "long",
    }),
  });
}

function snapshotContext(context, limits) {
  try {
    if (context === undefined) {
      return { ok: true, value: Object.freeze({ formatters: null, seed: "" }) };
    }
    if (context === null || typeof context !== "object" || types.isProxy(context)) return invalid();
    const proto = Object.getPrototypeOf(context);
    if (proto !== Object.prototype && proto !== null) return invalid();
    const descriptors = Object.getOwnPropertyDescriptors(context);
    const keys = Reflect.ownKeys(descriptors);
    if (keys.some((key) => typeof key !== "string")) return invalid();

    const value = {};
    let totalStringBytes = 0;
    for (const key of keys) {
      const descriptor = descriptors[key];
      if (!ALLOWED_KEYS.has(key)
          || DANGEROUS_KEYS.has(key)
          || !Object.prototype.hasOwnProperty.call(descriptor, "value")) {
        return invalid();
      }
      const item = descriptor.value;
      if (types.isProxy(item)) return invalid();
      if (STRING_KEYS.has(key) && typeof item !== "string") return invalid();
      if (typeof item === "string") {
        if (!isWellFormedUtf16(item)) return invalid();
        const bytes = Buffer.byteLength(item, "utf8");
        if (bytes > limits.maxContextStringBytes
            || (key === "seed" && bytes > limits.maxSeedBytes)) {
          return invalid();
        }
        totalStringBytes += bytes;
        if (totalStringBytes > limits.maxContextTotalBytes) return invalid();
      }
      value[key] = item;
    }

    if (value.idleDuration !== undefined
        && (!Number.isSafeInteger(value.idleDuration) || value.idleDuration < 0)) {
      return invalid();
    }
    if (value.now !== undefined) {
      value.now = parseNow(value.now);
      if (value.now === null) return invalid();
    }
    const hasDateConfig = value.now !== undefined
      || value.timeZone !== undefined
      || value.locale !== undefined;
    if (hasDateConfig && (
      value.now === undefined
      || typeof value.timeZone !== "string"
      || typeof value.locale !== "string"
    )) {
      return invalid();
    }
    value.formatters = hasDateConfig ? buildFormatters(value.locale, value.timeZone) : null;
    if (hasDateConfig && !value.formatters) return invalid();
    value.seed = value.seed || "";
    return { ok: true, value: Object.freeze(value) };
  } catch {
    return invalid();
  }
}

function formatDateMacro(snapshot, name) {
  try {
    if (!snapshot.formatters || snapshot.now === undefined) return null;
    const instant = new Date(snapshot.now);
    if (name === "time" || name === "date" || name === "weekday") {
      return snapshot.formatters[name].format(instant);
    }
    const parts = Object.fromEntries(
      snapshot.formatters.parts.formatToParts(instant)
        .filter((part) => part.type !== "literal")
        .map((part) => [part.type, part.value]),
    );
    if (name === "isotime") return `${parts.hour}:${parts.minute}:${parts.second}`;
    if (name === "isodate") return `${parts.year}-${parts.month}-${parts.day}`;
    return null;
  } catch {
    return null;
  }
}

module.exports = {
  formatDateMacro,
  snapshotContext,
};
