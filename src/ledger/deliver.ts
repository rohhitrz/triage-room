import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { OrchestratorOptions } from "../orchestrator.ts";
import { handleDomainMessage } from "../orchestrator.ts";
import type { DomainMessage } from "../switch/protocol.ts";
import { markCompleted, markFailed, scheduleDeliveryRetry, type InboxRow } from "./inbox.ts";

function now(): string {
  return new Date().toISOString();
}

type OutboxRow = { id: string; body: string; thread_id: string; state: string };

export async function deliverQueued(
  db: DatabaseSync,
  row: InboxRow,
  options: OrchestratorOptions,
  post: (body: string, threadId: string) => Promise<void>,
  backoffMs: (attempt: number) => number = (attempt) => Math.min(30_000, 200 * 2 ** Math.max(0, attempt - 1)),
): Promise<"sent" | "retry" | "dead" | "skipped"> {
  const frame = JSON.parse(row.payload_json) as DomainMessage;
  const messageId = frame.data.payload.message_id;
  let stored = db.prepare("SELECT id, body, thread_id, state FROM outbox WHERE source_message_id = ?").get(messageId) as OutboxRow | undefined;
  if (stored?.state === "sent") {
    markCompleted(db, row.id);
    return "sent";
  }
  if (stored?.state === "dead") {
    markFailed(db, row.id);
    return "dead";
  }
  if (!stored) {
    const text = await handleDomainMessage(db, frame, options);
    if (!text) {
      markCompleted(db, row.id);
      return "skipped";
    }
    const threadId = frame.data.payload.thread_id ?? threadFor(db, messageId) ?? messageId;
    const id = randomUUID();
    db.prepare(
      `INSERT INTO outbox (id, inbox_id, source_message_id, thread_id, body, state, attempts, created_at)
       VALUES (?, ?, ?, ?, ?, 'pending', 0, ?)`,
    ).run(id, row.id, messageId, threadId, text, now());
    stored = { id, body: text, thread_id: threadId, state: "pending" };
  }
  try {
    await post(stored.body, stored.thread_id);
    db.prepare("UPDATE outbox SET state = 'sent' WHERE id = ?").run(stored.id);
    markCompleted(db, row.id);
    return "sent";
  } catch (error) {
    return scheduleDeliveryRetry(db, row.id, error, backoffMs(row.attempts));
  }
}

function threadFor(db: DatabaseSync, messageId: string): string | null {
  const ticket = db.prepare("SELECT thread_id FROM tickets WHERE source_message_id = ?").get(messageId) as { thread_id: string } | undefined;
  return ticket?.thread_id ?? null;
}
