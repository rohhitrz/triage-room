import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { bindApproval, parseApproval, rejectionSentence, type Action } from "./approval/parse.ts";
import { recordLlmCall, type DraftOutput } from "./draft/llm.ts";
import { composeLedgerPost, executeApproval, refusalReason } from "./ledger/execute.ts";
import {
  allClauses,
  assessOrder,
  buildDraftPrompt,
  composeDraftPost,
  splitCitations,
  type Assessment,
  type Clause,
  type OrderRow,
} from "./policy/ground.ts";
import { normalizeFrame, type DomainMessage } from "./switch/protocol.ts";
import type { RecoveryGate } from "./switch/recovery.ts";

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
  recovery?: RecoveryGate;
};

type TicketRow = {
  id: string;
  thread_id: string;
  proposal_version: number;
  source_message_id: string;
  needs_refresh: number;
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

async function afterRecovery(options: OrchestratorOptions): Promise<void> {
  await options.recovery?.wait();
}

export async function handleDomainMessage(db: DatabaseSync, incoming: DomainMessage, options: OrchestratorOptions): Promise<string | null> {
  await afterRecovery(options);
  const frame = normalizeFrame(incoming);
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

  const opened = db.prepare("SELECT id, rendered_reply FROM tickets WHERE source_message_id = ?").get(payload.message_id) as
    | { id: string; rendered_reply: string | null }
    | undefined;
  if (opened) return opened.rendered_reply ?? composeLedgerPost(db, opened.id);

  const triggered = db
    .prepare(
      `SELECT tickets.rendered_reply AS rendered_reply
       FROM drafts JOIN tickets ON tickets.id = drafts.ticket_id
       WHERE drafts.trigger_message_id = ?`,
    )
    .get(payload.message_id) as { rendered_reply: string | null } | undefined;
  if (triggered?.rendered_reply) return triggered.rendered_reply;

  const savedApproval = db.prepare("SELECT id, ticket_id FROM approvals WHERE message_id = ?").get(payload.message_id) as
    | { id: string; ticket_id: string }
    | undefined;
  if (savedApproval) return runApproval(db, savedApproval.id, savedApproval.ticket_id, payload);

  const ticket = findTicket(db, payload);
  if (ticket) return handleInThread(db, ticket, payload, options);
  return openTicket(db, frame, options);
}

function blocked(reason: string): string {
  return `Blocked. Nothing was executed.\nReason: ${rejectionSentence(reason)}.`;
}

// Runs a stored approval once. A refusal is recorded and answered in the thread, so the
// owner always hears back and a replay of the same message gives the same answer.
function runApproval(db: DatabaseSync, approvalId: string, ticketId: string, payload: DomainMessage["data"]["payload"]): string {
  const done = db.prepare("SELECT COUNT(*) AS n FROM actions WHERE approval_id = ?").get(approvalId) as { n: number };
  if (Number(done.n) > 0) return composeLedgerPost(db, ticketId);
  const refused = db
    .prepare(
      `SELECT json_extract(payload_json, '$.reason') AS reason FROM audit_events
       WHERE kind = 'approval_rejected' AND ticket_id = ? AND json_extract(payload_json, '$.message_id') = ?
       ORDER BY id DESC LIMIT 1`,
    )
    .get(ticketId, payload.message_id) as { reason: string } | undefined;
  if (refused) return blocked(refused.reason);
  try {
    executeApproval(db, approvalId);
  } catch (error) {
    const reason = refusalReason(error);
    if (!reason) throw error;
    db.exec("BEGIN IMMEDIATE");
    try {
      db.prepare("UPDATE approvals SET invalidated_at = ? WHERE id = ? AND invalidated_at IS NULL").run(now(), approvalId);
      db.prepare("INSERT INTO audit_events (ticket_id, kind, payload_json, created_at) VALUES (?, 'approval_rejected', ?, ?)").run(
        ticketId,
        JSON.stringify({ reason, message_id: payload.message_id, verbatim: payload.body }),
        now(),
      );
      db.exec("COMMIT");
    } catch (inner) {
      db.exec("ROLLBACK");
      throw inner;
    }
    return blocked(reason);
  }
  return composeLedgerPost(db, ticketId);
}

function findTicket(db: DatabaseSync, payload: DomainMessage["data"]["payload"]): TicketRow | undefined {
  if (payload.thread_id) {
    return db.prepare("SELECT id, thread_id, proposal_version, source_message_id, needs_refresh FROM tickets WHERE thread_id = ?").get(payload.thread_id) as
      | TicketRow
      | undefined;
  }
  return db.prepare("SELECT id, thread_id, proposal_version, source_message_id, needs_refresh FROM tickets WHERE source_message_id = ?").get(payload.message_id) as
    | TicketRow
    | undefined;
}

async function handleInThread(
  db: DatabaseSync,
  ticket: TicketRow,
  payload: DomainMessage["data"]["payload"],
  options: OrchestratorOptions,
): Promise<string> {
  if (ticket.needs_refresh) {
    const parsed = parseApproval(payload.body);
    const orderId = orderIdFrom(payload.body);
    const ownerOk = !options.ownerId || payload.sender === options.ownerId;
    if (orderId && !parsed.ok && parsed.reason === "not_approval" && ownerOk) {
      const bound = db.prepare("SELECT order_id FROM tickets WHERE id = ?").get(ticket.id) as { order_id: string | null };
      if (bound.order_id && orderId !== bound.order_id) {
        return `Order #${orderId} is not the order on this thread (#${bound.order_id}). Start a new root message for Order #${orderId}. Nothing was drafted or executed.`;
      }
      return redraftTicket(db, ticket, payload, options, orderId);
    }
    return "This proposal was cleared because room history could not be verified after a gap. Repost the ticket text in this thread, for example: Order #4821 charged twice. A new root message also starts a fresh proposal. Nothing was drafted from the missing history, and nothing was executed.";
  }
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
    return blocked(bound.reason);
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
  await afterRecovery(options);
  const fresh = db.prepare("SELECT needs_refresh, proposal_version FROM tickets WHERE id = ?").get(ticket.id) as {
    needs_refresh: number;
    proposal_version: number;
  };
  if (fresh.needs_refresh || fresh.proposal_version !== ticket.proposal_version) {
    return "This proposal was cleared because room history could not be verified after a gap. Repost the ticket text in this thread, or start a new root message. Nothing was executed.";
  }
  return runApproval(db, approvalId, ticket.id, payload);
}

type Drafted = {
  assessment: Assessment;
  clauses: Clause[];
  drafted: DraftOutput;
  citations: { accepted: string[]; rejected: string[] };
  prompt: string;
  latencyMs: number;
};

// Asks the model for wording. Code has already decided eligibility. Returns null if the model failed.
async function draftFor(
  db: DatabaseSync,
  order: OrderRow,
  ticketText: string,
  ticketId: string | null,
  options: OrchestratorOptions,
): Promise<Drafted | null> {
  const stored = db.prepare("SELECT id, heading, body FROM policy_clauses ORDER BY id").all() as Clause[];
  const clauses = stored.length === 3 ? stored : allClauses();
  const assessment = assessOrder(order, options.today);
  const prompt = buildDraftPrompt({ order, clauses, ticketText, assessment });
  const started = Date.now();
  let drafted: DraftOutput;
  try {
    drafted = await options.draft({ order, clauses, ticketText, assessment });
  } catch (error) {
    db.prepare("INSERT INTO audit_events (ticket_id, kind, payload_json, created_at) VALUES (?, 'model_failed', ?, ?)").run(
      ticketId,
      JSON.stringify({ message: error instanceof Error ? error.message : "model failed" }),
      now(),
    );
    return null;
  }
  const latencyMs = Date.now() - started;
  await afterRecovery(options);
  const citations = splitCitations(drafted.cited_chunk_ids, clauses.map((clause) => clause.id));
  return { assessment, clauses, drafted, citations, prompt: `${prompt.system}\n${prompt.user}`, latencyMs };
}

// Writes the draft, its citations, the pending proposals, and the model call. Caller holds the transaction.
function storeDraft(
  db: DatabaseSync,
  input: Drafted & { ticketId: string; version: number; orderId: string; triggerMessageId: string | null; resent: boolean; options: OrchestratorOptions },
): string {
  const created = now();
  const draftId = randomUUID();
  db.prepare(
    `INSERT INTO drafts (id, ticket_id, proposal_version, customer_reply, internal_note, created_at, trigger_message_id)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(draftId, input.ticketId, input.version, input.drafted.customer_reply, input.drafted.internal_note, created, input.triggerMessageId);
  const cite = db.prepare("INSERT INTO draft_citations (draft_id, chunk_id, accepted) VALUES (?, ?, ?)");
  for (const id of input.citations.accepted) cite.run(draftId, id, 1);
  for (const id of input.citations.rejected) cite.run(draftId, id, 0);
  const proposal = db.prepare(
    "INSERT INTO proposals (id, ticket_id, proposal_version, action, status, order_id) VALUES (?, ?, ?, ?, 'pending', ?)",
  );
  for (const action of input.assessment.proposedActions) proposal.run(randomUUID(), input.ticketId, input.version, action, input.orderId);
  if (input.citations.rejected.length > 0) {
    db.prepare("INSERT INTO audit_events (ticket_id, kind, payload_json, created_at) VALUES (?, 'citation_rejected', ?, ?)").run(
      input.ticketId,
      JSON.stringify({ rejected: input.citations.rejected }),
      created,
    );
  }
  db.prepare("INSERT INTO audit_events (ticket_id, kind, payload_json, created_at) VALUES (?, 'draft_stored', ?, ?)").run(
    input.ticketId,
    JSON.stringify({ proposal_version: input.version, eligibility: input.assessment.eligibility, ...(input.resent ? { resent: true } : {}) }),
    created,
  );
  recordLlmCall(db, {
    ticketId: input.ticketId,
    provider: input.options.provider,
    model: input.options.model,
    prompt: input.prompt,
    response: input.drafted,
    latencyMs: input.latencyMs,
  });
  return composeDraftPost({
    assessment: input.assessment,
    customerReply: input.drafted.customer_reply,
    clauses: input.clauses,
    acceptedCitationIds: input.citations.accepted,
    version: input.version,
  });
}

async function openTicket(db: DatabaseSync, frame: DomainMessage, options: OrchestratorOptions): Promise<string> {
  const payload = frame.data.payload;
  const orderId = orderIdFrom(payload.body);
  if (!orderId) return "I need an order id, for example Order #4821. Nothing was executed.";
  const order = db.prepare("SELECT * FROM orders WHERE id = ?").get(orderId) as OrderRow | undefined;
  if (!order) return `I don't have order #${orderId} in the ledger. Nothing was executed.`;
  const result = await draftFor(db, order, payload.body, null, options);
  if (!result) return "I couldn't draft that. Nothing was executed.";

  const threadId = payload.thread_id || payload.message_id;
  const ticketId = randomUUID();
  db.exec("BEGIN");
  try {
    db.prepare(
      `INSERT INTO tickets (
        id, room_id, thread_id, source_message_id, order_id, label, eligibility, status, summary, proposal_version, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'awaiting_approval', ?, 1, ?)`,
    ).run(
      ticketId,
      frame.data.room_id,
      threadId,
      payload.message_id,
      order.id,
      result.assessment.label,
      result.assessment.eligibility,
      result.assessment.summary,
      now(),
    );
    const rendered = storeDraft(db, { ...result, ticketId, version: 1, orderId: order.id, triggerMessageId: null, resent: false, options });
    db.prepare("UPDATE tickets SET rendered_reply = ? WHERE id = ?").run(rendered, ticketId);
    db.prepare("UPDATE room_messages SET ticket_id = ? WHERE message_id = ?").run(ticketId, payload.message_id);
    db.exec("COMMIT");
    return rendered;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

async function redraftTicket(
  db: DatabaseSync,
  ticket: TicketRow,
  payload: DomainMessage["data"]["payload"],
  options: OrchestratorOptions,
  orderId: string,
): Promise<string> {
  const order = db.prepare("SELECT * FROM orders WHERE id = ?").get(orderId) as OrderRow | undefined;
  if (!order) return `I don't have order #${orderId} in the ledger. Nothing was executed.`;
  const result = await draftFor(db, order, payload.body, ticket.id, options);
  if (!result) return "I couldn't draft that. Nothing was executed.";
  db.exec("BEGIN");
  try {
    const claimed = db
      .prepare("UPDATE tickets SET needs_refresh = 0, status = 'awaiting_approval' WHERE id = ? AND needs_refresh = 1")
      .run(ticket.id) as { changes: number };
    if (Number(claimed.changes) !== 1) {
      db.exec("ROLLBACK");
      const current = db.prepare("SELECT rendered_reply FROM tickets WHERE id = ?").get(ticket.id) as { rendered_reply: string | null };
      return current.rendered_reply ?? composeLedgerPost(db, ticket.id);
    }
    const rendered = storeDraft(db, {
      ...result,
      ticketId: ticket.id,
      version: ticket.proposal_version,
      orderId: order.id,
      triggerMessageId: payload.message_id,
      resent: true,
      options,
    });
    db.prepare("UPDATE tickets SET summary = ?, label = ?, eligibility = ?, rendered_reply = ? WHERE id = ?").run(
      result.assessment.summary,
      result.assessment.label,
      result.assessment.eligibility,
      rendered,
      ticket.id,
    );
    db.exec("COMMIT");
    return rendered;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
