-- Shared coordination is independent of every device's SQLite writer lease.
-- The initial head is a task baseline already bound to a verified object.
CREATE TABLE collaboration_integration_targets (
  workspace_id TEXT PRIMARY KEY REFERENCES collaboration_shared_workspaces(id),
  head_commit TEXT NOT NULL CHECK (head_commit ~ '^[a-f0-9]{40}$'),
  revision BIGINT NOT NULL DEFAULT 0 CHECK (revision >= 0 AND revision < 9007199254740991),
  generation BIGINT NOT NULL DEFAULT 0 CHECK (generation >= 0 AND generation < 9007199254740991),
  lease_id TEXT,
  lease_device_id TEXT REFERENCES devices(id),
  lease_task_id TEXT REFERENCES collaboration_tasks(id),
  lease_delivery_id TEXT REFERENCES collaboration_task_deliveries(id),
  lease_expires_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((lease_id IS NULL AND lease_device_id IS NULL AND lease_task_id IS NULL AND lease_delivery_id IS NULL AND lease_expires_at IS NULL)
    OR (lease_id IS NOT NULL AND lease_device_id IS NOT NULL AND lease_task_id IS NOT NULL AND lease_delivery_id IS NOT NULL AND lease_expires_at IS NOT NULL))
);
