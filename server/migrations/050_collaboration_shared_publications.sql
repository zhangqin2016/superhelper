ALTER TABLE stored_objects ADD COLUMN shared_workspace_id TEXT REFERENCES collaboration_shared_workspaces(id);
ALTER TABLE stored_objects DROP CONSTRAINT stored_objects_binding_ck;
ALTER TABLE stored_objects ADD CONSTRAINT stored_objects_binding_ck CHECK (
  (state = 'bound' AND num_nonnulls(bound_message_id,task_id,shared_workspace_id) = 1)
  OR (state <> 'bound' AND num_nonnulls(bound_message_id,task_id,shared_workspace_id) <= 1)
);
CREATE INDEX stored_objects_workspace_idx ON stored_objects(shared_workspace_id) WHERE shared_workspace_id IS NOT NULL;
CREATE TABLE collaboration_shared_publications (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  owner_user_id TEXT NOT NULL,
  task_id TEXT NOT NULL REFERENCES collaboration_tasks(id),
  delivery_id TEXT NOT NULL REFERENCES collaboration_task_deliveries(id),
  object_id TEXT NOT NULL UNIQUE REFERENCES stored_objects(id),
  commit_id TEXT NOT NULL CHECK (commit_id ~ '^[a-f0-9]{40}$'),
  revision BIGINT NOT NULL CHECK (revision > 0 AND revision < 9007199254740991),
  content_ciphertext BYTEA NOT NULL,
  content_key_version INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY(workspace_id,conversation_id,owner_user_id) REFERENCES collaboration_shared_workspaces(id,conversation_id,owner_user_id),
  UNIQUE(workspace_id,revision)
);
ALTER TABLE collaboration_integration_targets ADD COLUMN head_publication_id TEXT REFERENCES collaboration_shared_publications(id);
