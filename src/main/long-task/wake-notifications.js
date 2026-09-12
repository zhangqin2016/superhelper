"use strict";

function ensureWakeNotificationSchema(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS long_task_wake_notifications (
    wake_id TEXT PRIMARY KEY REFERENCES long_task_wakes(id),
    delivered_at INTEGER, retry_at INTEGER NOT NULL DEFAULT 0
  )`);
}

// The abandoned wake itself is the outbox entry. A crash between abandoning
// execution and publishing the explanation cannot lose the explanation.
async function deliverWakeNotifications(store, publish) {
  if (typeof publish !== "function") return;
  const rows = store.db.all(`SELECT w.id FROM long_task_wakes w
    LEFT JOIN long_task_wake_notifications n ON n.wake_id=w.id
    WHERE w.status='abandoned' AND n.delivered_at IS NULL AND COALESCE(n.retry_at,0)<=?
    ORDER BY w.updated_at LIMIT 20`, Number(store.now()));
  for (const row of rows) {
    const wake = store.getWake(row.id);
    let result;
    try { result = await publish(wake, store.getJobTrusted(wake.jobId)); }
    catch { result = { ok: false }; }
    const now = Number(store.now());
    store.db.run(`INSERT INTO long_task_wake_notifications (wake_id,delivered_at,retry_at)
      VALUES (?,?,?) ON CONFLICT(wake_id) DO UPDATE SET
      delivered_at=COALESCE(delivered_at,excluded.delivered_at),retry_at=excluded.retry_at`,
    wake.id, result?.ok ? now : null, now + 30_000);
  }
}

module.exports = { ensureWakeNotificationSchema, deliverWakeNotifications };
