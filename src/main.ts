import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { assertRunnableMode, liveDraft, optionalEnv, validateLlmEnv } from "./draft/llm.ts";
import { loadEnv } from "./env.ts";
import { migrate } from "./db/migrate.ts";
import { openDatabase } from "./db/open.ts";
import { seed, DEMO_TODAY } from "./db/seed.ts";
import { startLedger } from "./http/ledger.ts";
import { deliverQueued } from "./ledger/deliver.ts";
import { recordGap } from "./ledger/gap.ts";
import { claimNext, enqueueMessage, reclaimProcessing, resumeSequence, scheduleDeliveryRetry } from "./ledger/inbox.ts";
import { SwitchClient } from "./switch/client.ts";
import { RecoveryGate } from "./switch/recovery.ts";

loadEnv();
assertRunnableMode(process.env.LLM_MODE ?? "live");
validateLlmEnv(process.env);
if (!process.env.LLM_API_KEY) {
  console.error("Set LLM_API_KEY. npm start uses a live model and will not fall back to the scripted fixture.");
  process.exit(1);
}
if (!process.env.SWITCH_BASE_URL || !process.env.SWITCH_ROOM_ID) {
  console.error("Set SWITCH_BASE_URL and SWITCH_ROOM_ID. See README, Run it on your machine.");
  process.exit(1);
}

const saved = loadAgent();
const db = openDatabase(process.env.DATA_PATH ?? "data/refund-desk.sqlite");
migrate(db);
seed(db);
reclaimProcessing(db);

const port = Number(process.env.PORT ?? 8787);
const server = await startLedger(db, port);
const address = server.address();
console.log(`ledger http://127.0.0.1:${typeof address === "object" && address ? address.port : port}`);

const recovery = new RecoveryGate();
const client = new SwitchClient({
  baseUrl: process.env.SWITCH_BASE_URL,
  agentId: saved.id,
  apiKey: saved.api_key,
  connectionId: saved.connection_id,
  roomId: process.env.SWITCH_ROOM_ID,
  getCursor: () => resumeSequence(db),
  recovery,
  reconnectDelayMs: 1000,
  onDomainEvent: async (frame) => {
    const payload = frame.data.payload;
    if (payload.addressed) console.log(`addressed sender_id=${payload.sender} sender_name=${payload.sender_name ?? ""}`);
    enqueueMessage(db, frame);
  },
  onGap: async (frame, messages) => {
    recordGap(db, frame, messages);
  },
});

await client.discover("data/switch-discovery.json", process.env.SWITCH_CONSOLE_VERSION ?? null);
const discovery = client.discovery;
console.log(
  `switch health=${discovery?.health_status} server_version=${discovery?.server_version ?? "unknown"} console_version=${discovery?.console_version ?? "unset"}`,
);
await client.connect();
console.log("connected. Room claimed. Waiting for tickets.");
if (!process.env.SWITCH_OWNER_PARTICIPANT_ID) {
  console.log("SWITCH_OWNER_PARTICIPANT_ID is unset. Approvals fail closed until you set it and restart.");
}

const today = process.env.DEMO_TODAY ?? DEMO_TODAY;
await pump();

async function pump(): Promise<void> {
  for (;;) {
    await recovery.wait();
    const row = claimNext(db);
    if (!row) {
      await new Promise((resolve) => setTimeout(resolve, 150));
      continue;
    }
    try {
      await deliverQueued(
        db,
        row,
        {
          ownerId: process.env.SWITCH_OWNER_PARTICIPANT_ID || null,
          today,
          provider: optionalEnv(process.env.LLM_PROVIDER) ?? "openai",
          model: optionalEnv(process.env.LLM_MODEL) || (optionalEnv(process.env.LLM_PROVIDER) === "gemini" ? "gemini-2.5-flash" : "gpt-4o-mini"),
          recovery,
          draft: (input) =>
            liveDraft({
              provider: optionalEnv(process.env.LLM_PROVIDER) ?? "openai",
              apiKey: process.env.LLM_API_KEY ?? "",
              model: optionalEnv(process.env.LLM_MODEL),
              baseUrl: optionalEnv(process.env.LLM_BASE_URL),
              ...input,
            }),
        },
        (body, threadId) => client.post(body, threadId),
      );
    } catch (error) {
      scheduleDeliveryRetry(db, row.id, error, 1_000);
      console.error(error instanceof Error ? error.message : error);
    }
  }
}

function loadAgent(): { id: string; api_key: string; connection_id: string } {
  const fromEnv = {
    id: process.env.SWITCH_AGENT_ID ?? "",
    api_key: process.env.SWITCH_AGENT_KEY ?? "",
    connection_id: process.env.SWITCH_CONNECTION_ID ?? "",
  };
  let record = fromEnv;
  if ((!record.id || !record.api_key) && existsSync("data/agent.json")) {
    record = { ...record, ...JSON.parse(readFileSync("data/agent.json", "utf8")) };
  }
  if (!record.id || !record.api_key) {
    console.error("Missing agent credentials. Run npm run register with SWITCH_REGISTRATION_KEY.");
    process.exit(1);
  }
  if (!record.connection_id) record.connection_id = randomUUID();
  mkdirSync("data", { recursive: true });
  writeFileSync("data/agent.json", `${JSON.stringify(record, null, 2)}\n`);
  return record;
}
