import assert from "node:assert/strict";
import test from "node:test";
import { scriptedDraft } from "../src/draft/llm.ts";
import { executeApproval } from "../src/ledger/execute.ts";
import { reconcileAfterGap } from "../src/ledger/gap.ts";
import { handleDomainMessage } from "../src/orchestrator.ts";
import type { DomainMessage } from "../src/switch/protocol.ts";
import { tempDb } from "./helpers.ts";

function message(body: string, messageId: string): DomainMessage {
  return {
    event: "message",
    id: messageId.length,
    data: {
      type: "message",
      room_id: "room_1",
      sequence: 3,
      payload: {
        addressed: true,
        sender: "owner-1",
        sender_name: "Rohit",
        message_id: messageId,
        body,
        timestamp: 1,
        thread_id: "thr_1",
      },
    },
  };
}

test("the owner can repost the ticket in the same thread after a gap", async () => {
  const { db, close } = tempDb();
  try {
    const created = "2026-11-07T00:00:00.000Z";
    db.prepare(
      `INSERT INTO tickets (
        id, room_id, thread_id, source_message_id, order_id, label, eligibility, status, summary, proposal_version, created_at
      ) VALUES ('tkt_1', 'room_1', 'thr_1', 'src_1', '4821', 'refund', 'eligible', 'awaiting_approval', 'summary', 1, ?)`,
    ).run(created);
    db.prepare(
      `INSERT INTO proposals (id, ticket_id, proposal_version, action, status) VALUES ('pr_old', 'tkt_1', 1, 'issue_refund', 'pending')`,
    ).run();
    assert.deepEqual(reconcileAfterGap(db, []), ["tkt_1"]);
    let calls = 0;
    const options = {
      ownerId: "owner-1",
      today: "2026-11-06",
      provider: "scripted",
      model: "fixture",
      draft: async () => {
        calls += 1;
        return scriptedDraft("4821");
      },
    };
    const chatter = await handleDomainMessage(db, message("@refund-desk thanks", "m-chat"), options);
    assert.match(chatter ?? "", /Repost the ticket text in this thread/);
    assert.match(chatter ?? "", /new root message/);
    assert.equal(calls, 0);
    assert.equal((db.prepare("SELECT needs_refresh FROM tickets WHERE id = 'tkt_1'").get() as { needs_refresh: number }).needs_refresh, 1);

    const resent = await handleDomainMessage(
      db,
      message("@refund-desk Order #4821 charged twice, customer wants a refund.", "m-resend"),
      options,
    );
    assert.match(resent ?? "", /Unsent draft/);
    assert.equal(calls, 1);
    assert.equal((db.prepare("SELECT needs_refresh, proposal_version FROM tickets WHERE id = 'tkt_1'").get() as { needs_refresh: number; proposal_version: number }).needs_refresh, 0);
    const pending = db.prepare("SELECT action FROM proposals WHERE ticket_id = 'tkt_1' AND proposal_version = 2 AND status = 'pending'").all() as Array<{
      action: string;
    }>;
    assert.ok(pending.length >= 1);
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM actions").get() as { n: number }).n, 0);

    const again = await handleDomainMessage(
      db,
      message("@refund-desk Order #4821 charged twice, customer wants a refund.", "m-resend"),
      options,
    );
    assert.equal(again, resent);
    assert.equal(calls, 1);
  } finally {
    close();
  }
});

test("a refresh cannot draft one order and refund another", async () => {
  const { db, close } = tempDb();
  try {
    const created = "2026-11-07T00:00:00.000Z";
    db.prepare(
      `INSERT INTO tickets (
        id, room_id, thread_id, source_message_id, order_id, label, eligibility, status, summary, proposal_version, created_at
      ) VALUES ('tkt_old', 'room_1', 'thr_1', 'src_old', '1008', 'refund', 'ineligible', 'awaiting_approval', 'too old', 1, ?)`,
    ).run(created);
    assert.deepEqual(reconcileAfterGap(db, []), ["tkt_old"]);
    let calls = 0;
    const reply = await handleDomainMessage(db, message("@refund-desk Order #4821 charged twice, customer wants a refund.", "m-cross"), {
      ownerId: "owner-1",
      today: "2026-11-06",
      provider: "scripted",
      model: "fixture",
      draft: async () => {
        calls += 1;
        return scriptedDraft("4821");
      },
    });
    assert.match(reply ?? "", /new root message/i);
    assert.equal(calls, 0);
    assert.equal((db.prepare("SELECT order_id FROM tickets WHERE id = 'tkt_old'").get() as { order_id: string }).order_id, "1008");
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM proposals WHERE ticket_id = 'tkt_old' AND proposal_version = 2").get() as { n: number }).n, 0);
    assert.equal((db.prepare("SELECT status FROM orders WHERE id = '1008'").get() as { status: string }).status, "paid");
    assert.equal((db.prepare("SELECT status FROM orders WHERE id = '4821'").get() as { status: string }).status, "paid");

    db.prepare(
      `INSERT INTO proposals (id, ticket_id, proposal_version, action, status, order_id)
       VALUES ('pr_cross', 'tkt_old', 2, 'issue_refund', 'pending', '4821')`,
    ).run();
    db.prepare("UPDATE tickets SET needs_refresh = 0, proposal_version = 2 WHERE id = 'tkt_old'").run();
    db.prepare(
      `INSERT INTO approvals (
        id, ticket_id, message_id, thread_id, sender_id, proposal_version, verbatim, actions_json, created_at
      ) VALUES ('apr_cross', 'tkt_old', 'msg_cross', 'thr_1', 'owner-1', 2, 'Approved, issue the refund.', '["issue_refund"]', ?)`,
    ).run(created);
    assert.throws(() => executeApproval(db, "apr_cross"), /order_mismatch/);
    assert.equal((db.prepare("SELECT status FROM orders WHERE id = '1008'").get() as { status: string }).status, "paid");
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM order_refunds").get() as { n: number }).n, 0);
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM actions").get() as { n: number }).n, 0);
  } finally {
    close();
  }
});

test("a second gap verifies the refreshed proposal's own message", async () => {
  const { db, close } = tempDb();
  try {
    const created = "2026-11-07T00:00:00.000Z";
    db.prepare(
      `INSERT INTO tickets (
        id, room_id, thread_id, source_message_id, order_id, label, eligibility, status, summary, proposal_version, created_at
      ) VALUES ('tkt_1', 'room_1', 'thr_1', 'src_1', '4821', 'refund', 'eligible', 'awaiting_approval', 'summary', 1, ?)`,
    ).run(created);
    assert.deepEqual(reconcileAfterGap(db, []), ["tkt_1"]);
    await handleDomainMessage(db, message("@refund-desk Order #4821 charged twice, customer wants a refund.", "m-resend"), {
      ownerId: "owner-1",
      today: "2026-11-06",
      provider: "scripted",
      model: "fixture",
      draft: async () => scriptedDraft("4821"),
    });
    const kept = reconcileAfterGap(db, [{ message_id: "m-resend", body: "Order #4821", thread_id: "thr_1", sender: "owner-1" }]);
    assert.deepEqual(kept, []);
    assert.equal((db.prepare("SELECT needs_refresh, proposal_version FROM tickets WHERE id = 'tkt_1'").get() as { needs_refresh: number; proposal_version: number }).proposal_version, 2);

    const cleared = reconcileAfterGap(db, [{ message_id: "src_1", body: "original", thread_id: "thr_1", sender: "owner-1" }]);
    assert.deepEqual(cleared, ["tkt_1"]);
    const after = db.prepare("SELECT needs_refresh, proposal_version FROM tickets WHERE id = 'tkt_1'").get() as {
      needs_refresh: number;
      proposal_version: number;
    };
    assert.equal(after.needs_refresh, 1);
    assert.equal(after.proposal_version, 3);
  } finally {
    close();
  }
});
