import WebSocket from "ws";
import { discoverSwitch, schemaMentionsThread, type Discovery } from "./discover.ts";
import { frameKind, isDomainMessage, parseContextMessages, type ContextMessage, type DomainMessage, type GapFrame } from "./protocol.ts";

export type SwitchClientOptions = {
  baseUrl: string;
  agentId: string;
  apiKey: string;
  connectionId: string;
  roomId: string;
  getCursor: () => number;
  onDomainEvent: (frame: DomainMessage) => Promise<void>;
  onGap: (frame: GapFrame, messages: ContextMessage[]) => Promise<void>;
  fetchImpl?: typeof fetch;
  reconnect?: boolean;
  reconnectDelayMs?: number;
  timeoutMs?: number;
};

type Socket = WebSocket;

export class SwitchClient {
  generation: string | number | null = null;
  openedUrls: string[] = [];
  contextReads = 0;
  private socket: Socket | null = null;
  private stopped = false;
  fatal: string | null = null;
  private ready = false;
  private connecting: Promise<void> | null = null;
  discovery: Discovery | null = null;
  private readonly options: SwitchClientOptions;

  constructor(options: SwitchClientOptions) {
    this.options = options;
  }

  async discover(outPath?: string, consoleVersion?: string | null): Promise<Discovery> {
    this.discovery = await discoverSwitch({
      baseUrl: this.options.baseUrl,
      agentId: this.options.agentId,
      agentKey: this.options.apiKey,
      consoleVersion,
      outPath,
      fetchImpl: this.options.fetchImpl,
    });
    return this.discovery;
  }

  connect(): Promise<void> {
    if (this.connecting) return this.connecting;
    this.connecting = this.openSocket().finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  stop(): void {
    this.stopped = true;
    this.socket?.close();
  }

  async post(content: string, threadId: string): Promise<void> {
    if (!threadId) throw new Error("thread_id is required. Refusing to post at the channel root.");
    if (this.discovery && !schemaMentionsThread(this.discovery.post_message_schema)) {
      throw new Error("post_message schema has no thread_id. Refusing to post at the channel root.");
    }
    const fetchImpl = this.options.fetchImpl ?? fetch;
    const base = this.options.baseUrl.replace(/\/$/, "");
    const response = await fetchImpl(`${base}/agents/${this.options.agentId}/ops/post_message`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.options.apiKey}`,
        "Content-Type": "application/json",
        "X-Switch-Connection-Id": this.options.connectionId,
      },
      body: JSON.stringify({
        room_id: this.options.roomId,
        content,
        thread_id: threadId,
      }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) throw new Error(`post_message failed: ${response.status} ${await response.text()}`);
  }

  private socketUrl(): string {
    const base = new URL(this.options.baseUrl);
    base.protocol = base.protocol === "https:" ? "wss:" : "ws:";
    base.pathname = `/agents/${this.options.agentId}/connection/ws`;
    const cursor = this.options.getCursor();
    base.searchParams.set("connection_id", this.options.connectionId);
    base.searchParams.set("rooms", this.options.roomId);
    base.searchParams.set("scope", "single");
    base.searchParams.set("filter", "all");
    base.searchParams.set("start_from", cursor > 0 ? String(cursor) : "head");
    base.searchParams.set("client", "refund-desk");
    base.searchParams.set("client_version", "0.1.0");
    if (this.generation != null) base.searchParams.set("expected_generation", String(this.generation));
    return base.toString();
  }

  private openSocket(): Promise<void> {
    const url = this.socketUrl();
    this.openedUrls.push(url);
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url, {
        headers: { Authorization: `Bearer ${this.options.apiKey}` },
      });
      this.socket = socket;
      this.ready = false;
      const timeout = setTimeout(() => {
        socket.close();
        reject(new Error("timed out waiting for connection_state"));
      }, this.options.timeoutMs ?? 5000);

      socket.on("message", (raw) => {
        const frame = JSON.parse(raw.toString()) as Record<string, unknown>;
        const kind = frameKind(frame);
        if (kind === "ping") {
          socket.send(JSON.stringify({ type: "pong", cursor: this.options.getCursor() }));
          return;
        }
        if (kind === "connection_state" && !this.ready) {
          this.generation = (frame.generation as string | number | undefined) ?? null;
          this.ready = true;
          clearTimeout(timeout);
          void this.readContext().then(() => resolve(), reject);
          return;
        }
        void this.dispatch(frame);
      });

      socket.on("close", () => {
        if (!this.ready) {
          clearTimeout(timeout);
          reject(new Error("socket closed before connection_state"));
          return;
        }
        if (!this.stopped && this.options.reconnect !== false) this.scheduleReconnect();
      });

      socket.on("error", (error) => {
        if (!this.ready) {
          clearTimeout(timeout);
          reject(error);
        }
      });
    });
  }

  private scheduleReconnect(): void {
    const delay = this.options.reconnectDelayMs ?? 200;
    setTimeout(() => {
      if (this.stopped) return;
      void this.openSocket().catch(() => {
        if (!this.stopped) this.scheduleReconnect();
      });
    }, delay);
  }

  private async readContext(): Promise<ContextMessage[]> {
    const fetchImpl = this.options.fetchImpl ?? fetch;
    const base = this.options.baseUrl.replace(/\/$/, "");
    const headers = {
      Authorization: `Bearer ${this.options.apiKey}`,
      "Content-Type": "application/json",
      "X-Switch-Connection-Id": this.options.connectionId,
    };
    let response = await fetchImpl(`${base}/agents/${this.options.agentId}/ops/read_context`, {
      method: "POST",
      headers,
      body: JSON.stringify({ room_id: this.options.roomId, limit: 50 }),
      signal: AbortSignal.timeout(20_000),
    });
    if (response.status === 400) {
      response = await fetchImpl(`${base}/agents/${this.options.agentId}/ops/read_context`, {
        method: "POST",
        headers,
        body: JSON.stringify({ room_id: this.options.roomId }),
        signal: AbortSignal.timeout(20_000),
      });
    }
    if (!response.ok) throw new Error(`read_context failed: ${response.status} ${await response.text()}`);
    const messages = parseContextMessages(await response.json().catch(() => ({})));
    this.contextReads += 1;
    return messages;
  }

  private async dispatch(frame: Record<string, unknown>): Promise<void> {
    const kind = frameKind(frame);
    if (kind === "gap") {
      const messages = await this.readContext();
      await this.options.onGap(frame as GapFrame, messages);
      return;
    }
    if (kind === "evicted") {
      const code = String(frame.code ?? "");
      if (code === "taken_over" || code === "closed") {
        this.stopped = true;
        this.fatal = code;
        this.socket?.close();
        return;
      }
      this.socket?.close();
      return;
    }
    if (isDomainMessage(frame)) await this.options.onDomainEvent(frame);
  }
}
