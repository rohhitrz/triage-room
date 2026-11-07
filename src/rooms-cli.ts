import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { loadEnv } from "./env.ts";
import { listRooms } from "./switch/rooms.ts";

loadEnv();
const baseUrl = process.env.SWITCH_BASE_URL ?? "";
let agentId = process.env.SWITCH_AGENT_ID ?? "";
let agentKey = process.env.SWITCH_AGENT_KEY ?? "";
if ((!agentId || !agentKey) && existsSync("data/agent.json")) {
  const saved = JSON.parse(readFileSync("data/agent.json", "utf8")) as { id: string; api_key: string };
  agentId ||= saved.id;
  agentKey ||= saved.api_key;
}
if (!baseUrl || !agentId || !agentKey) {
  console.error("Need SWITCH_BASE_URL and a registered agent. Run npm run register first.");
  process.exit(1);
}
// A throwaway connection id: reusing the agent's own would take over the
// socket a running `npm start` holds.
const rooms = await listRooms({ baseUrl, agentId, apiKey: agentKey, connectionId: randomUUID() });
console.log(JSON.stringify(rooms, null, 2));
