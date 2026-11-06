import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { Action } from "../approval/parse.ts";

export const SIMULATED_REASON: Record<Action, string> = {
  send_reply: "Simulated customer reply recorded. No email was sent.",
  flag_finance: "Simulated finance flag recorded. No finance system was contacted.",
  issue_refund: "Simulated refund record written. No payment was moved.",
};

type ApprovalRow = {
  id: string;
  ticket_id: string;
  thread_id: string;
  sender_id: string;
  proposal_version: number;
  actions_json: string;
  invalidated_at: string | null;
};

type TicketRow = {
  id: string;
  thread_id: string;
  order_id: string | null;
  proposal_version: number;
};

type ProposalRow = { id: string; action: Action; status: string; order_id: string | null };

function now(): string {
  return new Date().toISOString();
}

export function executeApproval(db: DatabaseSync, approvalId: string, options?: { fault?: "after_insert" }): void {
  db.exec("BEGIN IMMEDIATE");
  try {
    const approval = db.prepare("SELECT * FROM approvals WHERE id = ?").get(approvalId) as ApprovalRow | undefined;
    if (!approval) throw new Error("missing_approval");
    const ticket = db.prepare("SELECT * FROM tickets WHERE id = ?").get(approval.ticket_id) as TicketRow | undefined;
    if (!ticket) throw new Error("missing_ticket");
    if (approval.invalidated_at || approval.proposal_version !== ticket.proposal_version) throw new Error("stale_approval");
    if (!approval.thread_id || approval.thread_id !== ticket.thread_id) throw new Error("wrong_thread");
    const names = JSON.parse(approval.actions_json) as Action[];
    const proposals = db
      .prepare(
        `SELECT id, action, status, order_id FROM proposals
         WHERE ticket_id = ? AND proposal_version = ?`,
      )
      .all(ticket.id, ticket.proposal_version) as ProposalRow[];
    const pending = new Map(proposals.filter((row) => row.status === "pending").map((row) => [row.action, row]));
    for (const name of names) {
      if (!pending.has(name)) throw new Error("not_proposed");
    }
    for (const name of names) {
      const proposal = pending.get(name);
      if (!proposal) throw new Error("not_proposed");
      if (proposal.order_id != null && proposal.order_id !== ticket.order_id) throw new Error("order_mismatch");
      if (name === "issue_refund" && proposal.order_id !== ticket.order_id) throw new Error("order_mismatch");
      db.prepare(
        `INSERT INTO actions (id, ticket_id, proposal_id, approval_id, action, outcome, reason, simulated, created_at)
         VALUES (?, ?, ?, ?, ?, 'executed', ?, 1, ?)`,
      ).run(randomUUID(), ticket.id, proposal.id, approval.id, name, SIMULATED_REASON[name], now());
      db.prepare("UPDATE proposals SET status = 'executed' WHERE id = ?").run(proposal.id);
      if (name === "flag_finance") {
        db.prepare("UPDATE tickets SET finance_note = ? WHERE id = ?").run(SIMULATED_REASON.flag_finance, ticket.id);
      }
      if (name === "issue_refund") {
        if (!ticket.order_id) throw new Error("refund_already_recorded");
        const updated = db.prepare("UPDATE orders SET status = 'refund_recorded' WHERE id = ? AND status = 'paid'").run(ticket.order_id) as {
          changes: number;
        };
        if (Number(updated.changes) !== 1) throw new Error("refund_already_recorded");
        db.prepare("INSERT INTO order_refunds (order_id, ticket_id, created_at) VALUES (?, ?, ?)").run(ticket.order_id, ticket.id, now());
      }
      db.prepare("INSERT INTO audit_events (ticket_id, kind, payload_json, created_at) VALUES (?, 'action_executed', ?, ?)").run(
        ticket.id,
        JSON.stringify({ action: name, reason: SIMULATED_REASON[name] }),
        now(),
      );
      if (options?.fault === "after_insert") throw new Error("fault");
    }
    const stillPending = (
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM proposals
           WHERE ticket_id = ? AND proposal_version = ? AND status = 'pending'`,
        )
        .get(ticket.id, ticket.proposal_version) as { n: number }
    ).n;
    const executed = (
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM proposals
           WHERE ticket_id = ? AND proposal_version = ? AND status = 'executed'`,
        )
        .get(ticket.id, ticket.proposal_version) as { n: number }
    ).n;
    const status = stillPending === 0 ? "closed" : executed > 0 ? "partially_executed" : "awaiting_approval";
    db.prepare("UPDATE tickets SET status = ? WHERE id = ?").run(status, ticket.id);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function invalidateOlderApprovals(db: DatabaseSync, ticketId: string, currentVersion: number): void {
  db.prepare(
    `UPDATE approvals SET invalidated_at = ?
     WHERE ticket_id = ? AND proposal_version < ? AND invalidated_at IS NULL`,
  ).run(now(), ticketId, currentVersion);
}

export function composeLedgerPost(db: DatabaseSync, ticketId: string): string {
  const ticket = db.prepare("SELECT proposal_version FROM tickets WHERE id = ?").get(ticketId) as {
    proposal_version: number;
  };
  const actions = db
    .prepare("SELECT action, reason FROM actions WHERE ticket_id = ? AND outcome = 'executed' ORDER BY created_at, action")
    .all(ticketId) as Array<{ action: string; reason: string }>;
  const pending = db
    .prepare(
      `SELECT action FROM proposals
       WHERE ticket_id = ? AND proposal_version = ? AND status = 'pending'
       ORDER BY action`,
    )
    .all(ticketId, ticket.proposal_version) as Array<{ action: string }>;
  const lines = ["Ledger results:"];
  for (const row of actions) lines.push(`- ${row.action} executed. ${row.reason}`);
  for (const row of pending) lines.push(`- ${row.action} pending. Not executed.`);
  return lines.join("\n");
}
