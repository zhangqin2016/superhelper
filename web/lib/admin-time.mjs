// Dates in admin client components render identically on the server and in
// the browser: an explicit time zone and a locale-neutral shape. A bare
// toLocaleString() used the container's zone (UTC) on the server and the
// operator's in the browser, so the text differed and the list failed
// hydration (React #418).
export const ADMIN_TIME_ZONE = "Asia/Shanghai";
const DATE_TIME = new Intl.DateTimeFormat("sv-SE", { timeZone: ADMIN_TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
const DATE = new Intl.DateTimeFormat("sv-SE", { timeZone: ADMIN_TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit" });

function valid(value) {
  if (value === null || value === undefined || value === "") return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** "2026-10-07 11:28" (Beijing time), or "-". */
export function adminDateTime(value) {
  const date = valid(value);
  return date ? DATE_TIME.format(date) : "-";
}

/** "2026-10-07" (Beijing time), or "-". */
export function adminDate(value) {
  const date = valid(value);
  return date ? DATE.format(date) : "-";
}
