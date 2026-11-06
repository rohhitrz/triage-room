import assert from "node:assert/strict";
import test from "node:test";
import { DEMO_TODAY, daysBetween } from "../src/db/seed.ts";
import { tempDb } from "./helpers.ts";

test("seed loads three orders and three clauses on a frozen clock", () => {
  const { db, close } = tempDb();
  try {
    const orders = db.prepare("SELECT id, placed_on, charge_count FROM orders ORDER BY id").all() as Array<{
      id: string;
      placed_on: string;
      charge_count: number;
    }>;
    assert.deepEqual(
      orders.map((row) => row.id),
      ["1008", "2204", "4821"],
    );
    const clauses = db.prepare("SELECT id FROM policy_clauses ORDER BY id").all() as Array<{ id: string }>;
    assert.deepEqual(
      clauses.map((row) => row.id),
      ["duplicate-charge", "not-received", "window"],
    );
    assert.equal(DEMO_TODAY, "2026-11-06");
    assert.equal(daysBetween("2026-11-04", DEMO_TODAY), 2);
    assert.ok(daysBetween("2026-11-04", DEMO_TODAY) <= 30);
    assert.ok(daysBetween("2026-07-01", DEMO_TODAY) > 30);
    const checkpoint = db.prepare("SELECT queued_sequence FROM checkpoint WHERE id = 1").get() as {
      queued_sequence: number;
    };
    assert.equal(checkpoint.queued_sequence, 0);
  } finally {
    close();
  }
});
