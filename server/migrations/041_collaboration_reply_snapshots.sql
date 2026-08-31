-- Immutable send-time quotes use their own encrypted envelope. Existing replies
-- remain explicitly legacy-unavailable; never synthesize them from current text.
ALTER TABLE messages
  ADD COLUMN reply_snapshot_ciphertext BYTEA,
  ADD COLUMN reply_snapshot_key_version INTEGER,
  ADD CONSTRAINT messages_reply_snapshot_pair CHECK (
    (reply_snapshot_ciphertext IS NULL AND reply_snapshot_key_version IS NULL)
    OR (reply_snapshot_ciphertext IS NOT NULL AND reply_snapshot_key_version IS NOT NULL
      AND reply_snapshot_key_version > 0)
  );
