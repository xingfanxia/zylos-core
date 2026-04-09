-- Add target_instance column to conversations (NULL = legacy/default)
ALTER TABLE conversations ADD COLUMN target_instance TEXT DEFAULT NULL;
CREATE INDEX IF NOT EXISTS idx_conversations_target_instance ON conversations(target_instance, status, priority);

-- Add target_instance column to control_queue (NULL = legacy/default)
ALTER TABLE control_queue ADD COLUMN target_instance TEXT DEFAULT NULL;
CREATE INDEX IF NOT EXISTS idx_control_queue_target_instance ON control_queue(target_instance, status, priority);
