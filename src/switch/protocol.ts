export type DomainMessage = {
  event: "message";
  id: number;
  data: {
    type: "message";
    room_id: string;
    sequence: number;
    payload: {
      addressed: boolean;
      sender: string;
      sender_name?: string;
      message_id: string;
      body: string;
      timestamp: number;
      thread_id: string | null;
    };
  };
};

export type GapFrame = {
  type: "gap";
  from_sequence?: number;
  resumed_at?: number;
  reason?: string;
};

export type ContextMessage = {
  message_id: string;
  body: string;
  thread_id: string | null;
  sender: string;
};

export function parseContextMessages(body: unknown): ContextMessage[] {
  if (!body || typeof body !== "object") return [];
  const record = body as { result?: unknown; messages?: unknown };
  const result = record.result;
  const raw = Array.isArray(result)
    ? result
    : result && typeof result === "object" && Array.isArray((result as { messages?: unknown }).messages)
      ? (result as { messages: unknown[] }).messages
      : result && typeof result === "object" && Array.isArray((result as { history?: unknown }).history)
        ? (result as { history: unknown[] }).history
        : Array.isArray(record.messages)
          ? record.messages
          : [];
  return raw.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const message = item as { message_id?: unknown; id?: unknown; body?: unknown; thread_id?: unknown; sender?: unknown };
    const messageId = message.message_id ?? message.id;
    if (typeof messageId !== "string" || !messageId) return [];
    return [
      {
        message_id: messageId,
        body: typeof message.body === "string" ? message.body : "",
        thread_id: typeof message.thread_id === "string" ? message.thread_id : null,
        sender: typeof message.sender === "string" ? message.sender : "",
      },
    ];
  });
}

export function frameKind(frame: Record<string, unknown>): string {
  const kind = frame.type ?? frame.event;
  return typeof kind === "string" ? kind : "";
}

export function messageSequence(frame: DomainMessage): number {
  return frame.id;
}

export function isDomainMessage(frame: Record<string, unknown>): frame is DomainMessage {
  return frame.event === "message" && typeof frame.id === "number" && frame.data != null;
}
