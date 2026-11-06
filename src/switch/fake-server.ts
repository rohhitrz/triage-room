import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";

type AgentRecord = { id: string; api_key: string; name: string; addressing?: string };

export class FakeSwitch {
  http: Server | null = null;
  wss: WebSocketServer | null = null;
  agents = new Map<string, AgentRecord>();
  posts: Array<{ path: string; body: Record<string, unknown>; connectionId: string | null }> = [];
  auths: string[] = [];
  contextCalls: Array<{ body: Record<string, unknown>; connectionId: string | null }> = [];
  openUrls: string[] = [];
  pongs: Array<{ cursor: number }> = [];
  sockets: WebSocket[] = [];
  registrationKey = "reg_test";
  omitThreadInSchema = false;
  rejectLimit = false;
  contextMessages: unknown[] = [];
  holdContext: Promise<void> | null = null;
  failAddressing = false;
  private generation = 1;

  async start(): Promise<void> {
    this.http = createServer((req, res) => {
      void this.handle(req, res);
    });
    this.wss = new WebSocketServer({ noServer: true });
    this.http.on("upgrade", (req, socket, head) => {
      const auth = req.headers.authorization ?? "";
      if (!auth.startsWith("Bearer ")) {
        socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
        socket.destroy();
        return;
      }
      this.openUrls.push(req.url ?? "");
      this.wss?.handleUpgrade(req, socket, head, (ws) => {
        this.sockets.push(ws);
        const generation = this.generation;
        this.generation += 1;
        ws.send(
          JSON.stringify({
            type: "connection_state",
            connection_id: new URL(req.url ?? "/", "http://127.0.0.1").searchParams.get("connection_id"),
            generation,
            rooms: (new URL(req.url ?? "/", "http://127.0.0.1").searchParams.get("rooms") ?? "")
              .split(",")
              .filter(Boolean),
            cursor: 0,
            heartbeat_interval_seconds: 2,
            server: { version: "test-server-0.31.0" },
          }),
        );
        ws.on("message", (raw) => {
          const frame = JSON.parse(raw.toString()) as { type?: string; cursor?: number };
          if (frame.type === "pong") this.pongs.push({ cursor: Number(frame.cursor) });
        });
      });
    });
    await new Promise<void>((resolve) => this.http?.listen(0, "127.0.0.1", () => resolve()));
  }

  baseUrl(): string {
    const address = this.http?.address();
    if (!address || typeof address === "string") throw new Error("fake server has no port");
    return `http://127.0.0.1:${address.port}`;
  }

  pingAll(): void {
    for (const socket of this.sockets) {
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify({ type: "ping" }));
    }
  }

  send(socket: WebSocket, frame: unknown): void {
    socket.send(JSON.stringify(frame));
  }

  async stop(): Promise<void> {
    for (const socket of this.sockets) socket.close();
    this.wss?.close();
    await new Promise<void>((resolve) => this.http?.close(() => resolve()));
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (req.method === "GET" && url.pathname === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", version: "test-server-0.31.0" }));
      return;
    }
    const auth = req.headers.authorization ?? "";
    if (auth) this.auths.push(auth);
    if (req.method === "POST" && url.pathname === "/agents") {
      if (auth !== `Bearer ${this.registrationKey}`) {
        res.writeHead(401);
        res.end("bad registration key");
        return;
      }
      const body = await readBody(req);
      const id = "agt_test";
      const api_key = "agent_test_key";
      this.agents.set(id, { id, api_key, name: String(body.name ?? "") });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ id, api_key }));
      return;
    }
    const ops = url.pathname.match(/^\/agents\/([^/]+)\/ops(?:\/([^/]+))?$/);
    if (ops && req.method === "GET" && !ops[2]) {
      const thread = this.omitThreadInSchema
        ? { type: "object", properties: { room_id: { type: "string" }, content: { type: "string" } }, required: ["room_id", "content"] }
        : {
            type: "object",
            properties: {
              room_id: { type: "string" },
              content: { type: "string" },
              thread_id: { type: "string" },
            },
            required: ["room_id", "content", "thread_id"],
          };
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          operations: {
            post_message: { description: "Post in a room", input_schema: thread },
            read_context: {
              description: "Read room context",
              input_schema: { type: "object", properties: { room_id: { type: "string" }, limit: { type: "integer" } }, required: ["room_id"] },
            },
            update_agent_detail: {
              description: "Update agent",
              input_schema: { type: "object", properties: { agent_id: {}, addressing: {} }, required: ["agent_id", "addressing"] },
            },
          },
        }),
      );
      return;
    }
    if (ops && req.method === "POST" && ops[2]) {
      const body = await readBody(req);
      const connectionId = header(req, "x-switch-connection-id");
      if (ops[2] === "list_rooms") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ result: [{ id: "room_1", name: "refund-desk" }] }));
        return;
      }
      if (ops[2] === "update_agent_detail") {
        if (this.failAddressing) {
          res.writeHead(500);
          res.end("addressing failed");
          return;
        }
        const agent = this.agents.get(ops[1]);
        if (agent) agent.addressing = String(body.addressing ?? "");
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ result: { addressing: body.addressing } }));
        return;
      }
      if (ops[2] === "read_context") {
        if (this.holdContext) await this.holdContext;
        if (this.rejectLimit && Object.hasOwn(body, "limit")) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "unexpected limit" }));
          return;
        }
        this.contextCalls.push({ body, connectionId });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ result: { messages: this.contextMessages } }));
        return;
      }
      if (ops[2] === "post_message") {
        if (!body.thread_id) {
          res.writeHead(400);
          res.end("thread_id required");
          return;
        }
        this.posts.push({ path: url.pathname, body, connectionId });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ result: { message_id: "msg_posted" } }));
        return;
      }
    }
    res.writeHead(404);
    res.end("not found");
  }
}

function header(req: IncomingMessage, name: string): string | null {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : (value ?? null);
}

function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      if (!text) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(text) as Record<string, unknown>);
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}
