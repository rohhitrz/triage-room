import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { DatabaseSync } from "node:sqlite";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");

export function migrationsDir(): string {
  return join(root, "db", "migrations");
}

export function migrate(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL
  )`);
  const files = readdirSync(migrationsDir())
    .filter((name) => name.endsWith(".sql"))
    .sort();
  for (const file of files) {
    const version = Number(file.slice(0, 3));
    const existing = db.prepare("SELECT version FROM schema_migrations WHERE version = ?").get(version) as
      | { version: number }
      | undefined;
    if (existing) continue;
    const sql = readFileSync(join(migrationsDir(), file), "utf8");
    db.exec("BEGIN");
    try {
      db.exec(sql);
      db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(version, new Date().toISOString());
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
}
