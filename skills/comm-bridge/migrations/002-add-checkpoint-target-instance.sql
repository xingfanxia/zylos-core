-- Add target_instance column to checkpoints for per-instance checkpoint isolation.
-- Existing rows retain NULL (treated as global/legacy checkpoints).
ALTER TABLE checkpoints ADD COLUMN target_instance TEXT DEFAULT NULL;
CREATE INDEX IF NOT EXISTS idx_checkpoints_target_instance ON checkpoints(target_instance);
