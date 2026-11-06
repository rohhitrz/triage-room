import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { migrate } from "../src/db/migrate.ts";
import { openDatabase } from "../src/db/open.ts";
import { seed } from "../src/db/seed.ts";

export function tempDb(): { db: DatabaseSync; close: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "refund-desk-"));
  const db = openDatabase(join(dir, "refund-desk.sqlite"));
  migrate(db);
  seed(db);
  return {
    db,
    close() {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
