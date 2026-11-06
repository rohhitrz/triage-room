import type { DatabaseSync } from "node:sqlite";
import type { DomainMessage, GapFrame } from "../switch/protocol.ts";

export type InboxRow = {
  id: number;
  sequence: number | null;
  message_id: string | null;
  kind: string;
  payload_json: string;
  state: string;
  attempts: number;
};

function now(): string {
  return new Date().toISOString();
}

export function checkpoint(db: DatabaseSync): number {
  const row = db.prepare("SELECT queued_sequence AS n FROM checkpoint WHERE id = 1").get() as { n: number };
  return row.n;
}

export function resumeSequence(db: DatabaseSync): number {
  const row = db.prepare("SELECT resume_sequence AS n FROM checkpoint WHERE id = 1").get() as { n: number };
  return row.n;
}

export function cursorEpoch(db: DatabaseSync): number {
  const row = db.prepare("SELECT cursor_epoch AS n FROM checkpoint WHERE id = 1").get() as { n: number };
  return row.n;
}

export function enqueueMessage(db: DatabaseSync, frame: DomainMessage): "queued" | "resume" | "completed" {
  const sequence = frame.id;
  const messageId = frame.data.payload.message_id;
  const epoch = cursorEpoch(db);
  const byMessage = db.prepare("SELECT state FROM inbox WHERE message_id = ?").get(messageId) as { state: string } | undefined;
  if (byMessage) return byMessage.state === "completed" ? "completed" : "resume";
  const bySequence = db.prepare("SELECT state FROM inbox WHERE sequence = ? AND cursor_epoch = ?").get(sequence, epoch) as
    | { state: string }
    | undefined;
  if (bySequence) return bySequence.state === "completed" ? "completed" : "resume";
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare(
      `INSERT INTO inbox (sequence, message_id, kind, payload_json, state, attempts, queued_at, cursor_epoch)
       VALUES (?, ?, 'message', ?, 'queued', 0, ?, ?)`,
    ).run(sequence, messageId, JSON.stringify(frame), now(), epoch);
    db.prepare("UPDATE checkpoint SET queued_sequence = ?, resume_sequence = ? WHERE id = 1").run(sequence, sequence);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return "queued";
}

export function enqueueGap(db: DatabaseSync, frame: GapFrame): void {
  if (typeof frame.resumed_at !== "number") throw new Error("gap missing resumed_at");
  const receipt = checkpoint(db);
  db.prepare(
    `INSERT INTO inbox (kind, payload_json, state, attempts, queued_at)
     VALUES ('gap', ?, 'completed', 0, ?)`,
  ).run(JSON.stringify(frame), now());
  db.prepare("UPDATE checkpoint SET resume_sequence = ?, cursor_epoch = cursor_epoch + 1 WHERE id = 1").run(frame.resumed_at);
  db.prepare("INSERT INTO audit_events (ticket_id, kind, payload_json, created_at) VALUES (NULL, 'gap', ?, ?)").run(
    JSON.stringify(frame),
    now(),
  );
  if (checkpoint(db) !== receipt) throw new Error("gap moved the receipt cursor");
}

export const MAX_DELIVERY_ATTEMPTS = 5;

export function reclaimProcessing(db: DatabaseSync): void {
  db.prepare("UPDATE inbox SET state = 'failed' WHERE state = 'processing' AND attempts >= ?").run(MAX_DELIVERY_ATTEMPTS);
  db.prepare("UPDATE inbox SET state = 'queued' WHERE state = 'processing' AND attempts < ?").run(MAX_DELIVERY_ATTEMPTS);
}

export function claimNext(db: DatabaseSync): InboxRow | null {
  db.exec("BEGIN IMMEDIATE");
  try {
    const row = db
      .prepare(
        `SELECT id, sequence, message_id, kind, payload_json, state, attempts
         FROM inbox WHERE state = 'queued' AND kind = 'message'
           AND attempts < ?
           AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
         ORDER BY sequence ASC LIMIT 1`,
      )
      .get(MAX_DELIVERY_ATTEMPTS, now()) as InboxRow | undefined;
    if (!row) {
      db.exec("COMMIT");
      return null;
    }
    db.prepare("UPDATE inbox SET state = 'processing', started_at = ?, attempts = attempts + 1 WHERE id = ?").run(now(), row.id);
    db.exec("COMMIT");
    return { ...row, state: "processing" };
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function markCompleted(db: DatabaseSync, id: number): void {
  db.prepare("UPDATE inbox SET state = 'completed', finished_at = ? WHERE id = ?").run(now(), id);
}

export function markFailed(db: DatabaseSync, id: number): void {
  db.prepare("UPDATE inbox SET state = 'failed', finished_at = ? WHERE id = ?").run(now(), id);
}

export function scheduleDeliveryRetry(db: DatabaseSync, inboxId: number, error: unknown, backoffMs: number): "retry" | "dead" {
  const row = db.prepare("SELECT attempts FROM inbox WHERE id = ?").get(inboxId) as { attempts: number };
  const message = error instanceof Error ? error.message : String(error);
  if (row.attempts >= MAX_DELIVERY_ATTEMPTS) {
    markFailed(db, inboxId);
    db.prepare("UPDATE inbox SET last_error = ? WHERE id = ?").run(message, inboxId);
    db.prepare("UPDATE outbox SET state = 'dead', last_error = ? WHERE inbox_id = ? AND state = 'pending'").run(message, inboxId);
    return "dead";
  }
  const when = new Date(Date.now() + backoffMs).toISOString();
  db.prepare("UPDATE inbox SET state = 'queued', next_attempt_at = ?, last_error = ? WHERE id = ?").run(when, message, inboxId);
  db.prepare("UPDATE outbox SET attempts = attempts + 1, next_attempt_at = ?, last_error = ? WHERE inbox_id = ? AND state = 'pending'").run(
    when,
    message,
    inboxId,
  );
  return "retry";
}
