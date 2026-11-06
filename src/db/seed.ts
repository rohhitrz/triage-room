import type { DatabaseSync } from "node:sqlite";

export const DEMO_TODAY = "2026-11-06";

export const POLICY: Array<{ id: string; heading: string; body: string }> = [
  {
    id: "duplicate-charge",
    heading: "Duplicate charge",
    body: "A second successful charge for the same order is refunded in full. The original charge is not refunded. The customer is told, and finance is flagged.",
  },
  {
    id: "window",
    heading: "Refund window",
    body: "The duplicate-charge rule applies for 30 days after the order's placed_on date. After that, draft a refusal and do not record a refund.",
  },
  {
    id: "not-received",
    heading: "Parcel not received",
    body: "A single charge with a missing parcel is a question, not a refund. Do not record a refund for it.",
  },
];

const ORDERS = [
  ["4821", "Asha Menon", "asha@example.com", 1299, 2, "paid", "2026-11-04"],
  ["1008", "Ravi Shah", "ravi@example.com", 899, 2, "paid", "2026-07-01"],
  ["2204", "Neel Iyer", "neel@example.com", 450, 1, "paid", "2026-11-05"],
];

export function seed(db: DatabaseSync): void {
  const order = db.prepare(
    `INSERT INTO orders (id, customer_name, email, amount_inr, charge_count, status, placed_on)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO NOTHING`,
  );
  for (const row of ORDERS) order.run(...row);
  const clause = db.prepare(
    `INSERT INTO policy_clauses (id, heading, body) VALUES (?, ?, ?) ON CONFLICT(id) DO NOTHING`,
  );
  for (const row of POLICY) clause.run(row.id, row.heading, row.body);
}

export function daysBetween(placedOn: string, today: string): number {
  const start = Date.parse(`${placedOn}T00:00:00Z`);
  const end = Date.parse(`${today}T00:00:00Z`);
  return Math.round((end - start) / 86_400_000);
}
