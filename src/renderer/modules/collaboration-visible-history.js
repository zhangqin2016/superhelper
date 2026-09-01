import { mergeCollaborationHistory } from "./collaboration-history-view.js";

/** Refresh already loaded older rows from the main process's synced projection. */
export async function refreshVisibleHistory({ conversationId, existing, latest, readMessages, isCurrent }) {
  if (typeof readMessages !== "function") return existing;
  const newest = new Set(latest.map((row) => row.id));
  const ids = [...new Set(existing.filter((row) => row.seq != null && !newest.has(row.id)).map((row) => row.id))];
  let refreshed = existing;
  for (let i = 0; i < ids.length; i += 200) {
    if (!isCurrent()) return null;
    const result = await readMessages({ conversationId, messageIds: ids.slice(i, i + 200) });
    if (!isCurrent()) return null;
    if (!result?.ok) throw new Error("Visible collaboration history unavailable");
    const unavailable = new Set(result.unavailableMessageIds || []);
    refreshed = mergeCollaborationHistory(refreshed.filter((row) => !unavailable.has(row.id)), result.messages || []);
  }
  return refreshed;
}
