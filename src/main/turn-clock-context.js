"use strict";

/**
 * The model has no clock. Freshness judgment — "世界杯冠军" asked the day
 * after the final, "现任…", "最新…" — is impossible without knowing today,
 * so every turn injects the current date/time once and leaves the
 * date-sensitivity JUDGMENT to the model (no keyword vocabularies).
 */
function currentDateTimeLine(now = new Date()) {
  const pad = (value) => String(value).padStart(2, "0");
  const offsetMinutes = -now.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const wholeHours = Math.floor(Math.abs(offsetMinutes) / 60);
  const restMinutes = Math.abs(offsetMinutes) % 60;
  const offset = restMinutes ? `UTC${sign}${wholeHours}:${pad(restMinutes)}` : `UTC${sign}${wholeHours}`;
  const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const time = `${pad(now.getHours())}:${pad(now.getMinutes())}`;
  return `Current date/time: ${date} ${time} (${offset}). When a question depends on current or recent state (latest champion, incumbent, price, version, score), check live sources instead of relying on training memory; when you use live sources, end the answer with a "来源" section listing the exact URLs copied from the tool results — naming sources without their URLs does not count.`;
}

module.exports = { currentDateTimeLine };
