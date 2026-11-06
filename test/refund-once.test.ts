import assert from "node:assert/strict";
import test from "node:test";
import type { DatabaseSync } from "node:sqlite";
import { executeApproval } from "../src/ledger/execute.ts";
import { assessOrder, type OrderRow } from "../src/policy/ground.ts";
import { DEMO_TODAY } from "../src/db/seed.ts";
import { tempDb } from "./helpers.ts";

function threadTicket(db: DatabaseSync, id: string, threadId: string, sourceId: string, approvalId: string, messageId: string): void {
  const created = "2026-11-07T00:00:00.000Z";
  db.prepare(
    `INSERT INTO tickets (
      id, room_id, thread_id, source_message_id, order_id, label, eligibility, status, summary, proposal_version, created_at
    ) VALUES (?, 'room_1', ?, ?, '4821', 'refund', 'eligible', 'awaiting_approval', 'summary', 1, ?)`,
  ).run(id, threadId, sourceId, created);
  db.prepare(
    `INSERT INTO proposals (id, ticket_id, proposal_version, action, status, order_id) VALUES (?, ?, 1, 'issue_refund', 'pending', '4821')`,
  ).run(`pr_${id}`, id);
  db.prepare(
    `INSERT INTO approvals (
      id, ticket_id, message_id, thread_id, sender_id, proposal_version, verbatim, actions_json, created_at
    ) VALUES (?, ?, ?, ?, 'owner-1', 1, 'Approved, issue the refund.', '["issue_refund"]', ?)`,
  ).run(approvalId, id, messageId, threadId, created);
}

test("two threads cannot both record a refund for order 4821", () => {
  const { db, close } = tempDb();
  try {
    threadTicket(db, "tkt_a", "thr_a", "src_a", "apr_a", "msg_a");
    threadTicket(db, "tkt_b", "thr_b", "src_b", "apr_b", "msg_b");
    executeApproval(db, "apr_a");
    assert.throws(() => executeApproval(db, "apr_b"), /refund_already_recorded/);
    assert.equal((db.prepare("SELECT status FROM orders WHERE id = '4821'").get() as { status: string }).status, "refund_recorded");
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM order_refunds").get() as { n: number }).n, 1);
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM actions WHERE ticket_id = 'tkt_b'").get() as { n: number }).n, 0);
    assert.equal(
      (db.prepare("SELECT status FROM proposals WHERE ticket_id = 'tkt_b'").get() as { status: string }).status,
      "pending",
    );
    const order = db.prepare("SELECT * FROM orders WHERE id = '4821'").get() as OrderRow;
    assert.deepEqual(assessOrder(order, DEMO_TODAY).proposedActions, ["send_reply"]);
  } finally {
    close();
  }
});
