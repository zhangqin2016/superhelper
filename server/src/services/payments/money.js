// Money as integer cents, always. Providers speak yuan strings ("9.90");
// converting through floating point can turn 0.29 into 28 cents, so the
// conversion is done on the digits.

export function centsToYuan(cents) {
  const value = Math.trunc(Number(cents || 0));
  const sign = value < 0 ? "-" : "";
  const abs = Math.abs(value);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

/** "9.9" | "9.90" | "10" → 990 | 990 | 1000; null when not an amount. */
export function yuanToCents(yuan) {
  const text = String(yuan ?? "").trim();
  const match = /^(-)?(\d+)(?:\.(\d{1,2}))?$/.exec(text);
  if (!match) return null;
  const cents = Number(match[2]) * 100 + Number((match[3] || "").padEnd(2, "0") || 0);
  return match[1] ? -cents : cents;
}
