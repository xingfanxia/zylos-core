-- Uncertain delivery outcomes: a Fable-limit / usage-credits dialog was
-- classified right after the dispatcher sent Enter for this row. Whether the
-- message reached the model depends on how the dialog was answered, so the row
-- is neither delivered nor failed, and it is never replayed. The activity
-- monitor reads unnotified rows to tell the operator which message it was.
-- Additive: a new table; nothing existing changes.
CREATE TABLE IF NOT EXISTS delivery_uncertain (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    item_type TEXT NOT NULL,          -- 'conversation' | 'control'
    item_id INTEGER NOT NULL,         -- conversations.id / control_queue.id
    target_instance TEXT,
    channel TEXT,
    endpoint_id TEXT,
    session_ref TEXT,                 -- pane the Enter went to (session_id:session_created:pane_id:pane_pid)
    dialog_kind TEXT NOT NULL,        -- 'fable_limit' | 'credits_offer'
    outcome TEXT NOT NULL DEFAULT 'uncertain',
    detected_at INTEGER NOT NULL,
    notified_at INTEGER,
    UNIQUE (item_type, item_id)
);
CREATE INDEX IF NOT EXISTS idx_delivery_uncertain_notice ON delivery_uncertain(notified_at, target_instance);
