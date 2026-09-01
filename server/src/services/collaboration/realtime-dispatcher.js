import { sql } from "kysely";

const LEASE_MS = 30_000;
const MAX_RETRY_MS = 30_000;
export const COLLABORATION_NOTIFY_CHANNEL = "collaboration_sync_available";

export function nextRealtimeRetryAt(attempts, now = new Date()) {
  const count = Math.max(0, Number(attempts) || 0);
  return new Date(now.getTime() + Math.min(MAX_RETRY_MS, 1000 * (2 ** count)));
}

/** A process-local LISTEN bridge; payloads remain only best-effort wake-ups. */
export function createRealtimeNotifyListener({ client, channel = COLLABORATION_NOTIFY_CHANNEL, onHint = () => {} } = {}) {
  if (!client || typeof client.on !== "function" || typeof client.query !== "function") throw new TypeError("A PostgreSQL LISTEN client is required.");
  const onNotification = (notification) => {
    if (notification?.channel !== channel) return;
    try {
      const payload = JSON.parse(String(notification.payload || ""));
      const userId = String(payload?.userId || "").trim();
      const cursor = Number(payload?.cursor);
      if (!userId || !Number.isSafeInteger(cursor) || cursor < 1) return;
      onHint({ userId, cursor });
    } catch { /* invalid hints never affect durable sync */ }
  };
  return {
    async start() { client.on("notification", onNotification); await client.query(`listen ${channel}`); },
    async stop() { client.off?.("notification", onNotification); await client.query(`unlisten ${channel}`); },
  };
}

/** Own a dedicated LISTEN client with failure-safe startup and shutdown. */
export function createRealtimeNotifyLifecycle({ createClient, onHint, onReady = () => {}, channel = COLLABORATION_NOTIFY_CHANNEL, reconnectBaseMs = 1000, reconnectMaxMs = 30_000, schedule = setTimeout, cancel = clearTimeout } = {}) {
  if (typeof createClient !== "function") throw new TypeError("A realtime LISTEN client factory is required.");
  let client = null;
  let listener = null;
  let stopped = false;
  let reconnectTimer = null;
  let reconnectAttempts = 0;
  const reconnect = () => {
    if (stopped || reconnectTimer) return;
    const delay = Math.min(reconnectMaxMs, reconnectBaseMs * (2 ** reconnectAttempts));
    reconnectAttempts += 1;
    reconnectTimer = schedule(async () => {
      reconnectTimer = null;
      try { await connectAndListen(); } catch { reconnect(); }
    }, delay);
  };
  const detachAndClose = async () => {
    const currentListener = listener;
    const currentClient = client;
    listener = null;
    client = null;
    try { await currentListener?.stop(); } catch { /* client may already be gone */ }
    try { await currentClient?.end?.(); } catch { /* noop */ }
  };
  const connectAndListen = async () => {
    await detachAndClose();
    client = createClient();
    try {
      await client.connect();
      listener = createRealtimeNotifyListener({ client, channel, onHint });
      await listener.start();
      reconnectAttempts = 0;
      onReady();
      const lost = () => { detachAndClose().finally(reconnect); };
      client.once?.("error", lost);
      client.once?.("end", lost);
    } catch (error) {
      await detachAndClose();
      throw error;
    }
  };
  return {
    async start() {
      stopped = false;
      try { await connectAndListen(); } catch (error) { reconnect(); throw error; }
    },
    async stop() {
      stopped = true;
      if (reconnectTimer) cancel(reconnectTimer);
      reconnectTimer = null;
      await detachAndClose();
    },
  };
}

function createKyselyRealtimeRepository(db) {
  return {
    async withWriteTransaction(callback) { return db.transaction().execute(callback); },
    async claimRealtimeOutbox(trx, { workerId, limit, now }) {
      const rows = await trx.selectFrom("collaboration_realtime_outbox").selectAll()
        .where((eb) => eb.or([
          eb.and([eb("state", "=", "pending"), eb("available_at", "<=", now)]),
          eb.and([eb("state", "=", "leased"), eb("lease_expires_at", "<=", now)]),
        ])).orderBy("id", "asc").limit(limit).forUpdate().skipLocked().execute();
      if (rows.length === 0) return [];
      const leaseExpiresAt = new Date(now.getTime() + LEASE_MS);
      await trx.updateTable("collaboration_realtime_outbox").set({ state: "leased", lease_owner: workerId, lease_expires_at: leaseExpiresAt, attempts: sql`attempts + 1` })
        .where("id", "in", rows.map((row) => row.id)).execute();
      return rows.map((row) => ({ id: Number(row.id), userId: row.user_id, maxCursor: Number(row.max_cursor), attempts: Number(row.attempts || 0) + 1 }));
    },
    async markRealtimeOutboxDelivered(trx, id, workerId) {
      const result = await trx.updateTable("collaboration_realtime_outbox")
        .set({ state: "delivered", delivered_at: sql`now()`, lease_owner: null, lease_expires_at: null })
        .where("id", "=", id).where("state", "=", "leased").where("lease_owner", "=", workerId)
        .executeTakeFirst();
      return Number(result?.numUpdatedRows || 0) > 0;
    },
    async rescheduleRealtimeOutbox(trx, id, { attempts, availableAt, workerId }) {
      const result = await trx.updateTable("collaboration_realtime_outbox")
        .set({ state: "pending", attempts, available_at: availableAt, lease_owner: null, lease_expires_at: null })
        .where("id", "=", id).where("state", "=", "leased").where("lease_owner", "=", workerId)
        .executeTakeFirst();
      return Number(result?.numUpdatedRows || 0) > 0;
    },
  };
}

async function withWrite(repository, callback) {
  return typeof repository.withWriteTransaction === "function" ? repository.withWriteTransaction(callback) : callback(repository);
}

export function createRealtimeDispatcher({ db, repository = db ? createKyselyRealtimeRepository(db) : null, notify, now = () => new Date() } = {}) {
  if (!repository || typeof notify !== "function") throw new TypeError("A realtime outbox repository and notifier are required.");
  return {
    async dispatchOnce({ workerId, limit = 100 } = {}) {
      const leaseOwner = String(workerId || "realtime-worker");
      const claimed = await withWrite(repository, (trx) => repository.claimRealtimeOutbox(trx, { workerId: leaseOwner, limit: Math.min(Math.max(1, Number(limit) || 100), 500), now: now() }));
      let delivered = 0;
      let retried = 0;
      for (const row of claimed) {
        try {
          // NOTIFY/gateway wake-ups are hints only. A crash at either side
          // leaves the durable sync event intact and the lease eventually runs again.
          await notify({ id: row.id, userId: row.userId, maxCursor: row.maxCursor });
          const markedDelivered = await withWrite(repository, (trx) => repository.markRealtimeOutboxDelivered(trx, row.id, leaseOwner));
          // Older repository adapters returned void. Treat that as the historic
          // successful contract, but an explicit false is a lost lease.
          if (markedDelivered !== false) delivered += 1;
        } catch {
          const attempts = Math.max(1, Number(row.attempts) || 1) + 1;
          const rescheduled = await withWrite(repository, (trx) => repository.rescheduleRealtimeOutbox(trx, row.id, { attempts, availableAt: nextRealtimeRetryAt(attempts - 1, now()), workerId: leaseOwner }));
          if (rescheduled !== false) retried += 1;
        }
      }
      return { claimed: claimed.length, delivered, retried };
    },
  };
}
