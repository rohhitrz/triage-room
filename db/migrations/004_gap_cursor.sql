ALTER TABLE checkpoint ADD COLUMN resume_sequence INTEGER NOT NULL DEFAULT 0;
ALTER TABLE checkpoint ADD COLUMN cursor_epoch INTEGER NOT NULL DEFAULT 1;
ALTER TABLE inbox ADD COLUMN cursor_epoch INTEGER NOT NULL DEFAULT 1;
ALTER TABLE tickets ADD COLUMN needs_refresh INTEGER NOT NULL DEFAULT 0;

DROP INDEX IF EXISTS inbox_sequence_idx;
CREATE UNIQUE INDEX IF NOT EXISTS inbox_epoch_sequence_idx ON inbox (cursor_epoch, sequence) WHERE sequence IS NOT NULL;
