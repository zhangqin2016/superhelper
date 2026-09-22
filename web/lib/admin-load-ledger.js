import { cache } from "react";

/**
 * The per-request record of admin reads that failed.
 *
 * Kept apart from api.js so it can be exercised without Next's react-server
 * resolution conditions — a ledger nothing can test is how the previous
 * swallow-and-forget helper survived for so long.
 *
 * `cache` scopes the array to one request/render pass, so one operator's outage
 * never appears on another operator's page.
 */
export const adminLoadFailures = cache(() => []);

/** Record a failed read once per endpoint. */
export function recordAdminLoadFailure(ledger, path, error) {
  const message = error instanceof Error ? error.message : String(error ?? "unknown error");
  if (!Array.isArray(ledger)) return null;
  if (ledger.some((entry) => entry.path === path)) return null;
  const entry = { path, message };
  ledger.push(entry);
  return entry;
}
