import { randomUUID } from "node:crypto";
import { sql } from "kysely";
import { lockSyncStates } from "./lock-order.js";
import { writeUserSyncEvents, writeRealtimeOutboxRows } from "./event-writer.js";

/** Server-only provenance; callers derive actors from authenticated routes. */
export async function writeEnterpriseEvents(trx, { actor, organizationId, revokedUserIds = [], directoryUserIds = [], reason }) {
  const source = actor?.source;
  if (source !== "enterprise-web" && source !== "platform-admin"
      || source === "enterprise-web" && !actor.userId
      || source === "platform-admin" && !String(actor.auditActor || "").trim()) throw new TypeError("Trusted enterprise actor required");
  const revoked = [...new Set(revokedUserIds)].sort();
  const directory = [...new Set(directoryUserIds)].sort();
  const recipients = [...new Set([...revoked, ...directory])].sort();
  if (!recipients.length) return;
  // Lock the entire union before the first event. Per-event subsets alone can
  // acquire another user's lower-sorted cursor late and deadlock another org.
  await trx.insertInto("user_sync_state").values(recipients.map((userId) => ({ user_id: userId })))
    .onConflict((conflict) => conflict.column("user_id").doNothing()).execute();
  await lockSyncStates(trx, recipients);
  const planned = revoked.map((userId) => ({ type: "scope.revoked", users: [userId], payload: { scopeType: "organization", organizationId, userId, reason } }));
  if (directory.length) planned.push({ type: "directory.changed", users: directory, payload: { scopeType: "organization", organizationId } });
  const commandId = `enterprise_${randomUUID()}`;
  for (const plan of planned) {
    const event = { id: `evt_${randomUUID()}`, conversationId: null };
    await trx.insertInto("collaboration_events").values({
      id: event.id, conversation_id: null, seq: sql`nextval('collaboration_relationship_event_seq')`, type: plan.type,
      actor_source: source, actor_user_id: source === "enterprise-web" ? actor.userId : null, actor_device_id: null,
      audit_actor: source === "platform-admin" ? actor.auditActor : null,
      client_command_id: commandId, payload: JSON.stringify(plan.payload),
    }).execute();
    const syncRows = await writeUserSyncEvents(trx, { event, recipientUserIds: plan.users });
    await writeRealtimeOutboxRows(trx, syncRows);
  }
}
