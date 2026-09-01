import { sql } from "kysely";

import { isSensitiveCollaborationPayloadKey } from "./idempotency.js";
import { lockSyncStates } from "./lock-order.js";


function requiredId(value, label) {
  const id = String(value || "").trim();
  if (!id) throw new TypeError(`${label} is required.`);
  return id;
}

function optionalConversationId(value) {
  if (value == null || String(value).trim() === "") return null;
  return requiredId(value, "Event conversation id");
}

/** Recipient order is a lock-order contract, not a display preference. */
export function assertSortedRecipientUserIds(recipientUserIds) {
  if (!Array.isArray(recipientUserIds) || recipientUserIds.length === 0) {
    throw new TypeError("A collaboration event requires at least one recipient user id.");
  }
  let previous = "";
  for (const candidate of recipientUserIds) {
    const userId = requiredId(candidate, "Recipient user id");
    if (previous && previous >= userId) {
      throw new TypeError("Collaboration event recipients must be unique and sorted by user id.");
    }
    previous = userId;
  }
  return recipientUserIds.map((userId) => String(userId).trim());
}

function assertSafeEventPayload(value, ancestors = new Set()) {
  if (!value || typeof value !== "object") return;
  if (Buffer.isBuffer(value) || value instanceof Uint8Array || value instanceof Date) return;
  if (ancestors.has(value)) throw new TypeError("A collaboration event payload cannot be circular.");
  ancestors.add(value);
  if (Array.isArray(value)) {
    for (const entry of value) assertSafeEventPayload(entry, ancestors);
  } else {
    for (const [key, nested] of Object.entries(value)) {
      if (isSensitiveCollaborationPayloadKey(key)) {
        throw new TypeError(`Collaboration event payload must not contain ${key}.`);
      }
      assertSafeEventPayload(nested, ancestors);
    }
  }
  ancestors.delete(value);
}

/** Lock the conversation and consume exactly one authoritative sequence. */
export async function lockAndAllocateConversationSequence(trx, conversationId) {
  const id = requiredId(conversationId, "Conversation id");
  const conversation = await trx.selectFrom("conversations")
    .selectAll()
    .where("id", "=", id)
    .orderBy("id", "asc")
    .forUpdate()
    .executeTakeFirst();
  if (!conversation) {
    const error = new Error("Collaboration conversation was not found.");
    error.code = "COLLAB_CONVERSATION_NOT_FOUND";
    throw error;
  }
  const seq = Number(conversation.next_seq);
  if (!Number.isSafeInteger(seq) || seq < 1) throw new Error("Collaboration conversation sequence is invalid.");
  await trx.updateTable("conversations")
    .set({ next_seq: seq + 1, updated_at: sql`now()` })
    .where("id", "=", id)
    .executeTakeFirst();
  return { conversation, seq };
}

/** Persist the immutable event before any mutable read projection. */
export async function writeCollaborationEvent(trx, event) {
  const normalized = {
    id: requiredId(event?.id, "Event id"),
    conversationId: optionalConversationId(event?.conversationId ?? event?.conversation_id),
    seq: Number(event?.seq),
    type: requiredId(event?.type, "Event type"),
    actorUserId: requiredId(event?.actorUserId ?? event?.actor_user_id, "Event actor user id"),
    actorDeviceId: requiredId(event?.actorDeviceId ?? event?.actor_device_id, "Event actor device id"),
    clientCommandId: requiredId(event?.clientCommandId ?? event?.client_command_id, "Client command id"),
    payload: event?.payload || {},
  };
  if (!Number.isSafeInteger(normalized.seq) || normalized.seq < 1) throw new TypeError("Event sequence must be a positive integer.");
  assertSafeEventPayload(normalized.payload);
  await trx.insertInto("collaboration_events").values({
    id: normalized.id,
    conversation_id: normalized.conversationId,
    seq: normalized.seq,
    type: normalized.type,
    actor_user_id: normalized.actorUserId,
    actor_device_id: normalized.actorDeviceId,
    client_command_id: normalized.clientCommandId,
    payload: JSON.stringify(normalized.payload),
  }).executeTakeFirst();
  return normalized;
}

/**
 * Fan a committed event out to sorted users. State rows are materialized first
 * so every user is then locked in the global order before a cursor is consumed.
 */
export async function writeUserSyncEvents(trx, { event, recipientUserIds }) {
  const users = assertSortedRecipientUserIds(recipientUserIds);
  await trx.insertInto("user_sync_state").values(users.map((userId) => ({ user_id: userId })))
    .onConflict((conflict) => conflict.column("user_id").doNothing())
    .execute();
  const states = await lockSyncStates(trx, users);
  const stateByUserId = new Map(states.map((state) => [state.user_id, state]));
  if (stateByUserId.size !== users.length) throw new Error("Unable to lock every collaboration sync state.");

  const rows = users.map((userId) => {
    const state = stateByUserId.get(userId);
    const cursor = Number(state.next_cursor);
    if (!Number.isSafeInteger(cursor) || cursor < 1) throw new Error("Collaboration sync cursor is invalid.");
    return { userId, cursor, eventId: event.id, conversationId: event.conversationId };
  });
  // The lock rows have already been acquired in canonical order. The writes
  // remain ordered too, so an error rolls every cursor and event back together.
  for (const row of rows) {
    await trx.updateTable("user_sync_state").set({ next_cursor: row.cursor + 1, updated_at: sql`now()` })
      .where("user_id", "=", row.userId).executeTakeFirst();
  }
  await trx.insertInto("user_sync_events").values(rows.map((row) => ({
    user_id: row.userId,
    cursor: row.cursor,
    event_id: row.eventId,
    conversation_id: row.conversationId,
  }))).execute();
  return rows;
}

/** Durable outbox rows are created only after their durable sync cursors exist. */
export async function writeRealtimeOutboxRows(trx, syncRows) {
  if (!Array.isArray(syncRows) || syncRows.length === 0) return [];
  const rows = syncRows.map((row) => ({ user_id: row.userId, max_cursor: row.cursor }));
  await trx.insertInto("collaboration_realtime_outbox").values(rows).execute();
  return syncRows.map((row) => ({ userId: row.userId, maxCursor: row.cursor }));
}
