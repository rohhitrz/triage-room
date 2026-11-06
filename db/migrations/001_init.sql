CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,
  customer_name TEXT NOT NULL,
  email TEXT NOT NULL,
  amount_inr INTEGER NOT NULL,
  charge_count INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('paid', 'refund_recorded')),
  placed_on TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS policy_clauses (
  id TEXT PRIMARY KEY,
  heading TEXT NOT NULL,
  body TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tickets (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  source_message_id TEXT NOT NULL UNIQUE,
  order_id TEXT REFERENCES orders(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  label TEXT NOT NULL,
  eligibility TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('awaiting_approval', 'partially_executed', 'closed')),
  summary TEXT NOT NULL,
  proposal_version INTEGER NOT NULL,
  finance_note TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS tickets_room_status_idx ON tickets (room_id, status);

CREATE TABLE IF NOT EXISTS drafts (
  id TEXT PRIMARY KEY,
  ticket_id TEXT NOT NULL REFERENCES tickets (id) ON DELETE CASCADE,
  proposal_version INTEGER NOT NULL,
  customer_reply TEXT NOT NULL,
  internal_note TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (ticket_id, proposal_version)
);

CREATE TABLE IF NOT EXISTS draft_citations (
  draft_id TEXT NOT NULL REFERENCES drafts (id) ON DELETE CASCADE,
  chunk_id TEXT NOT NULL,
  accepted INTEGER NOT NULL CHECK (accepted IN (0, 1)),
  PRIMARY KEY (draft_id, chunk_id)
);

CREATE TABLE IF NOT EXISTS proposals (
  id TEXT PRIMARY KEY,
  ticket_id TEXT NOT NULL REFERENCES tickets (id) ON DELETE CASCADE,
  proposal_version INTEGER NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('send_reply', 'flag_finance', 'issue_refund')),
  status TEXT NOT NULL CHECK (status IN ('pending', 'executed')),
  UNIQUE (ticket_id, proposal_version, action)
);

CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY,
  ticket_id TEXT NOT NULL REFERENCES tickets (id) ON DELETE CASCADE,
  message_id TEXT NOT NULL UNIQUE,
  thread_id TEXT NOT NULL,
  sender_id TEXT NOT NULL,
  proposal_version INTEGER NOT NULL,
  verbatim TEXT NOT NULL,
  actions_json TEXT NOT NULL,
  invalidated_at TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS approvals_ticket_idx ON approvals (ticket_id);

CREATE TABLE IF NOT EXISTS actions (
  id TEXT PRIMARY KEY,
  ticket_id TEXT NOT NULL REFERENCES tickets (id) ON DELETE CASCADE,
  proposal_id TEXT REFERENCES proposals (id) ON DELETE SET NULL,
  approval_id TEXT REFERENCES approvals (id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome = 'executed'),
  reason TEXT NOT NULL,
  simulated INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS actions_one_execution
  ON actions (proposal_id)
  WHERE outcome = 'executed' AND proposal_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS room_messages (
  message_id TEXT PRIMARY KEY,
  ticket_id TEXT REFERENCES tickets (id) ON DELETE SET NULL,
  room_id TEXT NOT NULL,
  thread_id TEXT,
  sender_id TEXT NOT NULL,
  sender_name TEXT,
  body TEXT NOT NULL,
  addressed INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS inbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sequence INTEGER,
  message_id TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('message', 'gap')),
  payload_json TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('queued', 'processing', 'completed', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  queued_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS inbox_sequence_idx ON inbox (sequence) WHERE sequence IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS inbox_message_idx ON inbox (message_id) WHERE message_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS checkpoint (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  queued_sequence INTEGER NOT NULL DEFAULT 0,
  generation TEXT
);

INSERT INTO checkpoint (id, queued_sequence)
SELECT 1, 0
WHERE NOT EXISTS (SELECT 1 FROM checkpoint WHERE id = 1);

CREATE TABLE IF NOT EXISTS audit_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id TEXT,
  kind TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS audit_ticket_idx ON audit_events (ticket_id, id);

CREATE TABLE IF NOT EXISTS llm_calls (
  id TEXT PRIMARY KEY,
  ticket_id TEXT,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  prompt_hash TEXT NOT NULL,
  response_json TEXT NOT NULL,
  latency_ms INTEGER,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);
