CREATE TABLE collaboration_shared_baselines (
  workspace_id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  owner_user_id TEXT NOT NULL,
  source_task_id TEXT NOT NULL REFERENCES collaboration_tasks(id),
  source_object_id TEXT NOT NULL UNIQUE REFERENCES stored_objects(id),
  commit_id TEXT NOT NULL CHECK (commit_id ~ '^[a-f0-9]{40}$'),
  content_ciphertext BYTEA NOT NULL,
  content_key_version INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY(workspace_id,conversation_id,owner_user_id) REFERENCES collaboration_shared_workspaces(id,conversation_id,owner_user_id)
);
