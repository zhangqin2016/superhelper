#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const migration = fs.readFileSync(path.join(root, "server/migrations/033_collaboration_core.sql"), "utf8");

for (const table of [
  "friend_requests",
  "friendships",
  "user_blocks",
  "conversations",
  "conversation_members",
  "collaboration_events",
  "messages",
  "message_revisions",
  "command_receipts",
  "user_sync_state",
  "user_sync_events",
  "device_sync_state",
  "collaboration_realtime_outbox",
]) {
  assert.match(migration, new RegExp(`create table if not exists ${table}\\b`, "i"), `${table} must exist`);
}

assert.match(migration, /foreign key \(organization_id\) references organizations\(id\)/i);
assert.match(migration, /references conversations\(id\)/i);
assert.match(migration, /references collaboration_events\(id\)/i);
assert.match(migration, /references messages\(id\)/i);
assert.match(migration, /references users\(id\)/i);
assert.match(migration, /references devices\(id\)/i);
assert.match(
  migration,
  /foreign key \(actor_user_id, actor_device_id\) references user_devices\(user_id, device_id\)/i,
  "an event actor must be bound to a device that belongs to the same user",
);

assert.match(migration, /unique \(conversation_id, seq\)/i);
assert.match(
  migration,
  /unique \(id, conversation_id\)/i,
  "an event must expose a conversation-bound key for sync integrity",
);
assert.match(
  migration,
  /foreign key \(event_id, conversation_id, create_seq\)\s+references collaboration_events\(id, conversation_id, seq\)/i,
  "a message projection must use its event's authoritative conversation and sequence",
);
assert.match(
  migration,
  /foreign key \(event_id, conversation_id, event_seq\)\s+references collaboration_events\(id, conversation_id, seq\)/i,
  "a message revision must use its event's authoritative conversation and sequence",
);
assert.match(
  migration,
  /foreign key \(message_id, conversation_id\) references messages\(id, conversation_id\)/i,
  "a revision must remain in its message's conversation",
);
assert.match(migration, /primary key \(actor_device_id, command_type, client_command_id\)/i);
assert.match(migration, /check \(next_seq >= 1\)/i);
assert.match(migration, /check \(last_read_seq >= 0\)/i);
assert.match(migration, /check \(\(scope_type = 'organization'\) = \(organization_id is not null\)\)/i);

assert.match(migration, /create unique index if not exists conversations_personal_direct_pair_uk/i);
assert.match(migration, /on conversations \(direct_user_low_id, direct_user_high_id\)/i);
assert.match(migration, /direct_user_low_id < direct_user_high_id/i);
assert.match(migration, /direct_pair_key = direct_user_low_id \|\| ':' \|\| direct_user_high_id/i);
assert.match(migration, /where scope_type = 'personal' and kind = 'direct' and status = 'active'/i);
assert.match(migration, /create unique index if not exists conversations_organization_direct_pair_uk/i);
assert.match(migration, /on conversations \(organization_id, direct_user_low_id, direct_user_high_id\)/i);
assert.match(migration, /where scope_type = 'organization' and kind = 'direct' and status = 'active'/i);

assert.match(
  migration,
  /foreign key \(event_id, conversation_id\) references collaboration_events\(id, conversation_id\)/i,
  "a user sync event must remain bound to its source event's conversation",
);

assert.match(migration, /create index if not exists user_sync_events_user_cursor_idx/i);
assert.match(migration, /create index if not exists collaboration_events_conversation_seq_idx/i);
assert.match(migration, /create index if not exists conversation_members_authorization_idx/i);
assert.match(migration, /create index if not exists collaboration_realtime_outbox_pending_idx/i);
assert.match(migration, /create index if not exists command_receipts_lookup_idx/i);
assert.doesNotMatch(migration, /gin\s*\(payload\)/i, "event payload must not get a body-search index");

console.log("collaboration-core-schema: ok");
