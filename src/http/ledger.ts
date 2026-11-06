import { createServer, type Server } from "node:http";
import type { DatabaseSync } from "node:sqlite";
import { rejectionSentence } from "../approval/parse.ts";

type Proposal = { action: string; status: string };
type ActionRow = { action: string; reason: string; created_at: string };
type AuditRow = { kind: string; payload_json: string; created_at: string };

export type TicketView = {
  id: string;
  order_id: string | null;
  label: string;
  eligibility: string;
  status: string;
  summary: string;
  proposal_version: number;
  customer_reply: string | null;
  finance_note: string | null;
  proposals: Proposal[];
  actions: ActionRow[];
  audits: AuditRow[];
};

export function loadLedger(db: DatabaseSync): TicketView[] {
  const tickets = db
    .prepare(
      `SELECT t.id, t.order_id, t.label, t.eligibility, t.status, t.summary, t.proposal_version, t.finance_note,
              d.customer_reply
       FROM tickets t
       LEFT JOIN drafts d ON d.ticket_id = t.id AND d.proposal_version = t.proposal_version
       ORDER BY t.created_at DESC`,
    )
    .all() as Array<Omit<TicketView, "proposals" | "actions" | "audits">>;
  return tickets.map((ticket) => ({
    ...ticket,
    proposals: db
      .prepare("SELECT action, status FROM proposals WHERE ticket_id = ? AND proposal_version = ? ORDER BY action")
      .all(ticket.id, ticket.proposal_version) as Proposal[],
    actions: db
      .prepare("SELECT action, reason, created_at FROM actions WHERE ticket_id = ? ORDER BY created_at, action")
      .all(ticket.id) as ActionRow[],
    audits: db
      .prepare("SELECT kind, payload_json, created_at FROM audit_events WHERE ticket_id = ? ORDER BY id")
      .all(ticket.id) as AuditRow[],
  }));
}

export function renderLedgerHtml(tickets: TicketView[]): string {
  const body = tickets.length === 0 ? "<p>No tickets yet. The page updates when the room gets one.</p>" : tickets.map(renderTicket).join("\n");
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta http-equiv="refresh" content="3">
  <title>Refund Desk ledger</title>
  <style>
    body { font-family: Georgia, serif; margin: 2rem auto; max-width: 46rem; color: #1c1915; background: #f6f3ec; }
    h1 { font-size: 1.6rem; }
    article { background: #fff; border: 1px solid #ddd4c4; padding: 1rem 1.2rem; margin: 1rem 0; }
    .meta { color: #5c564c; }
    pre { white-space: pre-wrap; background: #f3efe6; padding: 0.8rem; }
    li.blocked { color: #8a2b2b; }
  </style>
</head>
<body>
  <h1>Refund Desk ledger</h1>
  <p class="meta">Read-only. Sends, finance flags, and refund records on this page are simulated. Nothing here approves an action.</p>
  ${body}
</body>
</html>`;
}

function renderTicket(ticket: TicketView): string {
  const proposals = ticket.proposals
    .map((row) => `<li>${escapeHtml(row.action)}: ${escapeHtml(row.status)}</li>`)
    .join("");
  const actions = ticket.actions
    .map((row) => `<li>${escapeHtml(row.action)} executed. ${escapeHtml(row.reason)}</li>`)
    .join("");
  const audits = ticket.audits
    .map((row) => {
      const payload = JSON.parse(row.payload_json) as { reason?: string; verbatim?: string; rejected?: string[] };
      const detail = payload.reason
        ? rejectionSentence(payload.reason)
        : payload.rejected
          ? `rejected citations ${payload.rejected.join(", ")}`
          : row.kind;
      const klass = row.kind === "approval_rejected" ? "blocked" : "";
      return `<li class="${klass}">${escapeHtml(row.kind)}: ${escapeHtml(String(detail))}${payload.verbatim ? ` — ${escapeHtml(payload.verbatim)}` : ""}</li>`;
    })
    .join("");
  return `<article>
    <h2>Order ${escapeHtml(ticket.order_id ?? "unknown")} · ${escapeHtml(ticket.status)}</h2>
    <p>${escapeHtml(ticket.summary)}</p>
    <p class="meta">Label ${escapeHtml(ticket.label)}. Eligibility ${escapeHtml(ticket.eligibility)}, from the order and the policy. Proposal version ${ticket.proposal_version}.</p>
    <h3>Unsent draft</h3>
    <pre>${escapeHtml(ticket.customer_reply ?? "")}</pre>
    <h3>Proposals</h3>
    <ul>${proposals}</ul>
    <h3>Executed</h3>
    <ul>${actions || "<li>Nothing executed.</li>"}</ul>
    <h3>Audit</h3>
    <ul>${audits}</ul>
  </article>`;
}

export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function startLedger(db: DatabaseSync, port: number): Promise<Server> {
  const server = createServer((req, res) => {
    if (req.method !== "GET") {
      res.writeHead(404);
      res.end("not found");
      return;
    }
    const path = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
    if (path === "/api/ledger") {
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ tickets: loadLedger(db) }));
      return;
    }
    if (path === "/") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(renderLedgerHtml(loadLedger(db)));
      return;
    }
    res.writeHead(404);
    res.end("not found");
  });
  return new Promise((resolve) => {
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
}
