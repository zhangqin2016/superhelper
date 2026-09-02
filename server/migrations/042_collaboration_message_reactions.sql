-- Reactions are a small, non-secret, per-(message, user, emoji) fact, so they
-- live in their own projection rather than as another column on messages: a
-- reaction must never rewrite a message revision or disturb the reply snapshot
-- and edit/revoke conflict detection that hang off it.
--
-- One row per (message, user, emoji) makes "toggle" an insert/delete instead of
-- a read-modify-write, so two devices reacting at once cannot clobber each
-- other. The emoji is stored as text and bounded; the server never interprets
-- it beyond length, so new emoji need no migration.
CREATE TABLE collaboration_message_reactions (
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  emoji TEXT NOT NULL CHECK (char_length(emoji) BETWEEN 1 AND 32),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (message_id, user_id, emoji)
);

CREATE INDEX collaboration_message_reactions_conversation_idx
  ON collaboration_message_reactions (conversation_id, message_id);
