-- A workspace is an authorization domain, never a client filesystem path.
-- Old task envelopes remain valid with a NULL workspace identity.
CREATE TABLE collaboration_shared_workspaces (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id),
  owner_user_id TEXT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(id, conversation_id, owner_user_id)
);
ALTER TABLE collaboration_tasks ADD COLUMN shared_workspace_id TEXT;
ALTER TABLE collaboration_tasks ADD CONSTRAINT collaboration_task_workspace_owner_fk
  FOREIGN KEY (shared_workspace_id, conversation_id, requester_user_id)
  REFERENCES collaboration_shared_workspaces(id, conversation_id, owner_user_id);
CREATE INDEX collaboration_tasks_workspace_idx ON collaboration_tasks(shared_workspace_id, id)
  WHERE shared_workspace_id IS NOT NULL;
