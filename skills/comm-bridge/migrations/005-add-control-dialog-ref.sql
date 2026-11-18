-- Dialog binding for a control (DELIVER-1, 2026-11-18): the id of the one
-- permission prompt the activity monitor's dialog watch cancels with this
-- Escape, or whose decline it announces. NULL for every other row. Out of
-- band on purpose: the row's content stays the plain `[KEYSTROKE]Escape` (or
-- plain text) that every dispatcher version understands; a dispatcher that
-- knows this column sends the Escape only while that very prompt is on the
-- bound pane (session_ref). Additive: ADD COLUMN with a NULL default.
ALTER TABLE control_queue ADD COLUMN dialog_ref TEXT DEFAULT NULL;
