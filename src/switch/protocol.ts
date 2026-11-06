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
