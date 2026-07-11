-- Moderated public wish pool. Raw submissions remain private until an admin
-- publishes reviewed copy. Supporters are account-bound and de-duplicated.
create table if not exists feature_wishes (
  id text primary key,
  submitter_user_id text not null references users(id) on delete cascade,
  title text not null,
  problem text not null,
  desired_outcome text not null,
  public_title text,
  public_title_i18n jsonb not null default '{}'::jsonb,
  public_summary text,
  public_summary_i18n jsonb not null default '{}'::jsonb,
  public_update text,
  public_update_i18n jsonb not null default '{}'::jsonb,
  submitter_status_note text,
  category text not null default 'other',
  status text not null default 'pending',
  merged_into_id text references feature_wishes(id) on delete set null,
  linked_app_ids jsonb not null default '[]'::jsonb,
  linked_skill_ids jsonb not null default '[]'::jsonb,
  published_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (status in ('pending','reviewing','published','planned','building','shipped','declined','merged')),
  check (category in ('office','research','communication','data','creative','developer','other'))
);

create table if not exists feature_wish_supporters (
  wish_id text not null references feature_wishes(id) on delete cascade,
  user_id text not null references users(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (wish_id, user_id)
);

create index if not exists feature_wishes_public_idx
  on feature_wishes (status, updated_at desc);

create index if not exists feature_wishes_category_idx
  on feature_wishes (category, status, updated_at desc);

create index if not exists feature_wishes_submitter_idx
  on feature_wishes (submitter_user_id, created_at desc);

create index if not exists feature_wish_supporters_user_idx
  on feature_wish_supporters (user_id, created_at desc);
