import { mkdirSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { loadEnv } from "./env.ts";
import { registerAgent } from "./switch/register.ts";

loadEnv();

const baseUrl = process.env.SWITCH_BASE_URL ?? "";
const registrationKey = process.env.SWITCH_REGISTRATION_KEY ?? "";
if (!baseUrl) {
  console.error("Set SWITCH_BASE_URL to the Console bridge, then run this again.");
  process.exit(1);
}
const created = await registerAgent({
  baseUrl,
  registrationKey,
  keyKind: process.env.SWITCH_KEY_KIND,
  bootstrapKey: process.env.SWITCH_BOOTSTRAP_KEY,
  persist(agent) {
    mkdirSync("data", { recursive: true });
    const record = {
      id: agent.id,
      api_key: agent.api_key,
      connection_id: process.env.SWITCH_CONNECTION_ID || randomUUID(),
    };
    writeFileSync("data/agent.json", `${JSON.stringify(record, null, 2)}\n`);
  },
});
console.log(`registered ${created.id}`);
console.log("saved data/agent.json (gitignored)");
console.log("addressing set to owner_only");
