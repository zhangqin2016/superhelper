-- Collaboration Center Slice 0: public, account-owned identity only.
-- Contacts discover a Lily ID; phone/email/login credentials never become
-- collaboration profile fields or search keys.

create table if not exists user_profiles (
  user_id text primary key references users(id) on delete cascade,
  lily_id text not null,
  lily_id_display text not null,
  display_name text not null default '',
  avatar_object_id text,
  discoverability text not null default 'contacts',
  updated_at timestamptz not null default now(),
  constraint user_profiles_lily_id_uk unique (lily_id),
  constraint user_profiles_discoverability_ck check (discoverability in ('public', 'contacts', 'hidden')),
  constraint user_profiles_lily_id_ck check (lily_id = lower(lily_id) and lily_id ~ '^[a-z0-9][a-z0-9_-]{2,63}$')
);

create index if not exists user_profiles_discoverability_idx
  on user_profiles (discoverability, updated_at desc);
