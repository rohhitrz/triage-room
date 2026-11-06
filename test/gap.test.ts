import assert from "node:assert/strict";
import test from "node:test";
import { executeApproval } from "../src/ledger/execute.ts";
import { reconcileAfterGap } from "../src/ledger/gap.ts";
import { parseContextMessages } from "../src/switch/protocol.ts";
import { tempDb } from "./helpers.ts";

test("read_context messages are parsed from the result envelope", () => {
  const parsed = parseContextMessages({
    result: { messages: [{ message_id: "src_1", body: "Order #4821", thread_id: "thr", sender: "owner-1" }] },
  });
  assert.equal(parsed[0]?.message_id, "src_1");
  assert.deepEqual(parseContextMessages({}), []);
});

test("a gap with unverified history clears the proposal so the old approval cannot execute", () => {
  const { db, close } = tempDb();
  try {
    const created = "2026-11-07T00:00:00.000Z";
    db.prepare(
      `INSERT INTO tickets (
        id, room_id, thread_id, source_message_id, order_id, label, eligibility, status, summary, proposal_version, created_at
      ) VALUES ('tkt_1', 'room_1', 'thr_1', 'src_1', '4821', 'refund', 'eligible', 'awaiting_approval', 'summary', 1, ?)`,
    ).run(created);
    db.prepare(
      `INSERT INTO proposals (id, ticket_id, proposal_version, action, status) VALUES ('pr_1', 'tkt_1', 1, 'send_reply', 'pending')`,
    ).run();
    db.prepare(
      `INSERT INTO approvals (
        id, ticket_id, message_id, thread_id, sender_id, proposal_version, verbatim, actions_json, created_at
      ) VALUES ('apr_1', 'tkt_1', 'msg_ok', 'thr_1', 'owner-1', 1, 'Approved, send the reply.', '["send_reply"]', ?)`,
    ).run(created);

    assert.deepEqual(
      reconcileAfterGap(db, [
        { message_id: "src_1", body: "", thread_id: "thr_1", sender: "owner-1" },
        { message_id: "msg_ok", body: "Approved, send the reply.", thread_id: "thr_1", sender: "owner-1" },
      ]),
      [],
    );
    assert.equal((db.prepare("SELECT needs_refresh FROM tickets WHERE id = 'tkt_1'").get() as { needs_refresh: number }).needs_refresh, 0);

    const refreshed = reconcileAfterGap(db, []);
    assert.deepEqual(refreshed, ["tkt_1"]);
    assert.equal((db.prepare("SELECT proposal_version, needs_refresh FROM tickets WHERE id = 'tkt_1'").get() as { proposal_version: number; needs_refresh: number }).proposal_version, 2);
    assert.throws(() => executeApproval(db, "apr_1"), /stale_approval/);
  } finally {
    close();
  }
});
