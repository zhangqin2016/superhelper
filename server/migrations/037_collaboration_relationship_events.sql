-- Relationship transitions have no conversation until a request is accepted.
-- Keep them in the same immutable event/sync/outbox pipeline without creating
-- a phantom direct conversation merely to satisfy an event foreign key.

create sequence if not exists collaboration_relationship_event_seq;

alter table collaboration_events
  alter column conversation_id drop not null;

alter table user_sync_events
  alter column conversation_id drop not null;
