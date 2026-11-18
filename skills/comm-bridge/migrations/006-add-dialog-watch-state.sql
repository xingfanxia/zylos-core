-- DELIVER-1 (2026-11-18), service-owned state for the activity monitor's
-- dialog watch, in this database (which personas cannot write; the persona
-- monitor directories are dual-writer):
--   dialog_watch_state: per instance, what is not in the queue (first-seen
--     time, next alert time, the prompt's title and notice rows). A hint the
--     watch re-validates against the queue and the live pane.
--   c4_process_capabilities: the running dispatcher / broker publish that they
--     understand control_queue.dialog_ref (pid, start time, refreshed while
--     they run, removed at exit). The watch queues nothing until they have.
-- At most one dialog-watch Escape and one decline message per instance, pane
-- and prompt, in any status: a restart or a lost state write can never queue
-- a second one.
-- Additive: new tables and indexes only.
CREATE TABLE IF NOT EXISTS dialog_watch_state (
    instance_key TEXT PRIMARY KEY,      -- target instance id; '' for single-session
    state TEXT NOT NULL,                -- JSON written by dialog-watch.js
    updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS c4_process_capabilities (
    process TEXT PRIMARY KEY,           -- 'c4-dispatcher' | 'c4-broker'
    pid INTEGER NOT NULL,
    started_at INTEGER NOT NULL,
    capabilities TEXT NOT NULL,         -- space-separated, e.g. 'dialog_ref'
    updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_control_queue_dialog_escape
    ON control_queue(COALESCE(target_instance, ''), session_ref, dialog_ref)
    WHERE dialog_ref IS NOT NULL AND raw_content = '[KEYSTROKE]Escape';
CREATE UNIQUE INDEX IF NOT EXISTS idx_control_queue_dialog_notice
    ON control_queue(COALESCE(target_instance, ''), session_ref, dialog_ref)
    WHERE dialog_ref IS NOT NULL AND substr(raw_content, 1, 11) != '[KEYSTROKE]';
