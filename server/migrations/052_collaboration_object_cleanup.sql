-- Support the bounded expiry sweep and pending cleanup lookup without indexing
-- completed provider work forever.
create index stored_objects_expiry_cleanup_idx on stored_objects(expires_at)
  where expires_at is not null and state in ('initiated','uploading','uploaded','verified','bound');
create index object_cleanup_jobs_available_idx on object_cleanup_jobs(available_at,object_id)
  where state in ('pending','leased');
