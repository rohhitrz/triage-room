export const ACTIONS = ["send_reply", "flag_finance", "issue_refund"] as const;
export type Action = (typeof ACTIONS)[number];

const NEGATION =
  /\b(don't|dont|do not|never|cannot|can't|except|without|unless|however|not|no|but)\b/i;

const PHRASES: Array<[RegExp, Action]> = [
  [/^(send the reply|send_reply)$/i, "send_reply"],
  [/^(flag finance|flag_finance)$/i, "flag_finance"],
  [/^(issue the refund|issue_refund)$/i, "issue_refund"],
];

export type ParseResult =
  | { ok: true; kind: "bare" }
  | { ok: true; kind: "named"; actions: Action[] }
  | { ok: false; reason: "negation" | "ambiguous" | "not_approval" };

export function stripMention(body: string): string {
  return body.trim().replace(/^@refund-desk\b:?/i, "").trim();
}

export function parseApproval(body: string): ParseResult {
  const stripped = stripMention(body);
  if (!stripped) return { ok: false, reason: "not_approval" };
  if (!/^approved\b/i.test(stripped)) return { ok: false, reason: "not_approval" };
  if (stripped.includes("?")) return { ok: false, reason: "ambiguous" };
  if (NEGATION.test(stripped)) return { ok: false, reason: "negation" };
  if (/^approved[.!]?$/i.test(stripped)) return { ok: true, kind: "bare" };
  const named = stripped.match(/^approved\s*[,:]\s*(.+?)[.!]?\s*$/i);
  if (!named) return { ok: false, reason: "ambiguous" };
  const parts = named[1]
    .replace(/\band\b/gi, ",")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length === 0) return { ok: false, reason: "ambiguous" };
  const actions: Action[] = [];
  for (const part of parts) {
    const hit = PHRASES.find(([pattern]) => pattern.test(part));
    if (!hit || actions.includes(hit[1])) return { ok: false, reason: "ambiguous" };
    actions.push(hit[1]);
  }
  return { ok: true, kind: "named", actions };
}

export type BindInput = {
  body: string;
  senderId: string;
  threadId: string | null;
  ownerId: string | null;
  ticketThreadId: string;
  approvalVersion: number;
  currentVersion: number;
  invalidatedAt?: string | null;
  pending: Action[];
};

export type BindResult = { ok: true; actions: Action[] } | { ok: false; reason: string };

export function bindApproval(input: BindInput): BindResult {
  const parsed = parseApproval(input.body);
  if (!parsed.ok) return parsed;
  if (!input.ownerId) return { ok: false, reason: "owner_not_configured" };
  if (input.senderId !== input.ownerId) return { ok: false, reason: "wrong_sender" };
  if (!input.threadId || input.threadId !== input.ticketThreadId) return { ok: false, reason: "wrong_thread" };
  if (input.invalidatedAt || input.approvalVersion !== input.currentVersion) {
    return { ok: false, reason: "stale_approval" };
  }
  const actions = parsed.kind === "bare" ? [...input.pending] : parsed.actions;
  if (actions.length === 0) return { ok: false, reason: "not_proposed" };
  if (actions.some((action) => !input.pending.includes(action))) return { ok: false, reason: "not_proposed" };
  return { ok: true, actions };
}

export function rejectionSentence(reason: string): string {
  const sentences: Record<string, string> = {
    negation: "approval contained a negation",
    ambiguous: "approval was ambiguous",
    not_approval: "message was not an approval",
    owner_not_configured: "owner participant id is not configured",
    wrong_sender: "sender is not the configured owner",
    wrong_thread: "approval is not in this ticket's thread",
    stale_approval: "approval is for an older draft",
    not_proposed: "approval names an action that is not pending",
    order_mismatch: "approval is not bound to this ticket's order",
    refund_already_recorded: "this order already has a refund recorded",
    missing_approval: "approval record is missing",
    missing_ticket: "ticket record is missing",
  };
  return sentences[reason] ?? reason;
}
