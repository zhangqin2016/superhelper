-- Immutable chronological task pagination, scoped by conversation.
CREATE INDEX collaboration_tasks_history_idx
  ON collaboration_tasks(conversation_id, created_at DESC, id DESC);
