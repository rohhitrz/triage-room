CREATE TABLE IF NOT EXISTS order_refunds (
  order_id TEXT PRIMARY KEY,
  ticket_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);
