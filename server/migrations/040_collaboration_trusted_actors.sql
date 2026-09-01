-- Trusted enterprise HTTP actions have no signed device command. Preserve the
-- original device provenance invariants rather than manufacturing a device.
alter table collaboration_events
  add column actor_source text not null default 'device',
  add column audit_actor text,
  alter column actor_user_id drop not null,
  alter column actor_device_id drop not null;

alter table collaboration_events add constraint collaboration_events_actor_source_ck check (
  (actor_source = 'device' and actor_user_id is not null and actor_device_id is not null and audit_actor is null)
  or (actor_source = 'enterprise-web' and actor_user_id is not null and actor_device_id is null and audit_actor is null
      and conversation_id is null and type in ('scope.revoked', 'directory.changed'))
  or (actor_source = 'platform-admin' and actor_user_id is null and actor_device_id is null
      and audit_actor is not null and length(trim(audit_actor)) > 0
      and conversation_id is null and type in ('scope.revoked', 'directory.changed'))
);
