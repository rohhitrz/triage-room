import { migrate } from "./migrate.ts";
import { openDatabase } from "./open.ts";

const path = process.env.DATA_PATH ?? "data/refund-desk.sqlite";
const db = openDatabase(path);
migrate(db);
db.close();
console.log(`migrated ${path}`);
