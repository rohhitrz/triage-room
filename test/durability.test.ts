import assert from "node:assert/strict";
import test from "node:test";
import type { DatabaseSync } from "node:sqlite";
import { executeApproval, composeLedgerPost, SIMULATED_REASON } from "../src/ledger/execute.ts";
import { checkpoint, claimNext, enqueueGap, enqueueMessage, markCompleted, reclaimProcessing } from "../src/ledger/inbox.ts";
import type { DomainMessage } from "../src/switch/protocol.ts";
import { tempDb } from "./helpers.ts";

function frame(id: number, messageId = `m${id}`): DomainMessage {
  return {
    event: "message",
    id,
    data: {
      type: "message",
      room_id: "room_1",
      sequence: id,
      payload: {
        addressed: true,
        sender: "owner-1",
        message_id: messageId,
        body: "Order #4821 charged twice",
        timestamp: 1,
        thread_id: "thr_1",
      },
    },
  };
}

function seedTicket(db: DatabaseSync, version = 1): void {
  const created = "2026-11-07T00:00:00.000Z";
  db.prepare(
    `INSERT INTO tickets (
      id, room_id, thread_id, source_message_id, order_id, label, eligibility, status, summary, proposal_version, created_at
    ) VALUES ('tkt_1', 'room_1', 'thr_1', 'msg_src', '4821', 'refund', 'eligible', 'awaiting_approval', 'summary', ?, ?)`,
  ).run(version, created);
  db.prepare(
    `INSERT INTO drafts (id, ticket_id, proposal_version, customer_reply, internal_note, created_at)
     VALUES ('drf_1', 'tkt_1', ?, 'Hello', 'note', ?)`,
  ).run(version, created);
  for (const action of ["send_reply", "flag_finance", "issue_refund"]) {
    db.prepare(
      `INSERT INTO proposals (id, ticket_id, proposal_version, action, status) VALUES (?, 'tkt_1', ?, ?, 'pending')`,
    ).run(`pr_${action}`, version, action);
  }
  db.prepare(
    `INSERT INTO approvals (
      id, ticket_id, message_id, thread_id, sender_id, proposal_version, verbatim, actions_json, created_at
    ) VALUES ('apr_1', 'tkt_1', 'msg_ok', 'thr_1', 'owner-1', ?, 'Approved, send the reply and flag finance.', ?, ?)`,
  ).run(version, JSON.stringify(["send_reply", "flag_finance"]), created);
}

test("a crash after queue resumes once and a duplicate does not execute twice", () => {
  const { db, close } = tempDb();
  try {
    assert.equal(enqueueMessage(db, frame(5)), "queued");
    assert.equal(checkpoint(db), 5);
    assert.equal(enqueueMessage(db, frame(5)), "resume");
    db.prepare("UPDATE inbox SET state = 'processing' WHERE sequence = 5").run();
    reclaimProcessing(db);
    const row = claimNext(db);
    assert.ok(row);
    assert.equal(row?.sequence, 5);
    markCompleted(db, row!.id);
    assert.equal(enqueueMessage(db, frame(5)), "completed");
    assert.equal(claimNext(db), null);
    const count = db.prepare("SELECT COUNT(*) AS n FROM inbox WHERE message_id = 'm5'").get() as { n: number };
    assert.equal(count.n, 1);
  } finally {
    close();
  }
});

test("a gap and a disconnect do not advance the checkpoint or finish the queued work", () => {
  const { db, close } = tempDb();
  try {
    enqueueMessage(db, frame(3));
    enqueueGap(db, { type: "gap", from_sequence: 1, resumed_at: 99, reason: "retention" });
    assert.equal(checkpoint(db), 3);
    const queued = db.prepare("SELECT state FROM inbox WHERE sequence = 3").get() as { state: string };
    assert.equal(queued.state, "queued");
    const gapAudit = db.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE kind = 'gap'").get() as { n: number };
    assert.equal(gapAudit.n, 1);
  } finally {
    close();
  }
});

test("execution rechecks the approval and rolls back together", () => {
  const { db, close } = tempDb();
  try {
    seedTicket(db, 1);
    db.prepare("UPDATE tickets SET proposal_version = 2").run();
    assert.throws(() => executeApproval(db, "apr_1"), /stale_approval/);
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM actions").get() as { n: number }).n, 0);
    assert.equal(
      (db.prepare("SELECT status FROM proposals WHERE action = 'send_reply'").get() as { status: string }).status,
      "pending",
    );
    assert.equal((db.prepare("SELECT status FROM orders WHERE id = '4821'").get() as { status: string }).status, "paid");

    db.prepare("UPDATE tickets SET proposal_version = 1").run();
    assert.throws(() => executeApproval(db, "apr_1", { fault: "after_insert" }), /fault/);
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM actions").get() as { n: number }).n, 0);
    assert.equal((db.prepare("SELECT finance_note FROM tickets WHERE id = 'tkt_1'").get() as { finance_note: string | null }).finance_note, null);
    assert.equal((db.prepare("SELECT status FROM orders WHERE id = '4821'").get() as { status: string }).status, "paid");

    executeApproval(db, "apr_1");
    const text = composeLedgerPost(db, "tkt_1");
    assert.match(text, new RegExp(SIMULATED_REASON.send_reply));
    assert.match(text, new RegExp(SIMULATED_REASON.flag_finance));
    assert.match(text, /issue_refund pending\. Not executed\./);
    assert.equal(text.includes("refused"), false);
    assert.equal((db.prepare("SELECT status FROM tickets WHERE id = 'tkt_1'").get() as { status: string }).status, "partially_executed");
    assert.equal((db.prepare("SELECT status FROM orders WHERE id = '4821'").get() as { status: string }).status, "paid");
    assert.throws(() => executeApproval(db, "apr_1"), /not_proposed/);
  } finally {
    close();
  }
});
