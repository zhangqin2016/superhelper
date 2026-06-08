const DATE_MONTHS = {
  Jan: "01",
  Feb: "02",
  Mar: "03",
  Apr: "04",
  May: "05",
  Jun: "06",
  Jul: "07",
  Aug: "08",
  Sep: "09",
  Oct: "10",
  Nov: "11",
  Dec: "12",
};

function dateKeyFromDisplayString(value) {
  const match = String(value).match(/^(?:[A-Za-z]{3}\s+)?([A-Za-z]{3})\s+(\d{1,2})(?:\s+(\d{4}))?/);
  if (!match || !DATE_MONTHS[match[1]]) return "";
  let year = match[3] ? Number(match[3]) : new Date().getFullYear();
  const month = DATE_MONTHS[match[1]];
  const day = String(Number(match[2])).padStart(2, "0");
  if (!match[3]) {
    const candidate = new Date(`${year}-${month}-${day}T00:00:00`);
    const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000);
    if (candidate > tomorrow) year -= 1;
  }
  return `${year}-${month}-${day}`;
}

function dateKeyFromDate(value) {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const day = String(value.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function usageDateKey(value) {
  if (!value) return "";
  if (typeof value === "string") {
    const direct = value.match(/^(\d{4}-\d{2}-\d{2})/);
    if (direct) return direct[1];
    const display = dateKeyFromDisplayString(value);
    if (display) return display;
  }
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isNaN(date.getTime())) {
    return dateKeyFromDate(date);
  }
  return String(value).slice(0, 10);
}
