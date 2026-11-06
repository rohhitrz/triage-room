import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { bindApproval, rejectionSentence, type Action } from "./approval/parse.ts";
import { recordLlmCall, type DraftOutput } from "./draft/llm.ts";
import { composeLedgerPost, executeApproval } from "./ledger/execute.ts";
import {
  allClauses,
  assessOrder,
  buildDraftPrompt,
  composeDraftPost,
  splitCitations,
  type Clause,
  type OrderRow,
} from "./policy/ground.ts";
import type { DomainMessage } from "./switch/protocol.ts";

export type DraftFn = (input: {
  order: OrderRow;
  clauses: Clause[];
  ticketText: string;
  assessment: ReturnType<typeof assessOrder>;
}) => Promise<DraftOutput>;

export type OrchestratorOptions = {
  ownerId: string | null;
  today: string;
  provider: string;
  model: string;
  draft: DraftFn;
};

type TicketRow = {
  id: string;
  thread_id: string;
  proposal_version: number;
  source_message_id: string;
};

function now(): string {
  return new Date().toISOString();
}

export function orderIdFrom(text: string): string | null {
  const match = text.match(/\border\s*#?\s*(\d{3,6})\b/i) ?? text.match(/#(\d{3,6})\b/);
  return match ? match[1] : null;
}

export function threadKey(payload: DomainMessage["data"]["payload"]): string | null {
  return payload.thread_id || null;
}

export async function handleDomainMessage(db: DatabaseSync, frame: DomainMessage, options: OrchestratorOptions): Promise<string | null> {
  const payload = frame.data.payload;
  if (!payload.addressed) return null;
  db.prepare(
    `INSERT INTO room_messages (message_id, room_id, thread_id, sender_id, sender_name, body, addressed, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(message_id) DO NOTHING`,
  ).run(
    payload.message_id,
    frame.data.room_id,
    payload.thread_id,
    payload.sender,
    payload.sender_name ?? null,
    payload.body,
    payload.addressed ? 1 : 0,
    now(),
  );

  const ticket = findTicket(db, payload);
  if (ticket) return handleInThread(db, ticket, payload, options);
  return openTicket(db, frame, options);
}

function findTicket(db: DatabaseSync, payload: DomainMessage["data"]["payload"]): TicketRow | undefined {
  if (payload.thread_id) {
    return db.prepare("SELECT id, thread_id, proposal_version, source_message_id FROM tickets WHERE thread_id = ?").get(payload.thread_id) as
      | TicketRow
      | undefined;
  }
  return db.prepare("SELECT id, thread_id, proposal_version, source_message_id FROM tickets WHERE source_message_id = ?").get(payload.message_id) as
    | TicketRow
    | undefined;
}

async function handleInThread(
  db: DatabaseSync,
  ticket: TicketRow,
  payload: DomainMessage["data"]["payload"],
  options: OrchestratorOptions,
): Promise<string> {
  const pending = (
    db
      .prepare(
        `SELECT action FROM proposals WHERE ticket_id = ? AND proposal_version = ? AND status = 'pending' ORDER BY action`,
      )
      .all(ticket.id, ticket.proposal_version) as Array<{ action: Action }>
  ).map((row) => row.action);
  const bound = bindApproval({
    body: payload.body,
    senderId: payload.sender,
    threadId: payload.thread_id,
    ownerId: options.ownerId,
    ticketThreadId: ticket.thread_id,
    approvalVersion: ticket.proposal_version,
    currentVersion: ticket.proposal_version,
    pending,
  });
  if (!bound.ok) {
    db.prepare("INSERT INTO audit_events (ticket_id, kind, payload_json, created_at) VALUES (?, 'approval_rejected', ?, ?)").run(
      ticket.id,
      JSON.stringify({ reason: bound.reason, message_id: payload.message_id, verbatim: payload.body }),
      now(),
    );
    return `Blocked. Nothing was executed.\nReason: ${rejectionSentence(bound.reason)}.`;
  }

  const existing = db.prepare("SELECT id FROM approvals WHERE message_id = ?").get(payload.message_id) as { id: string } | undefined;
  const approvalId = existing?.id ?? randomUUID();
  if (!existing) {
    db.prepare(
      `INSERT INTO approvals (
        id, ticket_id, message_id, thread_id, sender_id, proposal_version, verbatim, actions_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(approvalId, ticket.id, payload.message_id, payload.thread_id, payload.sender, ticket.proposal_version, payload.body, JSON.stringify(bound.actions), now());
  }
  const already = db.prepare("SELECT COUNT(*) AS n FROM actions WHERE approval_id = ?").get(approvalId) as { n: number };
  if (Number(already.n) === 0) executeApproval(db, approvalId);
  return composeLedgerPost(db, ticket.id);
}

async function openTicket(db: DatabaseSync, frame: DomainMessage, options: OrchestratorOptions): Promise<string> {
  const payload = frame.data.payload;
  const existing = db.prepare("SELECT id FROM tickets WHERE source_message_id = ?").get(payload.message_id) as { id: string } | undefined;
  if (existing) return composeDraftPost(rebuildPost(db, existing.id));

  const orderId = orderIdFrom(payload.body);
  if (!orderId) return "I need an order id, for example Order #4821. Nothing was executed.";
  const order = db.prepare("SELECT * FROM orders WHERE id = ?").get(orderId) as OrderRow | undefined;
  if (!order) return `I don't have order #${orderId} in the ledger. Nothing was executed.`;
  const clauses = db.prepare("SELECT id, heading, body FROM policy_clauses ORDER BY id").all() as Clause[];
  const known = clauses.length === 3 ? clauses : allClauses();
  const assessment = assessOrder(order, options.today);
  const prompt = buildDraftPrompt({ order, clauses: known, ticketText: payload.body, assessment });
  let drafted: DraftOutput;
  const started = Date.now();
  try {
    drafted = await options.draft({ order, clauses: known, ticketText: payload.body, assessment });
  } catch (error) {
    db.prepare("INSERT INTO audit_events (ticket_id, kind, payload_json, created_at) VALUES (NULL, 'model_failed', ?, ?)").run(
      JSON.stringify({ message: error instanceof Error ? error.message : "model failed" }),
      now(),
    );
    return "I couldn't draft that. Nothing was executed.";
  }

  const citations = splitCitations(drafted.cited_chunk_ids, known.map((clause) => clause.id));
  const threadId = payload.thread_id ?? payload.message_id;
  const ticketId = randomUUID();
  const draftId = randomUUID();
  const created = now();
  db.exec("BEGIN");
  try {
    db.prepare(
      `INSERT INTO tickets (
        id, room_id, thread_id, source_message_id, order_id, label, eligibility, status, summary, proposal_version, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'awaiting_approval', ?, 1, ?)`,
    ).run(ticketId, frame.data.room_id, threadId, payload.message_id, order.id, assessment.label, assessment.eligibility, assessment.summary, created);
    db.prepare(
      `INSERT INTO drafts (id, ticket_id, proposal_version, customer_reply, internal_note, created_at)
       VALUES (?, ?, 1, ?, ?, ?)`,
    ).run(draftId, ticketId, drafted.customer_reply, drafted.internal_note, created);
    const cite = db.prepare("INSERT INTO draft_citations (draft_id, chunk_id, accepted) VALUES (?, ?, ?)");
    for (const id of citations.accepted) cite.run(draftId, id, 1);
    for (const id of citations.rejected) cite.run(draftId, id, 0);
    const proposal = db.prepare(
      "INSERT INTO proposals (id, ticket_id, proposal_version, action, status) VALUES (?, ?, 1, ?, 'pending')",
    );
    for (const action of assessment.proposedActions) proposal.run(randomUUID(), ticketId, action);
    if (citations.rejected.length > 0) {
      db.prepare("INSERT INTO audit_events (ticket_id, kind, payload_json, created_at) VALUES (?, 'citation_rejected', ?, ?)").run(
        ticketId,
        JSON.stringify({ rejected: citations.rejected }),
        created,
      );
    }
    db.prepare("INSERT INTO audit_events (ticket_id, kind, payload_json, created_at) VALUES (?, 'draft_stored', ?, ?)").run(
      ticketId,
      JSON.stringify({ proposal_version: 1, eligibility: assessment.eligibility }),
      created,
    );
    recordLlmCall(db, {
      ticketId,
      provider: options.provider,
      model: options.model,
      prompt: `${prompt.system}\n${prompt.user}`,
      response: drafted,
      latencyMs: Date.now() - started,
    });
    db.prepare("UPDATE room_messages SET ticket_id = ? WHERE message_id = ?").run(ticketId, payload.message_id);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return composeDraftPost({
    assessment,
    customerReply: drafted.customer_reply,
    clauses: known,
    acceptedCitationIds: citations.accepted,
    version: 1,
  });
}

function rebuildPost(db: DatabaseSync, ticketId: string) {
  const ticket = db.prepare("SELECT * FROM tickets WHERE id = ?").get(ticketId) as {
    summary: string;
    label: "refund" | "question";
    eligibility: "eligible" | "ineligible";
    proposal_version: number;
  };
  const draft = db.prepare("SELECT customer_reply FROM drafts WHERE ticket_id = ? ORDER BY proposal_version DESC LIMIT 1").get(ticketId) as {
    customer_reply: string;
  };
  const actions = (
    db.prepare("SELECT action FROM proposals WHERE ticket_id = ? AND proposal_version = ? ORDER BY action").all(ticketId, ticket.proposal_version) as Array<{
      action: Action;
    }>
  ).map((row) => row.action);
  const clauses = db.prepare("SELECT id, heading, body FROM policy_clauses").all() as Clause[];
  return {
    assessment: {
      label: ticket.label,
      eligibility: ticket.eligibility,
      proposedActions: actions,
      usedClauseIds: [] as string[],
      summary: ticket.summary,
    },
    customerReply: draft.customer_reply,
    clauses,
    acceptedCitationIds: [] as string[],
    version: ticket.proposal_version,
  };
}
