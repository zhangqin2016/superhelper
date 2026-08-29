import assert from "node:assert/strict";
import crypto from "node:crypto";

if (!process.env.DATABASE_URL) {
  console.log("collaboration realtime integration: skipped (DATABASE_URL is not configured)");
  process.exit(0);
}

const [{ default: pg }, { Kysely, PostgresDialect }, { createCollaborationWsTicketService }, { COLLABORATION_NOTIFY_CHANNEL, createRealtimeDispatcher, createRealtimeNotifyLifecycle }] = await Promise.all([
  import("pg"), import("kysely"), import("../src/services/collaboration/ws-ticket.js"), import("../src/services/collaboration/realtime-dispatcher.js"),
]);
const schema = `collab_realtime_it_${crypto.randomUUID().replaceAll("-", "")}`;
const admin = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, options: `-c search_path=${schema}` });
const db = new Kysely({ dialect: new PostgresDialect({ pool }) });
let listenLifecycle = null;

try {
  await admin.query(`create schema ${schema}`);
  await pool.query(`
    create table user_devices (user_id text not null, device_id text not null, status text not null, primary key (user_id, device_id));
    create table collaboration_ws_tickets (token_hash text primary key, user_id text not null, device_id text not null, issued_at timestamptz not null default now(), expires_at timestamptz not null, consumed_at timestamptz);
    create table collaboration_realtime_outbox (id bigserial primary key, user_id text not null, max_cursor bigint not null, state text not null default 'pending', available_at timestamptz not null default now(), lease_owner text, lease_expires_at timestamptz, attempts integer not null default 0, delivered_at timestamptz);
  `);
  await pool.query("insert into user_devices values ('user-1', 'device-1', 'active')");
  let resolveHint;
  const hinted = new Promise((resolve) => { resolveHint = resolve; });
  listenLifecycle = createRealtimeNotifyLifecycle({
    createClient: () => new pg.Client({ connectionString: process.env.DATABASE_URL, options: `-c search_path=${schema}` }),
    onHint: (hint) => resolveHint(hint),
  });
  await listenLifecycle.start();
  await pool.query("select pg_notify($1, $2)", [COLLABORATION_NOTIFY_CHANNEL, JSON.stringify({ userId: "user-1", cursor: 6 })]);
  const hint = await Promise.race([hinted, new Promise((_, reject) => setTimeout(() => reject(new Error("LISTEN hint timed out")), 3000))]);
  assert.deepEqual(hint, { userId: "user-1", cursor: 6 }, "a separate PostgreSQL client receives cross-process realtime wake-up hints");
  await listenLifecycle.stop();
  listenLifecycle = null;
  const ticketService = createCollaborationWsTicketService({ db, createToken: () => "real-pg-ticket" });
  const ticket = await ticketService.issue({ userId: "user-1", deviceId: "device-1" });
  assert.deepEqual(await ticketService.consume({ ticket: ticket.ticket }), { userId: "user-1", deviceId: "device-1" });
  await assert.rejects(() => ticketService.consume({ ticket: ticket.ticket }), (error) => error?.code === "COLLAB_WS_TICKET_INVALID");
  await pool.query("insert into collaboration_realtime_outbox (user_id, max_cursor) values ('user-1', 7)");
  const notices = [];
  const dispatcher = createRealtimeDispatcher({ db, notify: async (row) => notices.push(row) });
  assert.deepEqual(await dispatcher.dispatchOnce({ workerId: "integration" }), { claimed: 1, delivered: 1, retried: 0 });
  assert.deepEqual(notices, [{ id: 1, userId: "user-1", maxCursor: 7 }]);
  const state = await pool.query("select state from collaboration_realtime_outbox where id = 1");
  assert.equal(state.rows[0].state, "delivered");
  const handOffExpiredLeaseToWorkerB = async (id) => {
    // Worker A has claimed the row, then its lease expires before it can
    // finalize. This is the same eligibility predicate used by another
    // dispatcher when it takes over an expired lease.
    await pool.query("update collaboration_realtime_outbox set lease_expires_at = now() - interval '1 millisecond' where id = $1 and state = 'leased' and lease_owner = 'worker-a'", [id]);
    const takeover = await pool.query("update collaboration_realtime_outbox set lease_owner = 'worker-b', lease_expires_at = now() + interval '1 minute' where id = $1 and state = 'leased' and lease_expires_at <= now()", [id]);
    assert.equal(takeover.rowCount, 1, "worker B takes over only after A's lease has expired");
  };
  await pool.query("insert into collaboration_realtime_outbox (user_id, max_cursor, state, lease_owner, lease_expires_at) values ('user-1', 8, 'leased', 'old-worker-a', now() - interval '1 minute')");
  const staleSuccess = createRealtimeDispatcher({
    db,
    notify: async ({ id }) => handOffExpiredLeaseToWorkerB(id),
  });
  assert.deepEqual(await staleSuccess.dispatchOnce({ workerId: "worker-a" }), { claimed: 1, delivered: 0, retried: 0 }, "worker A cannot mark an expired lease delivered after B takes it over");
  const afterStaleSuccess = await pool.query("select state, lease_owner from collaboration_realtime_outbox where id = 2");
  assert.deepEqual(afterStaleSuccess.rows[0], { state: "leased", lease_owner: "worker-b" });
  await pool.query("insert into collaboration_realtime_outbox (user_id, max_cursor, state, lease_owner, lease_expires_at) values ('user-1', 9, 'leased', 'old-worker-a', now() - interval '1 minute')");
  const staleFailure = createRealtimeDispatcher({
    db,
    notify: async ({ id }) => {
      await handOffExpiredLeaseToWorkerB(id);
      throw new Error("worker A's notification failed after its lease was lost");
    },
  });
  assert.deepEqual(await staleFailure.dispatchOnce({ workerId: "worker-a" }), { claimed: 1, delivered: 0, retried: 0 }, "worker A cannot reschedule an expired lease after B takes it over");
  const afterStaleFailure = await pool.query("select state, lease_owner from collaboration_realtime_outbox where id = 3");
  assert.deepEqual(afterStaleFailure.rows[0], { state: "leased", lease_owner: "worker-b" });
  console.log("collaboration realtime integration: ok");
} finally {
  await listenLifecycle?.stop();
  await db.destroy();
  await admin.query(`drop schema if exists ${schema} cascade`);
  await admin.end();
}
