import assert from "node:assert/strict";
import test from "node:test";
import { assertRunnableMode, chatBody, liveDraft, parseDraft, resolveChat, scriptedDraft, validateLlmEnv } from "../src/draft/llm.ts";
import { handleDomainMessage, type OrchestratorOptions } from "../src/orchestrator.ts";
import type { DomainMessage } from "../src/switch/protocol.ts";
import { tempDb } from "./helpers.ts";

function message(body: string, extras: Partial<DomainMessage["data"]["payload"]> = {}): DomainMessage {
  return {
    event: "message",
    id: extras.message_id === "m-block" ? 2 : extras.message_id === "m-ok" ? 3 : 1,
    data: {
      type: "message",
      room_id: "room_1",
      sequence: 1,
      payload: {
        addressed: true,
        sender: "owner-1",
        sender_name: "Rohit",
        message_id: "m-open",
        body,
        timestamp: 1,
        thread_id: null,
        ...extras,
      },
    },
  };
}

function options(draft: OrchestratorOptions["draft"]): OrchestratorOptions {
  return { ownerId: "owner-1", today: "2026-11-06", provider: "scripted", model: "fixture", draft };
}

test("an empty LLM_BASE_URL keeps the OpenAI and Gemini defaults", () => {
  assert.equal(resolveChat("openai", undefined, "").url, "https://api.openai.com/v1/chat/completions");
  assert.equal(resolveChat("openai", "  ", "   ").model, "gpt-4o-mini");
  assert.equal(
    resolveChat("gemini", undefined, "").url,
    "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
  );
  assert.equal(resolveChat("gemini", "", "").model, "gemini-2.5-flash");
  assert.throws(() => validateLlmEnv({ LLM_BASE_URL: "not a url", LLM_PROVIDER: "openai" }), /not a URL/);
  assert.doesNotThrow(() => validateLlmEnv({ LLM_BASE_URL: "", LLM_PROVIDER: "gemini" }));
});

test("npm start refuses scripted mode and the live client calls the configured model", async () => {
  assert.throws(() => assertRunnableMode("scripted"), /tests only/);
  assert.doesNotThrow(() => assertRunnableMode("live"));
  const openai = resolveChat("openai", undefined, undefined);
  assert.equal(openai.url, "https://api.openai.com/v1/chat/completions");
  assert.equal(openai.model, "gpt-4o-mini");
  const gemini = resolveChat("gemini", undefined, undefined);
  assert.equal(gemini.url, "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions");
  assert.equal(gemini.model, "gemini-2.5-flash");

  let called = 0;
  const fetchImpl: typeof fetch = async (url, init) => {
    called += 1;
    assert.equal(String(url), openai.url);
    const body = JSON.parse(String(init?.body));
    assert.equal(body.temperature, 0);
    assert.deepEqual(body.response_format, { type: "json_object" });
    assert.match(body.messages[1].content, /Duplicate charge/);
    assert.match(body.messages[1].content, /Refund window/);
    assert.match(body.messages[1].content, /Parcel not received/);
    assert.match(body.messages[0].content, /Do not claim/);
    return new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify({
                customer_reply: "We are reviewing the duplicate charge.",
                internal_note: "note",
                cited_chunk_ids: ["duplicate-charge"],
                eligibility: "ineligible",
              }),
            },
          },
        ],
      }),
      { status: 200 },
    );
  };
  const { db, close } = tempDb();
  try {
    const order = db.prepare("SELECT * FROM orders WHERE id = '4821'").get() as Parameters<typeof liveDraft>[0]["order"];
    const clauses = db.prepare("SELECT id, heading, body FROM policy_clauses").all() as Parameters<typeof liveDraft>[0]["clauses"];
    const assessment = {
      label: "refund" as const,
      eligibility: "eligible" as const,
      proposedActions: ["send_reply", "flag_finance", "issue_refund"] as Array<"send_reply" | "flag_finance" | "issue_refund">,
      usedClauseIds: ["duplicate-charge", "window"],
      summary: "eligible",
    };
    const drafted = await liveDraft({
      provider: "openai",
      apiKey: "test-key",
      order,
      clauses,
      ticketText: "Order #4821 charged twice",
      assessment,
      fetchImpl,
    });
    assert.equal(called, 1);
    assert.equal(drafted.customer_reply, "We are reviewing the duplicate charge.");
    assert.equal(parseDraft("```json\n{\"customer_reply\":\"Hi\"}\n```").customer_reply, "Hi");
  } finally {
    close();
  }
});

test("a scripted draft still stores code eligibility, and a live failure does not substitute the fixture", async () => {
  const { db, close } = tempDb();
  try {
    let fetches = 0;
    const post = await handleDomainMessage(
      db,
      message("Order #4821 charged twice, customer wants a refund."),
      options(async () => {
        fetches += 1;
        return scriptedDraft("4821");
      }),
    );
    assert.equal(fetches, 1);
    assert.match(post ?? "", /Unsent draft \(not sent to the customer\)/);
    assert.match(post ?? "", /fixture for tests/);
    const ticket = db.prepare("SELECT eligibility, label, proposal_version FROM tickets").get() as {
      eligibility: string;
      label: string;
      proposal_version: number;
    };
    assert.equal(ticket.eligibility, "eligible");
    assert.equal(ticket.label, "refund");
    const actions = db.prepare("SELECT action FROM proposals ORDER BY action").all() as Array<{ action: string }>;
    assert.deepEqual(
      actions.map((row) => row.action),
      ["flag_finance", "issue_refund", "send_reply"],
    );

    const failed = await handleDomainMessage(
      db,
      message("Order #2204 where is my parcel?", { message_id: "m-fail", thread_id: null }),
      options(async () => {
        throw new Error("provider down");
      }),
    );
    assert.match(failed ?? "", /couldn't draft/);
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM tickets").get() as { n: number }).n, 1);
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE kind = 'model_failed'").get() as { n: number }).n, 1);
  } finally {
    close();
  }
});

test("the filmed sequence blocks a negation, then executes only the authorized simulated actions", async () => {
  const { db, close } = tempDb();
  try {
    const opened = await handleDomainMessage(
      db,
      message("@refund-desk Order #4821 charged twice, customer wants a refund.", { thread_id: "thr-4821", message_id: "m-open" }),
      options(async (input) => ({
        customer_reply: "We can see two charges on 4821.",
        internal_note: "note",
        cited_chunk_ids: ["duplicate-charge", "invented-clause"],
      })),
    );
    assert.match(opened ?? "", /Nothing has been executed/);
    assert.equal(opened?.includes("invented-clause"), false);
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE kind = 'citation_rejected'").get() as { n: number }).n, 1);

    const blocked = await handleDomainMessage(
      db,
      message("@refund-desk Approved, don't issue the refund.", { thread_id: "thr-4821", message_id: "m-block" }),
      options(async () => scriptedDraft("4821")),
    );
    assert.match(blocked ?? "", /Blocked\. Nothing was executed\./);
    assert.match(blocked ?? "", /negation/);
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM actions").get() as { n: number }).n, 0);

    const allowed = await handleDomainMessage(
      db,
      message("@refund-desk Approved, send the reply and flag finance.", { thread_id: "thr-4821", message_id: "m-ok" }),
      options(async () => scriptedDraft("4821")),
    );
    assert.match(allowed ?? "", /send_reply executed\. Simulated customer reply recorded\. No email was sent\./);
    assert.match(allowed ?? "", /flag_finance executed\. Simulated finance flag recorded\. No finance system was contacted\./);
    assert.match(allowed ?? "", /issue_refund pending\. Not executed\./);
    assert.equal(allowed?.includes("refused"), false);
    const order = db.prepare("SELECT status FROM orders WHERE id = '4821'").get() as { status: string };
    assert.equal(order.status, "paid");
  } finally {
    close();
  }
});

test("reasoning models get no temperature, and only OpenAI gets JSON mode", () => {
  const prompt = { system: "Return one JSON object.", user: "Ticket" };
  assert.equal(chatBody("openai", "gpt-4o-mini", prompt).temperature, 0);
  assert.equal("temperature" in chatBody("openai", "gpt-5-mini", prompt), false);
  assert.equal("temperature" in chatBody("openai", "o4-mini", prompt), false);
  assert.deepEqual(chatBody("openai", "gpt-5-mini", prompt).response_format, { type: "json_object" });
  assert.equal("response_format" in chatBody("gemini", "gemini-2.5-flash", prompt), false);
});
