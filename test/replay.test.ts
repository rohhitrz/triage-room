import assert from "node:assert/strict";
import test from "node:test";
import { scriptedDraft } from "../src/draft/llm.ts";
import { deliverQueued } from "../src/ledger/deliver.ts";
import { claimNext, enqueueMessage, MAX_DELIVERY_ATTEMPTS, reclaimProcessing } from "../src/ledger/inbox.ts";
import { handleDomainMessage, type OrchestratorOptions } from "../src/orchestrator.ts";
import type { DomainMessage } from "../src/switch/protocol.ts";
import { tempDb } from "./helpers.ts";

function frame(body: string, messageId: string, sequence: number): DomainMessage {
  return {
    event: "message",
    id: sequence,
    data: {
      type: "message",
      room_id: "room_1",
      sequence,
      payload: {
        addressed: true,
        sender: "owner-1",
        sender_name: "Rohit",
        message_id: messageId,
        body,
        timestamp: 1,
        thread_id: "thr-4821",
      },
    },
  };
}

function options(draft: OrchestratorOptions["draft"]): OrchestratorOptions {
  return { ownerId: "owner-1", today: "2026-11-06", provider: "scripted", model: "fixture", draft };
}

test("a retry after the draft commits returns the saved draft and does not call the model again", async () => {
  const { db, close } = tempDb();
  try {
    let calls = 0;
    const opts = options(async () => {
      calls += 1;
      return scriptedDraft("4821");
    });
    const opening = frame("@refund-desk Order #4821 charged twice, customer wants a refund.", "m-open", 1);
    const first = await handleDomainMessage(db, opening, opts);
    const second = await handleDomainMessage(db, opening, opts);
    assert.match(first ?? "", /Unsent draft/);
    assert.equal(second, first);
    assert.equal(calls, 1);
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM llm_calls").get() as { n: number }).n, 1);
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE kind = 'approval_rejected'").get() as { n: number }).n, 0);
  } finally {
    close();
  }
});

test("a retry after execution commits returns the ledger result and does not execute again", async () => {
  const { db, close } = tempDb();
  try {
    let calls = 0;
    const opts = options(async () => {
      calls += 1;
      return scriptedDraft("4821");
    });
    await handleDomainMessage(db, frame("@refund-desk Order #4821 charged twice, customer wants a refund.", "m-open", 1), opts);
    const approval = frame("@refund-desk Approved, send the reply and flag finance.", "m-ok", 2);
    const first = await handleDomainMessage(db, approval, opts);
    const second = await handleDomainMessage(db, approval, opts);
    assert.match(first ?? "", /send_reply executed/);
    assert.equal(first?.includes("Blocked"), false);
    assert.equal(second, first);
    assert.equal(calls, 1);
    const perProposal = db.prepare("SELECT action, COUNT(*) AS n FROM actions GROUP BY action").all() as Array<{ action: string; n: number }>;
    for (const row of perProposal) assert.equal(row.n, 1);
    assert.equal(perProposal.length, 2);
  } finally {
    close();
  }
});

test("a failed chat post is requeued with the saved body and does not redraft", async () => {
  const { db, close } = tempDb();
  try {
    let calls = 0;
    const opts = options(async () => {
      calls += 1;
      return scriptedDraft("4821");
    });
    const opening = frame("@refund-desk Order #4821 charged twice, customer wants a refund.", "m-open", 4);
    enqueueMessage(db, opening);
    const claimed = claimNext(db);
    assert.ok(claimed);
    const sent: string[] = [];
    const first = await deliverQueued(db, claimed!, opts, async () => {
      throw new Error("socket down");
    }, () => 0);
    assert.equal(first, "retry");
    assert.equal(calls, 1);
    const again = claimNext(db);
    assert.ok(again);
    const second = await deliverQueued(db, again!, opts, async (body) => {
      sent.push(body);
    }, () => 0);
    assert.equal(second, "sent");
    assert.equal(calls, 1);
    assert.match(sent[0] ?? "", /Unsent draft/);
    assert.equal((db.prepare("SELECT state FROM outbox").get() as { state: string }).state, "sent");
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM actions").get() as { n: number }).n, 0);
  } finally {
    close();
  }
});

test("five delivery failures stay terminal after a restart", async () => {
  const { db, close } = tempDb();
  try {
    const opts = options(async () => scriptedDraft("4821"));
    enqueueMessage(db, frame("@refund-desk Order #4821 charged twice, customer wants a refund.", "m-dead", 6));
    let result = "";
    for (let attempt = 0; attempt < MAX_DELIVERY_ATTEMPTS; attempt += 1) {
      const row = claimNext(db);
      assert.ok(row);
      result = await deliverQueued(db, row, opts, async () => {
        throw new Error("socket down");
      }, () => 0);
    }
    assert.equal(result, "dead");
    assert.equal((db.prepare("SELECT state FROM inbox WHERE message_id = 'm-dead'").get() as { state: string }).state, "failed");
    assert.equal((db.prepare("SELECT state FROM outbox WHERE source_message_id = 'm-dead'").get() as { state: string }).state, "dead");
    reclaimProcessing(db);
    assert.equal(claimNext(db), null);
    db.prepare("UPDATE inbox SET state = 'queued', attempts = 0, next_attempt_at = NULL WHERE message_id = 'm-dead'").run();
    const forced = claimNext(db);
    assert.ok(forced);
    let posted = 0;
    const again = await deliverQueued(db, forced, opts, async () => {
      posted += 1;
    }, () => 0);
    assert.equal(again, "dead");
    assert.equal(posted, 0);
  } finally {
    close();
  }
});
