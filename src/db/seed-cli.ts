import { migrate } from "./migrate.ts";
import { openDatabase } from "./open.ts";
import { seed } from "./seed.ts";

const path = process.env.DATA_PATH ?? "data/refund-desk.sqlite";
const db = openDatabase(path);
migrate(db);
seed(db);
db.close();
console.log(`seeded ${path}`);
