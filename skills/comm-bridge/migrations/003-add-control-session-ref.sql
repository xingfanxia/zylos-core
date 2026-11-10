-- Session fence for [KEYSTROKE] controls: the tmux pane identity
-- (session_id:session_created:pane_id:pane_pid) a key is meant for.
-- NULL = unbound (rows written before this migration, or enqueuers that do not
-- pass one); the dispatcher binds an unbound key to the pane it reads at claim.
-- Additive: ADD COLUMN with a NULL default is a metadata-only change in SQLite.
ALTER TABLE control_queue ADD COLUMN session_ref TEXT DEFAULT NULL;
CREATE INDEX IF NOT EXISTS idx_control_queue_session_ref ON control_queue(target_instance, session_ref, status);
