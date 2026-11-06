import type { DatabaseSync } from "node:sqlite";
import type { GapFrame } from "../switch/protocol.ts";
import { invalidateOlderApprovals } from "./execute.ts";
import { enqueueGap } from "./inbox.ts";

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
    // A closed ticket has nothing left to approve, so a gap cannot put it at risk. Leave it as it was.
    .prepare("SELECT id, source_message_id, proposal_version FROM tickets WHERE needs_refresh = 0 AND status <> 'closed'")
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

// Records the gap and clears unverified proposals in one transaction. If the process dies
// part way, neither happens, so it can never resume past the gap with stale approvals live.
// A gap without resumed_at still clears proposals but leaves the cursor where it was.
export function recordGap(db: DatabaseSync, frame: GapFrame, messages: ContextMessage[]): string[] {
  db.exec("BEGIN IMMEDIATE");
  try {
    if (typeof frame.resumed_at === "number") {
      enqueueGap(db, frame);
    } else {
      db.prepare("INSERT INTO audit_events (ticket_id, kind, payload_json, created_at) VALUES (NULL, 'gap_without_cursor', ?, ?)").run(
        JSON.stringify(frame),
        now(),
      );
    }
    const refreshed = reconcileAfterGap(db, messages);
    db.exec("COMMIT");
    return refreshed;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
