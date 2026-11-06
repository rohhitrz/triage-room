import { readFileSync, existsSync } from "node:fs";
import { loadEnv } from "./env.ts";
import { discoverSwitch } from "./switch/discover.ts";

loadEnv();

const baseUrl = process.env.SWITCH_BASE_URL ?? "";
if (!baseUrl) {
  console.error("Set SWITCH_BASE_URL.");
  process.exit(1);
}
let agentId = process.env.SWITCH_AGENT_ID;
let agentKey = process.env.SWITCH_AGENT_KEY;
if ((!agentId || !agentKey) && existsSync("data/agent.json")) {
  const saved = JSON.parse(readFileSync("data/agent.json", "utf8")) as { id: string; api_key: string };
  agentId ||= saved.id;
  agentKey ||= saved.api_key;
}
const discovery = await discoverSwitch({
  baseUrl,
  agentId,
  agentKey,
  consoleVersion: process.env.SWITCH_CONSOLE_VERSION ?? null,
  outPath: "data/switch-discovery.json",
});
console.log(JSON.stringify({ server_version: discovery.server_version, console_version: discovery.console_version, health_status: discovery.health_status }, null, 2));
console.log("wrote data/switch-discovery.json");
