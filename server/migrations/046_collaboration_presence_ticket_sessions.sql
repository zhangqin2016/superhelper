-- New tickets bind presence to the authenticated session. Existing nullable
-- tickets retain transport compatibility but cannot prove Redis online state.
alter table collaboration_ws_tickets
  add column if not exists session_id text references user_sessions(id) on delete set null;
