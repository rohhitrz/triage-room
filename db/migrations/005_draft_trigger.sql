ALTER TABLE drafts ADD COLUMN trigger_message_id TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS drafts_trigger_idx ON drafts (trigger_message_id) WHERE trigger_message_id IS NOT NULL;
