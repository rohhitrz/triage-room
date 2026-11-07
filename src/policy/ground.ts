import type { Action } from "../approval/parse.ts";
import { daysBetween, POLICY } from "../db/seed.ts";

export type OrderRow = {
  id: string;
  customer_name: string;
  email: string;
  amount_inr: number;
  charge_count: number;
  status: string;
  placed_on: string;
};

export type Clause = { id: string; heading: string; body: string };

export type Assessment = {
  label: "refund" | "question";
  eligibility: "eligible" | "ineligible";
  proposedActions: Action[];
  usedClauseIds: string[];
  summary: string;
};

export function allClauses(): Clause[] {
  return POLICY.map((clause) => ({ ...clause }));
}

export function assessOrder(order: OrderRow, today: string): Assessment {
  const age = daysBetween(order.placed_on, today);
  const inWindow = age >= 0 && age <= 30;
  const duplicate = order.charge_count >= 2;
  if (order.status === "refund_recorded") {
    return {
      label: "refund",
      eligibility: "ineligible",
      proposedActions: ["send_reply"],
      usedClauseIds: ["duplicate-charge", "window"],
      summary: `Order #${order.id} already has one refund record. A second refund is not proposed.`,
    };
  }
  if (duplicate && inWindow) {
    return {
      label: "refund",
      eligibility: "eligible",
      proposedActions: ["send_reply", "flag_finance", "issue_refund"],
      usedClauseIds: ["duplicate-charge", "window"],
      summary: `Order #${order.id} was charged ${order.charge_count} times and is inside the 30-day window (${age} days).`,
    };
  }
  if (duplicate) {
    return {
      label: "refund",
      eligibility: "ineligible",
      proposedActions: ["send_reply"],
      usedClauseIds: ["duplicate-charge", "window"],
      summary: `Order #${order.id} was charged twice and is outside the 30-day window (${age} days).`,
    };
  }
  return {
    label: "question",
    eligibility: "ineligible",
    proposedActions: ["send_reply"],
    usedClauseIds: ["not-received"],
    summary: `Order #${order.id} has a single charge. This is not a duplicate-charge refund.`,
  };
}

export function splitCitations(cited: string[], known: string[]): { accepted: string[]; rejected: string[] } {
  const allowed = new Set(known);
  const accepted: string[] = [];
  const rejected: string[] = [];
  for (const id of cited) {
    if (allowed.has(id) && !accepted.includes(id)) accepted.push(id);
    else if (!allowed.has(id) && !rejected.includes(id)) rejected.push(id);
  }
  return { accepted, rejected };
}

export function renderUnsentDraft(customerReply: string): string {
  return `Unsent draft (not sent to the customer):\n${customerReply.trim()}`;
}

export function buildDraftPrompt(input: {
  order: OrderRow;
  clauses: Clause[];
  ticketText: string;
  assessment: Assessment;
}): { system: string; user: string } {
  const clauses = input.clauses
    .map((clause) => `id: ${clause.id}\nheading: ${clause.heading}\nbody: ${clause.body}`)
    .join("\n\n");
  return {
    system:
      "You are a support agent at Northwind Goods writing to a customer about their order. " +
      "Return one JSON object with customer_reply, internal_note, and cited_chunk_ids. " +
      "customer_reply is the message the support team will send TO the customer: address the customer by name, " +
      "write as the company (we/our), never as the customer, and keep it to 2-4 short sentences. " +
      "Follow the code eligibility exactly: if eligible, say we are reviewing the duplicate charge for a refund; " +
      "if ineligible, explain the reason politely from the policy and offer further help. " +
      "Do not decide eligibility yourself. Do not claim that a reply was sent, finance was flagged, or a refund was recorded or issued. " +
      "internal_note is one line for the support team. cited_chunk_ids lists the policy clause ids you relied on.",
    user: [
      `Ticket: ${input.ticketText}`,
      `Order: ${JSON.stringify(input.order)}`,
      `Code eligibility: ${input.assessment.eligibility}. Label: ${input.assessment.label}.`,
      `Code summary: ${input.assessment.summary}`,
      "Policy clauses:",
      clauses,
    ].join("\n\n"),
  };
}

export function composeDraftPost(input: {
  assessment: Assessment;
  customerReply: string;
  clauses: Clause[];
  acceptedCitationIds: string[];
  version: number;
}): string {
  const used = input.clauses.filter((clause) => input.assessment.usedClauseIds.includes(clause.id));
  const cited = input.clauses.filter((clause) => input.acceptedCitationIds.includes(clause.id));
  const headings = [...used, ...cited.filter((clause) => !used.includes(clause))].map((clause) => clause.heading);
  return [
    input.assessment.summary,
    `Label: ${input.assessment.label}. Eligibility: ${input.assessment.eligibility} (computed from the order and the policy, not from the model).`,
    `Policy used: ${headings.join("; ")}.`,
    "",
    renderUnsentDraft(input.customerReply),
    "",
    `Pending approval (version ${input.version}): ${input.assessment.proposedActions.join(", ")}.`,
    "Nothing has been executed.",
  ].join("\n");
}
