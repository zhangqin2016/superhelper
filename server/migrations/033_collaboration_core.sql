-- Collaboration Center Slice 0: durable relationships, ordered events and sync.
--
-- This migration deliberately keeps message bodies opaque (ciphertext only).
-- PostgreSQL owns ordering, uniqueness and cursor invariants; the WebSocket
-- layer added later is only a best-effort wake-up for this durable state.

create table if not exists friend_requests (
  id text primary key,
  sender_user_id text not null references users(id) on delete cascade,
  receiver_user_id text not null references users(id) on delete cascade,
  status text not null default 'pending',
  message text,
  created_at timestamptz not null default now(),
  responded_at timestamptz,
  constraint friend_requests_status_ck check (status in ('pending', 'accepted', 'declined', 'cancelled')),
  constraint friend_requests_distinct_users_ck check (sender_user_id <> receiver_user_id)
);

create unique index if not exists friend_requests_pending_pair_uk
  on friend_requests (sender_user_id, receiver_user_id)
  where status = 'pending';

create table if not exists friendships (
  user_low_id text not null references users(id) on delete cascade,
  user_high_id text not null references users(id) on delete cascade,
  status text not null default 'active',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_low_id, user_high_id),
  constraint friendships_sorted_users_ck check (user_low_id < user_high_id),
  constraint friendships_status_ck check (status in ('active', 'removed'))
);

create index if not exists friendships_active_user_low_idx
  on friendships (user_low_id, status);
create index if not exists friendships_active_user_high_idx
  on friendships (user_high_id, status);

create table if not exists user_blocks (
  blocker_user_id text not null references users(id) on delete cascade,
  blocked_user_id text not null references users(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (blocker_user_id, blocked_user_id),
  constraint user_blocks_distinct_users_ck check (blocker_user_id <> blocked_user_id)
);

create index if not exists user_blocks_blocked_idx on user_blocks (blocked_user_id);

create table if not exists conversations (
  id text primary key,
  scope_type text not null,
  organization_id text,
  kind text not null,
  title text not null default '',
  status text not null default 'active',
  direct_pair_key text,
  direct_user_low_id text references users(id),
  direct_user_high_id text references users(id),
  next_seq bigint not null default 1,
  retention_days integer,
  created_by text not null references users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (organization_id) references organizations(id) on delete cascade,
  constraint conversations_scope_type_ck check (scope_type in ('personal', 'organization')),
  constraint conversations_kind_ck check (kind in ('direct', 'group', 'channel')),
  constraint conversations_status_ck check (status in ('active', 'archived')),
  constraint conversations_next_seq_ck check (next_seq >= 1),
  constraint conversations_retention_days_ck check (retention_days is null or retention_days > 0),
  constraint conversations_organization_scope_ck check ((scope_type = 'organization') = (organization_id is not null)),
  constraint conversations_direct_pair_key_ck check (
    (kind = 'direct'
      and direct_pair_key is not null
      and direct_user_low_id is not null
      and direct_user_high_id is not null
      and direct_user_low_id < direct_user_high_id
      and direct_pair_key = direct_user_low_id || ':' || direct_user_high_id)
    or (kind <> 'direct'
      and direct_pair_key is null
      and direct_user_low_id is null
      and direct_user_high_id is null)
  )
);

-- Both pair columns and the key are constrained, so reversed direct pairs
-- cannot survive concurrent creation under a different spelling.
create unique index if not exists conversations_personal_direct_pair_uk
  on conversations (direct_user_low_id, direct_user_high_id)
  where scope_type = 'personal' and kind = 'direct' and status = 'active';
create unique index if not exists conversations_organization_direct_pair_uk
  on conversations (organization_id, direct_user_low_id, direct_user_high_id)
  where scope_type = 'organization' and kind = 'direct' and status = 'active';

create table if not exists conversation_members (
  conversation_id text not null references conversations(id) on delete cascade,
  user_id text not null references users(id) on delete cascade,
  role text not null default 'member',
  status text not null default 'active',
  joined_seq bigint not null default 0,
  last_read_seq bigint not null default 0,
  notification_level text not null default 'all',
  joined_at timestamptz not null default now(),
  left_at timestamptz,
  primary key (conversation_id, user_id),
  constraint conversation_members_role_ck check (role in ('owner', 'admin', 'member')),
  constraint conversation_members_status_ck check (status in ('active', 'left', 'removed')),
  constraint conversation_members_joined_seq_ck check (joined_seq >= 0),
  constraint conversation_members_last_read_seq_ck check (last_read_seq >= 0),
  constraint conversation_members_notification_level_ck check (notification_level in ('all', 'mentions', 'mute'))
);

create index if not exists conversation_members_authorization_idx
  on conversation_members (conversation_id, user_id, status, role);
create index if not exists conversation_members_user_active_idx
  on conversation_members (user_id, status, conversation_id);

create table if not exists collaboration_events (
  id text primary key,
  conversation_id text not null references conversations(id) on delete cascade,
  seq bigint not null,
  type text not null,
  actor_user_id text not null references users(id),
  actor_device_id text not null references devices(id),
  client_command_id text not null,
  payload jsonb not null default '{}',
  created_at timestamptz not null default now(),
  unique (conversation_id, seq),
  unique (id, conversation_id),
  unique (id, conversation_id, seq),
  foreign key (actor_user_id, actor_device_id) references user_devices(user_id, device_id),
  constraint collaboration_events_seq_ck check (seq >= 1)
);

create index if not exists collaboration_events_conversation_seq_idx
  on collaboration_events (conversation_id, seq desc);
create index if not exists collaboration_events_actor_command_idx
  on collaboration_events (actor_device_id, client_command_id);

create table if not exists messages (
  id text primary key,
  event_id text not null unique references collaboration_events(id) on delete restrict,
  conversation_id text not null references conversations(id) on delete cascade,
  create_seq bigint not null,
  sender_user_id text not null references users(id),
  kind text not null default 'text',
  body_ciphertext bytea,
  body_key_version integer,
  revision integer not null default 1,
  reply_to_message_id text references messages(id) on delete set null,
  edited_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  unique (conversation_id, create_seq),
  unique (id, conversation_id),
  foreign key (event_id, conversation_id, create_seq)
    references collaboration_events(id, conversation_id, seq),
  constraint messages_create_seq_ck check (create_seq >= 1),
  constraint messages_kind_ck check (kind in ('text', 'system', 'workspace_share', 'attachment')),
  constraint messages_revision_ck check (revision >= 1),
  constraint messages_ciphertext_key_version_ck check (
    (body_ciphertext is null and body_key_version is null)
    or (body_ciphertext is not null and body_key_version is not null and body_key_version >= 1)
  )
);

create index if not exists messages_conversation_history_idx
  on messages (conversation_id, create_seq desc);
create index if not exists messages_reply_to_idx on messages (reply_to_message_id) where reply_to_message_id is not null;

create table if not exists message_revisions (
  id text primary key,
  message_id text not null references messages(id) on delete cascade,
  event_id text not null unique references collaboration_events(id) on delete restrict,
  conversation_id text not null references conversations(id) on delete cascade,
  event_seq bigint not null,
  body_ciphertext bytea not null,
  key_version integer not null,
  created_at timestamptz not null default now(),
  unique (message_id, event_seq),
  foreign key (message_id, conversation_id) references messages(id, conversation_id),
  foreign key (event_id, conversation_id, event_seq)
    references collaboration_events(id, conversation_id, seq),
  constraint message_revisions_event_seq_ck check (event_seq >= 1),
  constraint message_revisions_key_version_ck check (key_version >= 1)
);

create index if not exists message_revisions_message_history_idx
  on message_revisions (message_id, event_seq desc);

create table if not exists command_receipts (
  actor_device_id text not null references devices(id) on delete cascade,
  command_type text not null,
  client_command_id text not null,
  request_fingerprint text not null,
  state text not null default 'running',
  result_event_id text references collaboration_events(id) on delete set null,
  response_code text,
  response_payload jsonb not null default '{}',
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  primary key (actor_device_id, command_type, client_command_id),
  constraint command_receipts_state_ck check (state in ('running', 'completed', 'failed'))
);

create index if not exists command_receipts_lookup_idx
  on command_receipts (actor_device_id, command_type, client_command_id, state);

create table if not exists user_sync_state (
  user_id text primary key references users(id) on delete cascade,
  next_cursor bigint not null default 1,
  compacted_before_cursor bigint not null default 0,
  updated_at timestamptz not null default now(),
  constraint user_sync_state_next_cursor_ck check (next_cursor >= 1),
  constraint user_sync_state_compacted_cursor_ck check (compacted_before_cursor >= 0),
  constraint user_sync_state_cursor_order_ck check (compacted_before_cursor < next_cursor)
);

create table if not exists user_sync_events (
  user_id text not null references users(id) on delete cascade,
  cursor bigint not null,
  event_id text not null references collaboration_events(id) on delete cascade,
  conversation_id text not null references conversations(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, cursor),
  unique (user_id, event_id),
  foreign key (event_id, conversation_id) references collaboration_events(id, conversation_id),
  constraint user_sync_events_cursor_ck check (cursor >= 1)
);

create index if not exists user_sync_events_user_cursor_idx
  on user_sync_events (user_id, cursor) include (event_id, conversation_id, created_at);
create index if not exists user_sync_events_conversation_cursor_idx
  on user_sync_events (conversation_id, cursor desc);

create table if not exists device_sync_state (
  user_id text not null,
  device_id text not null,
  last_acked_cursor bigint not null default 0,
  last_seen_at timestamptz not null default now(),
  requires_full_resync boolean not null default false,
  primary key (user_id, device_id),
  foreign key (user_id, device_id) references user_devices(user_id, device_id) on delete cascade,
  constraint device_sync_state_last_acked_cursor_ck check (last_acked_cursor >= 0)
);

create index if not exists device_sync_state_active_ack_idx
  on device_sync_state (user_id, requires_full_resync, last_acked_cursor, last_seen_at);

create table if not exists collaboration_realtime_outbox (
  id bigserial primary key,
  user_id text not null references users(id) on delete cascade,
  max_cursor bigint not null,
  state text not null default 'pending',
  available_at timestamptz not null default now(),
  lease_owner text,
  lease_expires_at timestamptz,
  attempts integer not null default 0,
  delivered_at timestamptz,
  created_at timestamptz not null default now(),
  constraint collaboration_realtime_outbox_cursor_ck check (max_cursor >= 1),
  constraint collaboration_realtime_outbox_state_ck check (state in ('pending', 'leased', 'delivered')),
  constraint collaboration_realtime_outbox_attempts_ck check (attempts >= 0)
);

create index if not exists collaboration_realtime_outbox_pending_idx
  on collaboration_realtime_outbox (available_at, id)
  where state in ('pending', 'leased');
create index if not exists collaboration_realtime_outbox_user_state_idx
  on collaboration_realtime_outbox (user_id, state, max_cursor desc);
