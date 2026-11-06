import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export type Discovery = {
  base_url: string;
  fetched_at: string;
  health_status: number;
  health_body: unknown;
  server_version: string | null;
  console_version: string | null;
  post_message_schema: unknown;
};

export function serverVersion(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const record = body as Record<string, unknown>;
  for (const key of ["version", "server_version", "switch_version"]) {
    if (typeof record[key] === "string") return record[key];
  }
  return null;
}

export function schemaMentionsThread(schema: unknown): boolean {
  return JSON.stringify(schema ?? {}).includes("thread_id");
}

export async function discoverSwitch(input: {
  baseUrl: string;
  agentId?: string;
  agentKey?: string;
  consoleVersion?: string | null;
  outPath?: string;
  fetchImpl?: typeof fetch;
  requireThread?: boolean;
}): Promise<Discovery> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const base = input.baseUrl.replace(/\/$/, "");
  const health = await fetchImpl(`${base}/health`);
  const healthBody = await health.json().catch(() => ({}));
  let postSchema: unknown = null;
  if (input.agentId && input.agentKey) {
    const ops = await fetchImpl(`${base}/agents/${input.agentId}/ops`, {
      headers: { Authorization: `Bearer ${input.agentKey}` },
    });
    if (!ops.ok) throw new Error(`GET /ops failed: ${ops.status} ${await ops.text()}`);
    const body = (await ops.json()) as { operations?: Record<string, { input_schema?: unknown }> };
    postSchema = body.operations?.post_message?.input_schema ?? null;
  }
  const discovery: Discovery = {
    base_url: base,
    fetched_at: new Date().toISOString(),
    health_status: health.status,
    health_body: healthBody,
    server_version: serverVersion(healthBody),
    console_version: input.consoleVersion ?? null,
    post_message_schema: postSchema,
  };
  if (input.outPath) {
    mkdirSync(dirname(input.outPath), { recursive: true });
    writeFileSync(input.outPath, `${JSON.stringify(discovery, null, 2)}\n`);
  }
  if (postSchema && input.requireThread !== false && !schemaMentionsThread(postSchema)) {
    throw new Error(
      `post_message schema has no thread_id. Refusing to post at the channel root. Schema: ${JSON.stringify(postSchema)}`,
    );
  }
  return discovery;
}
