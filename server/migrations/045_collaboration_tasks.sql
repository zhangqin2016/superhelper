-- Task content is an encrypted envelope. Events expose only identity/version;
-- access is resolved through explicit task parties plus current scope access.
CREATE TABLE collaboration_tasks (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id),
  requester_user_id TEXT NOT NULL REFERENCES users(id),
  assignee_user_id TEXT NOT NULL REFERENCES users(id),
  input_snapshot_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('offered','active','declined','review','changes_requested','accepted','cancelled')),
  revision BIGINT NOT NULL CHECK (revision > 0),
  content_ciphertext BYTEA NOT NULL,
  content_key_version INTEGER NOT NULL CHECK (content_key_version > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (requester_user_id <> assignee_user_id)
);
CREATE INDEX collaboration_tasks_requester_idx ON collaboration_tasks(requester_user_id, updated_at DESC, id);
CREATE INDEX collaboration_tasks_assignee_idx ON collaboration_tasks(assignee_user_id, updated_at DESC, id);
CREATE INDEX collaboration_tasks_conversation_idx ON collaboration_tasks(conversation_id, id);

ALTER TABLE stored_objects ADD COLUMN task_id TEXT REFERENCES collaboration_tasks(id) DEFERRABLE INITIALLY DEFERRED;
-- Replace the legacy unnamed "bound means message" constraint. Other object
-- lifecycle and scope constraints remain untouched.
DO $$ DECLARE existing_name text; BEGIN
  FOR existing_name IN SELECT conname FROM pg_constraint WHERE conrelid='stored_objects'::regclass
    AND contype='c' AND pg_get_constraintdef(oid) LIKE '%bound_message_id%'
  LOOP EXECUTE format('ALTER TABLE stored_objects DROP CONSTRAINT %I',existing_name); END LOOP;
END $$;
ALTER TABLE stored_objects ADD CONSTRAINT stored_objects_binding_ck CHECK (
  (state = 'bound' AND ((bound_message_id IS NOT NULL AND task_id IS NULL) OR (bound_message_id IS NULL AND task_id IS NOT NULL)))
  OR (state <> 'bound' AND NOT (bound_message_id IS NOT NULL AND task_id IS NOT NULL))
);
CREATE INDEX stored_objects_task_idx ON stored_objects(task_id) WHERE task_id IS NOT NULL;

-- Uploaded packages require separate task-scoped authorization. There is no
-- implicit foreign key to conversation-scoped objects granting task access.
CREATE TABLE collaboration_task_deliveries (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES collaboration_tasks(id),
  input_snapshot_id TEXT NOT NULL,
  manifest_hash TEXT NOT NULL CHECK (manifest_hash ~ '^[a-f0-9]{64}$'),
  submitted_by TEXT NOT NULL REFERENCES users(id),
  task_revision BIGINT NOT NULL CHECK (task_revision > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(task_id, task_revision)
);
