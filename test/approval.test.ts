import assert from "node:assert/strict";
import test from "node:test";
import { bindApproval, parseApproval, type Action } from "../src/approval/parse.ts";

const pending: Action[] = ["send_reply", "flag_finance", "issue_refund"];

function bind(overrides: Partial<Parameters<typeof bindApproval>[0]> = {}) {
  return bindApproval({
    body: "Approved",
    senderId: "owner-1",
    threadId: "thr-1",
    ownerId: "owner-1",
    ticketThreadId: "thr-1",
    approvalVersion: 1,
    currentVersion: 1,
    pending,
    ...overrides,
  });
}

test("negation and ambiguous wording do not approve", () => {
  assert.equal(parseApproval("Approved, don't issue the refund").ok, false);
  assert.equal(parseApproval("Approved, don't send the reply").reason, "negation");
  assert.equal(parseApproval("Approved, do not send the reply").reason, "negation");
  assert.equal(parseApproval("Approved, send the reply but not the refund").reason, "negation");
  assert.equal(parseApproval("Approved, send the reply?").reason, "ambiguous");
  assert.equal(parseApproval("Approved, send the reply and wire the money").reason, "ambiguous");
  assert.equal(parseApproval("looks good").reason, "not_approval");
  assert.equal(parseApproval("the customer approved by email").reason, "not_approval");
  const blocked = bind({ body: "Approved, don't issue the refund" });
  assert.equal(blocked.ok, false);
  if (!blocked.ok) assert.equal(blocked.reason, "negation");
});

test("bare Approved and an affirmative list bind the exact actions", () => {
  const bare = bind();
  assert.deepEqual(bare.ok && bare.actions, pending);
  const named = bind({ body: "@refund-desk Approved, send the reply and flag finance." });
  assert.deepEqual(named.ok && named.actions, ["send_reply", "flag_finance"]);
  const tokens = bind({ body: "Approved: send_reply, flag_finance" });
  assert.deepEqual(tokens.ok && tokens.actions, ["send_reply", "flag_finance"]);
});

test("wrong thread, null thread, and wrong sender are rejected", () => {
  assert.equal(bind({ threadId: "other" }).ok && false, false);
  assert.equal((bind({ threadId: "other" }) as { reason: string }).reason, "wrong_thread");
  assert.equal((bind({ threadId: null }) as { reason: string }).reason, "wrong_thread");
  assert.equal((bind({ senderId: "someone-else" }) as { reason: string }).reason, "wrong_sender");
  assert.equal((bind({ ownerId: null }) as { reason: string }).reason, "owner_not_configured");
});

test("a stale proposal version does not approve", () => {
  assert.equal((bind({ approvalVersion: 1, currentVersion: 2 }) as { reason: string }).reason, "stale_approval");
  assert.equal((bind({ invalidatedAt: "2026-11-07T00:00:00.000Z" }) as { reason: string }).reason, "stale_approval");
  assert.equal((bind({ body: "Approved, issue the refund", pending: ["send_reply"] }) as { reason: string }).reason, "not_proposed");
});
