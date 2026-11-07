import WebSocket from "ws";
import { discoverSwitch, schemaMentionsThread, type Discovery } from "./discover.ts";
import { frameKind, isDomainMessage, parseContextMessages, type ContextMessage, type DomainMessage, type GapFrame } from "./protocol.ts";
import type { RecoveryGate } from "./recovery.ts";

export type SwitchClientOptions = {
  baseUrl: string;
  agentId: string;
  apiKey: string;
  connectionId: string;
  roomId: string;
  getCursor: () => number;
  onDomainEvent: (frame: DomainMessage) => Promise<void>;
  onGap: (frame: GapFrame, messages: ContextMessage[]) => Promise<void>;
  recovery?: RecoveryGate;
  fetchImpl?: typeof fetch;
  reconnect?: boolean;
  reconnectDelayMs?: number;
  timeoutMs?: number;
};

type Socket = WebSocket;

/**
 * switch-core 0.31 sends control frames as {"event": "...", "data": {...}}, with
 * fields such as `generation`, `code`, `from_sequence` and `resumed_at` inside
 * `data`. Lift them to the top level, where they are read, without overwriting
 * anything already there. Domain messages keep `data.payload` as it is.
 */
export function liftControlFields(frame: Record<string, unknown>): Record<string, unknown> {
  const data = frame.data;
  if (frame.event === "message" || !data || typeof data !== "object" || Array.isArray(data)) return frame;
  return { ...(data as Record<string, unknown>), ...frame };
}

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
    await this.ensureRoom();
    // post_message has no room argument: it posts to the room this session is
    // connected to, which ensureRoom just set. The text field is `body`.
    const response = await this.callOp("post_message", { body: content, thread_id: threadId });
    if (!response.ok) throw new Error(`post_message failed: ${response.status} ${await response.text()}`);
  }

  private roomBoundGeneration: string | number | null | undefined = undefined;

  /** Connect this session to the room once per socket generation. */
  private async ensureRoom(): Promise<void> {
    if (this.roomBoundGeneration === this.generation) return;
    const response = await this.callOp("connect_to_room", {
      room_id: this.options.roomId,
      include_general_instructions: false,
    });
    if (!response.ok) throw new Error(`connect_to_room failed: ${response.status} ${await response.text()}`);
    await response.text();
    this.roomBoundGeneration = this.generation;
  }

  private callOp(operation: string, args: Record<string, unknown>): Promise<Response> {
    const fetchImpl = this.options.fetchImpl ?? fetch;
    const base = this.options.baseUrl.replace(/\/$/, "");
    return fetchImpl(`${base}/agents/${this.options.agentId}/ops/${operation}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.options.apiKey}`,
        "Content-Type": "application/json",
        "X-Switch-Connection-Id": this.options.connectionId,
      },
      body: JSON.stringify(args),
      signal: AbortSignal.timeout(20_000),
    });
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
        let frame: Record<string, unknown>;
        try {
          const parsed = JSON.parse(raw.toString()) as unknown;
          if (!parsed || typeof parsed !== "object") throw new Error("frame is not an object");
          frame = liftControlFields(parsed as Record<string, unknown>);
        } catch (error) {
          console.error(`ignored malformed Switch frame: ${error instanceof Error ? error.message : error}`);
          return;
        }
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
        if (kind === "gap") this.options.recovery?.hold();
        void this.dispatch(frame)
          .catch((error) => {
            console.error(`failed to handle Switch ${kind || "frame"}: ${error instanceof Error ? error.message : error}`);
            // A gap we could not record must not be treated as handled. Reconnect from the
            // saved cursor so the server reports it again.
            if (kind === "gap") socket.close();
          })
          .finally(() => {
            if (kind === "gap") this.options.recovery?.release();
          });
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
      let messages: ContextMessage[] = [];
      try {
        messages = await this.readContext();
      } catch {
        messages = [];
      }
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
