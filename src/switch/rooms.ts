import WebSocket from "ws";

/**
 * List the rooms this agent is assigned to. switch-core 0.31 answers
 * operations only while the agent holds an open connection, so this opens the
 * agent's socket, waits for connection_state, calls list_rooms, and closes.
 */
export async function listRooms(input: {
  baseUrl: string;
  agentId: string;
  apiKey: string;
  connectionId: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<unknown> {
  const base = input.baseUrl.replace(/\/$/, "");
  const url = new URL(`${base}/agents/${input.agentId}/connection/ws`);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("connection_id", input.connectionId);
  const socket = new WebSocket(url, { headers: { Authorization: `Bearer ${input.apiKey}` } });
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timed out waiting for connection_state")), input.timeoutMs ?? 8000);
      socket.on("message", (raw) => {
        let frame: Record<string, unknown>;
        try {
          frame = JSON.parse(raw.toString()) as Record<string, unknown>;
        } catch {
          return;
        }
        const kind = frame.type ?? frame.event;
        if (kind === "ping") socket.send(JSON.stringify({ type: "pong", cursor: 0 }));
        if (kind === "connection_state") {
          clearTimeout(timer);
          resolve();
        }
      });
      socket.on("unexpected-response", (_req, res) => {
        clearTimeout(timer);
        reject(new Error(`socket refused: ${res.statusCode}`));
      });
      socket.on("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });
    const fetchImpl = input.fetchImpl ?? fetch;
    const response = await fetchImpl(`${base}/agents/${input.agentId}/ops/list_rooms`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${input.apiKey}`,
        "Content-Type": "application/json",
        "X-Switch-Connection-Id": input.connectionId,
      },
      body: "{}",
      signal: AbortSignal.timeout(20_000),
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`list_rooms failed: ${response.status} ${text}`);
    return JSON.parse(text) as unknown;
  } finally {
    socket.close();
  }
}
