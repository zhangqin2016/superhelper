-- Channels must never default to public when upgrading an existing database.
alter table conversations add column visibility text;
update conversations set visibility = 'private' where kind = 'channel';
alter table conversations add constraint conversations_visibility_ck check (
  (kind = 'channel' and visibility is not null and visibility in ('public', 'private'))
  or (kind <> 'channel' and visibility is null)
);
