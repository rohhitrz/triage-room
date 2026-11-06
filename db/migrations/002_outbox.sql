ALTER TABLE tickets ADD COLUMN rendered_reply TEXT;
ALTER TABLE inbox ADD COLUMN next_attempt_at TEXT;
ALTER TABLE inbox ADD COLUMN last_error TEXT;

CREATE TABLE IF NOT EXISTS outbox (
  id TEXT PRIMARY KEY,
  inbox_id INTEGER,
  source_message_id TEXT NOT NULL UNIQUE,
  thread_id TEXT NOT NULL,
  body TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending', 'sent', 'dead')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL
);
