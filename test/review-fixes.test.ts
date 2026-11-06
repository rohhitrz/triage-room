import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import type { DatabaseSync } from "node:sqlite";
import { scriptedDraft } from "../src/draft/llm.ts";
import { loadLedger } from "../src/http/ledger.ts";
import { deliverQueued } from "../src/ledger/deliver.ts";
import { reconcileAfterGap, recordGap } from "../src/ledger/gap.ts";
import { claimNext, cursorEpoch, enqueueMessage, resumeSequence } from "../src/ledger/inbox.ts";
import { handleDomainMessage, type OrchestratorOptions } from "../src/orchestrator.ts";
import { buildDraftPrompt, assessOrder, allClauses, type OrderRow } from "../src/policy/ground.ts";
import { SwitchClient } from "../src/switch/client.ts";
import { FakeSwitch } from "../src/switch/fake-server.ts";
import type { DomainMessage } from "../src/switch/protocol.ts";
import { tempDb } from "./helpers.ts";

let seq = 0;
function frame(body: string, threadId: string | null, messageId: string, sender = "owner-1"): DomainMessage {
  seq += 1;
  return {
    event: "message",
    id: seq,
    data: {
      type: "message",
      room_id: "room_1",
      sequence: seq,
      payload: { addressed: true, sender, sender_name: "Rohit", message_id: messageId, body, timestamp: seq, thread_id: threadId },
    },
  };
}

function options(draft: OrchestratorOptions["draft"] = async ({ order }) => scriptedDraft(order.id)): OrchestratorOptions {
  return { ownerId: "owner-1", today: "2026-11-06", provider: "scripted", model: "fixture", draft };
}

async function deliver(db: DatabaseSync, f: DomainMessage, opts: OrchestratorOptions, posts: Array<{ body: string; thread: string }>) {
  enqueueMessage(db, f);
  const row = claimNext(db);
  assert.ok(row);
  return deliverQueued(db, row, opts, async (body, thread) => {
    posts.push({ body, thread });
  });
}

function count(db: DatabaseSync, sql: string, ...args: string[]): number {
  return Number((db.prepare(sql).get(...args) as { n: number }).n);
}

test("a refused approval is answered in the thread, audited once, and not retried", async () => {
  const { db, close } = tempDb();
  try {
    const opts = options();
    const posts: Array<{ body: string; thread: string }> = [];
    await deliver(db, frame("@refund-desk Order #4821 charged twice.", "thr_a", "open_a"), opts, posts);
    await deliver(db, frame("@refund-desk Order #4821 charged twice again.", "thr_b", "open_b"), opts, posts);
    await deliver(db, frame("@refund-desk Approved, issue the refund.", "thr_a", "ok_a"), opts, posts);

    const refused = frame("@refund-desk Approved, issue the refund.", "thr_b", "ok_b");
    const outcome = await deliver(db, refused, opts, posts);
    assert.equal(outcome, "sent");
    const last = posts.at(-1);
    assert.equal(last?.thread, "thr_b");
    assert.match(last?.body ?? "", /Blocked\. Nothing was executed\.\nReason: this order already has a refund recorded\./);

    // A replay of the same message gives the same answer without a second audit row.
    const again = await handleDomainMessage(db, refused, opts);
    assert.equal(again, last?.body);
    assert.equal(count(db, "SELECT COUNT(*) AS n FROM audit_events WHERE kind = 'approval_rejected' AND payload_json LIKE '%ok_b%'"), 1);
    assert.equal(count(db, "SELECT COUNT(*) AS n FROM order_refunds"), 1);
    assert.equal(count(db, "SELECT COUNT(*) AS n FROM inbox WHERE state = 'failed'"), 0);
  } finally {
    close();
  }
});

test("a gap is recorded and reconciled together, or not at all", async () => {
  const { db, close } = tempDb();
  try {
    await handleDomainMessage(db, frame("@refund-desk Order #4821 charged twice.", "thr_1", "open_1"), options());
    const cursorBefore = resumeSequence(db);
    const epochBefore = cursorEpoch(db);
    db.exec(
      `CREATE TEMP TRIGGER crash BEFORE INSERT ON audit_events WHEN NEW.kind = 'proposal_refreshed'
       BEGIN SELECT RAISE(ABORT, 'crash mid-gap'); END`,
    );
    assert.throws(() => recordGap(db, { type: "gap", from_sequence: 1, resumed_at: 50 }, []), /crash mid-gap/);
    assert.equal(resumeSequence(db), cursorBefore, "cursor must not move past an unreconciled gap");
    assert.equal(cursorEpoch(db), epochBefore);
    assert.equal(count(db, "SELECT COUNT(*) AS n FROM tickets WHERE needs_refresh = 1"), 0);

    db.exec("DROP TRIGGER crash");
    assert.equal(recordGap(db, { type: "gap", from_sequence: 1, resumed_at: 50 }, []).length, 1);
    assert.equal(resumeSequence(db), 50);
  } finally {
    close();
  }
});

test("a gap without resumed_at still clears proposals and leaves the cursor alone", async () => {
  const { db, close } = tempDb();
  try {
    await handleDomainMessage(db, frame("@refund-desk Order #4821 charged twice.", "thr_1", "open_1"), options());
    const cursorBefore = resumeSequence(db);
    assert.equal(recordGap(db, { type: "gap", from_sequence: 1 }, []).length, 1);
    assert.equal(resumeSequence(db), cursorBefore);
    assert.equal(count(db, "SELECT COUNT(*) AS n FROM audit_events WHERE kind = 'gap_without_cursor'"), 1);
  } finally {
    close();
  }
});

test("bad frames from Switch are logged and the client keeps running", async () => {
  const fake = new FakeSwitch();
  await fake.start();
  const seen: string[] = [];
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
  const quiet = console.error;
  console.error = () => {};
  const client = new SwitchClient({
    baseUrl: fake.baseUrl(),
    agentId: "agt_test",
    apiKey: "agent_test_key",
    connectionId: "conn-1",
    roomId: "room_1",
    getCursor: () => 0,
    onDomainEvent: async (f) => {
      seen.push(f.data.payload.message_id);
    },
    onGap: async () => {
      throw new Error("gap missing resumed_at");
    },
    reconnect: false,
  });
  try {
    await client.connect();
    const socket = fake.sockets[0];
    socket.send("this is not json");
    socket.send("null");
    socket.send(JSON.stringify({ type: "gap", from_sequence: 3 }));
    socket.send(JSON.stringify({ event: "message", id: 4, data: { type: "message" } }));
    const good = frame("@refund-desk hello", "thr_1", "good_1");
    socket.send(JSON.stringify(good));
    const start = Date.now();
    while (!seen.includes("good_1") && Date.now() - start < 2000) await new Promise((r) => setTimeout(r, 5));
    assert.deepEqual(seen, ["good_1"]);
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(unhandled.length, 0);
  } finally {
    console.error = quiet;
    process.off("unhandledRejection", onUnhandled);
    client.stop();
    await fake.stop();
  }
});

test("a closed ticket is left alone by a gap and still reads correctly on the ledger", async () => {
  const { db, close } = tempDb();
  try {
    const opts = options();
    await handleDomainMessage(db, frame("@refund-desk Order #4821 charged twice.", "thr_1", "open_1"), opts);
    await handleDomainMessage(db, frame("@refund-desk Approved.", "thr_1", "ok_1"), opts);
    assert.deepEqual(reconcileAfterGap(db, []), []);
    const [ticket] = loadLedger(db);
    assert.equal(ticket.status, "closed");
    assert.equal(ticket.proposal_version, 1);
    assert.match(ticket.customer_reply ?? "", /order #4821/);
    assert.deepEqual(
      ticket.proposals.map((row) => row.status),
      ["executed", "executed", "executed"],
    );
  } finally {
    close();
  }
});

test("a cleared open ticket still shows its last draft on the ledger", async () => {
  const { db, close } = tempDb();
  try {
    await handleDomainMessage(db, frame("@refund-desk Order #4821 charged twice.", "thr_1", "open_1"), options());
    assert.equal(reconcileAfterGap(db, []).length, 1);
    const [ticket] = loadLedger(db);
    assert.equal(ticket.needs_refresh, 1);
    assert.match(ticket.customer_reply ?? "", /order #4821/);
  } finally {
    close();
  }
});

test("an empty-string thread_id is treated as a root message and the reply still posts", async () => {
  const { db, close } = tempDb();
  try {
    const opts = options();
    const posts: Array<{ body: string; thread: string }> = [];
    const outcome = await deliver(db, frame("@refund-desk Order #4821 charged twice.", "", "root_1"), opts, posts);
    assert.equal(outcome, "sent");
    assert.equal(posts[0].thread, "root_1");
    assert.equal((db.prepare("SELECT thread_id FROM tickets").get() as { thread_id: string }).thread_id, "root_1");

    await deliver(db, frame("@refund-desk Approved, send the reply.", "root_1", "ok_1"), opts, posts);
    assert.match(posts[1].body, /send_reply executed/);
  } finally {
    close();
  }
});

test("a redraft records the real prompt hash and the model latency", async () => {
  const { db, close } = tempDb();
  try {
    const slow = options(async ({ order }) => {
      await new Promise((r) => setTimeout(r, 25));
      return scriptedDraft(order.id);
    });
    await handleDomainMessage(db, frame("@refund-desk Order #4821 charged twice.", "thr_1", "open_1"), slow);
    reconcileAfterGap(db, []);
    const repost = "@refund-desk Order #4821 charged twice, reposting.";
    const reply = await handleDomainMessage(db, frame(repost, "thr_1", "repost_1"), slow);
    assert.match(reply ?? "", /Unsent draft/);

    const order = db.prepare("SELECT * FROM orders WHERE id = '4821'").get() as OrderRow;
    const clauses = db.prepare("SELECT id, heading, body FROM policy_clauses ORDER BY id").all() as ReturnType<typeof allClauses>;
    const prompt = buildDraftPrompt({ order, clauses, ticketText: repost, assessment: assessOrder(order, "2026-11-06") });
    const expected = createHash("sha256").update(`${prompt.system}\n${prompt.user}`).digest("hex");
    const row = db.prepare("SELECT prompt_hash, latency_ms FROM llm_calls ORDER BY created_at DESC, rowid DESC LIMIT 1").get() as {
      prompt_hash: string;
      latency_ms: number;
    };
    assert.equal(row.prompt_hash, expected);
    assert.ok(row.latency_ms >= 20, `latency ${row.latency_ms}`);
  } finally {
    close();
  }
});
