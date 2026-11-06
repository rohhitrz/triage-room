import type { DatabaseSync } from "node:sqlite";
import { invalidateOlderApprovals } from "./execute.ts";

export type ContextMessage = {
  message_id: string;
  body: string;
  thread_id: string | null;
  sender: string;
};

function now(): string {
  return new Date().toISOString();
}

export function reconcileAfterGap(db: DatabaseSync, messages: ContextMessage[]): string[] {
  const seen = new Set(messages.map((message) => message.message_id).filter(Boolean));
  const tickets = db
    .prepare("SELECT id, source_message_id, proposal_version FROM tickets WHERE needs_refresh = 0")
    .all() as Array<{ id: string; source_message_id: string; proposal_version: number }>;
  const refreshed: string[] = [];
  for (const ticket of tickets) {
    const approvals = db
      .prepare("SELECT message_id FROM approvals WHERE ticket_id = ? AND invalidated_at IS NULL AND proposal_version = ?")
      .all(ticket.id, ticket.proposal_version) as Array<{ message_id: string }>;
    const current = db
      .prepare("SELECT trigger_message_id FROM drafts WHERE ticket_id = ? AND proposal_version = ?")
      .get(ticket.id, ticket.proposal_version) as { trigger_message_id: string | null } | undefined;
    const proposalSource = current?.trigger_message_id
      ? current.trigger_message_id
      : ticket.proposal_version === 1
        ? ticket.source_message_id
        : null;
    const sourceSeen = proposalSource != null && seen.has(proposalSource);
    const approvalsSeen = approvals.every((row) => seen.has(row.message_id));
    if (sourceSeen && approvalsSeen) continue;
    const next = ticket.proposal_version + 1;
    db.prepare("UPDATE tickets SET proposal_version = ?, needs_refresh = 1 WHERE id = ?").run(next, ticket.id);
    invalidateOlderApprovals(db, ticket.id, next);
    db.prepare("INSERT INTO audit_events (ticket_id, kind, payload_json, created_at) VALUES (?, 'proposal_refreshed', ?, ?)").run(
      ticket.id,
      JSON.stringify({ reason: "gap_history_unverified", proposal_version: next }),
      now(),
    );
    refreshed.push(ticket.id);
  }
  return refreshed;
}
