"use strict";

function migrateMessageRecoveryIndex(db) {
  db.exec(`
    CREATE INDEX idx_messages_session_turn_role
      ON messages(session_id, turn_id, role);
  `);
}

function migrateRuntimeEventCompactionIndex(db) {
  db.exec(`
    CREATE INDEX idx_runtime_events_compaction_candidates
      ON runtime_events(length(payload_json) DESC)
      WHERE type IN (
        'process.event',
        'subagent.event',
        'tool.started',
        'tool.input.done',
        'tool.done',
        'user.committed',
        'assistant.final',
        'turn.completed',
        'turn.failed',
        'turn.interrupted',
        'turn.stalled'
      );
  `);
}

module.exports = { migrateMessageRecoveryIndex, migrateRuntimeEventCompactionIndex };
