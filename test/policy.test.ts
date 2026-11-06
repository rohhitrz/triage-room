import assert from "node:assert/strict";
import test from "node:test";
import { DEMO_TODAY } from "../src/db/seed.ts";
import { allClauses, assessOrder, buildDraftPrompt, composeDraftPost, splitCitations, type OrderRow } from "../src/policy/ground.ts";
import { tempDb } from "./helpers.ts";

function order(id: string): OrderRow {
  return {
    id,
    customer_name: "Asha Menon",
    email: "asha@example.com",
    amount_inr: 1299,
    charge_count: id === "2204" ? 1 : 2,
    status: "paid",
    placed_on: id === "1008" ? "2026-07-01" : id === "2204" ? "2026-11-05" : "2026-11-04",
  };
}

test("eligibility is computed in code and every clause is available to the prompt", () => {
  const clauses = allClauses();
  assert.equal(clauses.length, 3);
  const eligible = assessOrder(order("4821"), DEMO_TODAY);
  assert.equal(eligible.eligibility, "eligible");
  assert.deepEqual(eligible.proposedActions, ["send_reply", "flag_finance", "issue_refund"]);
  const old = assessOrder(order("1008"), DEMO_TODAY);
  assert.equal(old.eligibility, "ineligible");
  assert.deepEqual(old.proposedActions, ["send_reply"]);
  assert.equal(old.proposedActions.includes("issue_refund"), false);
  const single = assessOrder(order("2204"), DEMO_TODAY);
  assert.equal(single.label, "question");
  assert.deepEqual(single.proposedActions, ["send_reply"]);

  const prompt = buildDraftPrompt({
    order: order("4821"),
    clauses,
    ticketText: "Order #4821 charged twice",
    assessment: eligible,
  });
  for (const clause of clauses) {
    assert.match(prompt.user, new RegExp(clause.heading));
    assert.match(prompt.user, new RegExp(clause.id));
  }
  assert.match(prompt.system, /Do not claim/);
});

test("unsupported citations are rejected and the reply stays an unsent draft", () => {
  const known = allClauses().map((clause) => clause.id);
  const split = splitCitations(["duplicate-charge", "made-up-policy", "window"], known);
  assert.deepEqual(split.accepted, ["duplicate-charge", "window"]);
  assert.deepEqual(split.rejected, ["made-up-policy"]);
  const post = composeDraftPost({
    assessment: assessOrder(order("4821"), DEMO_TODAY),
    customerReply: "We will look at the duplicate charge.",
    clauses: allClauses(),
    acceptedCitationIds: split.accepted,
    version: 1,
  });
  assert.match(post, /Unsent draft \(not sent to the customer\)/);
  assert.match(post, /We will look at the duplicate charge/);
  assert.equal(post.includes("made-up-policy"), false);
  assert.match(post, /Nothing has been executed/);
  assert.match(post, /Pending approval \(version 1\): send_reply, flag_finance, issue_refund/);
});

test("seeded orders match the code assessment", () => {
  const { db, close } = tempDb();
  try {
    const rows = db.prepare("SELECT * FROM orders").all() as OrderRow[];
    const byId = new Map(rows.map((row) => [row.id, row]));
    assert.equal(assessOrder(byId.get("4821")!, DEMO_TODAY).eligibility, "eligible");
    assert.equal(assessOrder(byId.get("1008")!, DEMO_TODAY).eligibility, "ineligible");
    assert.equal(assessOrder(byId.get("2204")!, DEMO_TODAY).label, "question");
    const stored = db.prepare("SELECT id FROM policy_clauses").all() as Array<{ id: string }>;
    assert.equal(stored.length, 3);
  } finally {
    close();
  }
});
