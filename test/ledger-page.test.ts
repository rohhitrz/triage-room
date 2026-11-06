import assert from "node:assert/strict";
import test from "node:test";
import { scriptedDraft } from "../src/draft/llm.ts";
import { startLedger } from "../src/http/ledger.ts";
import { handleDomainMessage } from "../src/orchestrator.ts";
import type { DomainMessage } from "../src/switch/protocol.ts";
import { tempDb } from "./helpers.ts";

function message(body: string, messageId: string, threadId: string | null): DomainMessage {
  return {
    event: "message",
    id: messageId.length,
    data: {
      type: "message",
      room_id: "room_1",
      sequence: 1,
      payload: {
        addressed: true,
        sender: "owner-1",
        sender_name: "Rohit",
        message_id: messageId,
        body,
        timestamp: 1,
        thread_id: threadId,
      },
    },
  };
}

test("the ledger page is loopback-only and shows the block, then the simulated actions", async () => {
  const { db, close } = tempDb();
  const previous = process.env.LLM_API_KEY;
  process.env.LLM_API_KEY = "sk-test-secret";
  const server = await startLedger(db, 0);
  try {
    const options = {
      ownerId: "owner-1",
      today: "2026-11-06",
      provider: "scripted",
      model: "fixture",
      draft: async () => scriptedDraft("4821"),
    };
    await handleDomainMessage(db, message("@refund-desk Order #4821 charged twice, customer wants a refund.", "m1", "thr"), options);
    await handleDomainMessage(db, message("@refund-desk Approved, don't issue the refund.", "m2", "thr"), options);
    await handleDomainMessage(db, message("@refund-desk Approved, send the reply and flag finance.", "m3", "thr"), options);

    const address = server.address();
    assert.equal(typeof address, "object");
    assert.equal(address && typeof address === "object" ? address.address : "", "127.0.0.1");
    const port = address && typeof address === "object" ? address.port : 0;
    const html = await (await fetch(`http://127.0.0.1:${port}/`)).text();
    assert.match(html, /approval contained a negation/);
    assert.match(html, /Approved, don&#39;t issue the refund/);
    assert.match(html, /Simulated customer reply recorded\. No email was sent\./);
    assert.match(html, /Simulated finance flag recorded\. No finance system was contacted\./);
    assert.match(html, /issue_refund/);
    assert.equal(html.includes("sk-test-secret"), false);
    assert.equal(html.includes("Bearer"), false);
    const json = (await (await fetch(`http://127.0.0.1:${port}/api/ledger`)).json()) as {
      tickets: Array<{ status: string; actions: unknown[] }>;
    };
    assert.equal(json.tickets[0].status, "partially_executed");
    assert.equal(json.tickets[0].actions.length, 2);
    const posted = await fetch(`http://127.0.0.1:${port}/api/ledger`, { method: "POST" });
    assert.equal(posted.status, 404);
  } finally {
    process.env.LLM_API_KEY = previous;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    close();
  }
});
