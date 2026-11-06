import assert from "node:assert/strict";
import test from "node:test";
import { claimNext, enqueueMessage, markCompleted } from "../src/ledger/inbox.ts";
import { enqueueGap } from "../src/ledger/inbox.ts";
import { reconcileAfterGap } from "../src/ledger/gap.ts";
import { handleDomainMessage } from "../src/orchestrator.ts";
import { scriptedDraft } from "../src/draft/llm.ts";
import { FakeSwitch } from "../src/switch/fake-server.ts";
import { RecoveryGate } from "../src/switch/recovery.ts";
import { SwitchClient } from "../src/switch/client.ts";
import type { DomainMessage } from "../src/switch/protocol.ts";
import { tempDb } from "./helpers.ts";

function approvalFrame(): DomainMessage {
  return {
    event: "message",
    id: 8,
    data: {
      type: "message",
      room_id: "room_1",
      sequence: 8,
      payload: {
        addressed: true,
        sender: "owner-1",
        sender_name: "Rohit",
        message_id: "msg_ok",
        body: "@refund-desk Approved, send the reply.",
        timestamp: 2,
        thread_id: "thr_1",
      },
    },
  };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > 2000) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test("an approval that arrives while read_context is slow does not execute", async () => {
  const fake = new FakeSwitch();
  await fake.start();
  const { db, close } = tempDb();
  const created = "2026-11-07T00:00:00.000Z";
  db.prepare(
    `INSERT INTO tickets (
      id, room_id, thread_id, source_message_id, order_id, label, eligibility, status, summary, proposal_version, created_at
    ) VALUES ('tkt_1', 'room_1', 'thr_1', 'src_1', '4821', 'refund', 'eligible', 'awaiting_approval', 'summary', 1, ?)`,
  ).run(created);
  db.prepare(
    `INSERT INTO proposals (id, ticket_id, proposal_version, action, status) VALUES ('pr_1', 'tkt_1', 1, 'send_reply', 'pending')`,
  ).run();

  const gate = new RecoveryGate();
  let releaseContext: () => void = () => {};
  const client = new SwitchClient({
    baseUrl: fake.baseUrl(),
    agentId: "agt_test",
    apiKey: "agent_test_key",
    connectionId: "conn-1",
    roomId: "room_1",
    getCursor: () => 0,
    recovery: gate,
    reconnect: false,
    onDomainEvent: async (frame) => {
      enqueueMessage(db, frame);
    },
    onGap: async (frame, messages) => {
      enqueueGap(db, frame);
      reconcileAfterGap(db, messages);
    },
  });
  let stop = false;
  const worker = (async () => {
    while (!stop) {
      await gate.wait();
      if (stop) return;
      const row = claimNext(db);
      if (!row) {
        await new Promise((resolve) => setTimeout(resolve, 5));
        continue;
      }
      await handleDomainMessage(db, JSON.parse(row.payload_json) as DomainMessage, {
        ownerId: "owner-1",
        today: "2026-11-06",
        provider: "scripted",
        model: "fixture",
        recovery: gate,
        draft: async () => scriptedDraft("4821"),
      });
      markCompleted(db, row.id);
    }
  })();

  try {
    await client.connect();
    fake.contextMessages = [];
    fake.holdContext = new Promise<void>((resolve) => {
      releaseContext = resolve;
    });
    fake.send(fake.sockets[0], { type: "gap", from_sequence: 1, resumed_at: 40, reason: "retention" });
    await waitFor(() => gate.held);
    fake.send(fake.sockets[0], approvalFrame());
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(gate.held, true);
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM actions").get() as { n: number }).n, 0);

    releaseContext();
    await waitFor(() => !gate.held);
    await waitFor(() => (db.prepare("SELECT needs_refresh FROM tickets WHERE id = 'tkt_1'").get() as { needs_refresh: number }).needs_refresh === 1);
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM actions").get() as { n: number }).n, 0);
    assert.equal((db.prepare("SELECT status FROM proposals WHERE id = 'pr_1'").get() as { status: string }).status, "pending");
  } finally {
    stop = true;
    gate.release();
    client.stop();
    await Promise.race([worker, new Promise((resolve) => setTimeout(resolve, 200))]);
    await fake.stop();
    close();
  }
});
