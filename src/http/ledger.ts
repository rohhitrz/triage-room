import { createServer, type Server } from "node:http";
import type { DatabaseSync } from "node:sqlite";
import { rejectionSentence, stripMention } from "../approval/parse.ts";

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
  needs_refresh: number;
  customer_name: string | null;
  amount_inr: number | null;
  customer_reply: string | null;
  finance_note: string | null;
  proposals: Proposal[];
  actions: ActionRow[];
  audits: AuditRow[];
};

export function loadLedger(db: DatabaseSync): TicketView[] {
  const tickets = db
    .prepare(
      `SELECT t.id, t.order_id, t.label, t.eligibility, t.status, t.summary, t.proposal_version, t.needs_refresh, t.finance_note,
              o.customer_name, o.amount_inr,
              (SELECT d.customer_reply FROM drafts d
               WHERE d.ticket_id = t.id AND d.proposal_version <= t.proposal_version
               ORDER BY d.proposal_version DESC, d.created_at DESC LIMIT 1) AS customer_reply
       FROM tickets t
       LEFT JOIN orders o ON o.id = t.order_id
       ORDER BY t.created_at DESC`,
    )
    .all() as Array<Omit<TicketView, "proposals" | "actions" | "audits">>;
  const proposals = db.prepare("SELECT action, status FROM proposals WHERE ticket_id = ? AND proposal_version = ? ORDER BY action");
  const actions = db.prepare("SELECT action, reason, created_at FROM actions WHERE ticket_id = ? ORDER BY created_at, action");
  const audits = db.prepare("SELECT kind, payload_json, created_at FROM audit_events WHERE ticket_id = ? ORDER BY id");
  return tickets.map((ticket) => ({
    ...ticket,
    proposals: proposals.all(ticket.id, ticket.proposal_version) as Proposal[],
    actions: actions.all(ticket.id) as ActionRow[],
    audits: audits.all(ticket.id) as AuditRow[],
  }));
}

const ACTION_LABEL: Record<string, string> = {
  send_reply: "Send the reply to the customer",
  flag_finance: "Flag it for finance",
  issue_refund: "Record the refund",
};

type Payload = {
  reason?: string;
  verbatim?: string;
  rejected?: string[];
  action?: string;
  eligibility?: string;
  resent?: boolean;
  message?: string;
};

function parsePayload(json: string): Payload {
  try {
    return JSON.parse(json) as Payload;
  } catch {
    return {};
  }
}

function clock(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
}

function timeTag(iso: string): string {
  return `<time datetime="${escapeHtml(iso)}">${escapeHtml(clock(iso))}</time>`;
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

function sentence(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return trimmed;
  return `${trimmed[0].toUpperCase()}${trimmed.slice(1)}${/[.!?]$/.test(trimmed) ? "" : "."}`;
}

function ticketState(ticket: TicketView): { key: string; label: string } {
  if (ticket.needs_refresh) return { key: "cleared", label: "Cleared, repost needed" };
  if (ticket.status === "closed") return { key: "done", label: "Done" };
  if (ticket.status === "partially_executed") return { key: "partial", label: "Partly done" };
  return { key: "wait", label: "Waiting for approval" };
}

function verdict(ticket: TicketView): string {
  if (ticket.label === "question") return "Not a refund case.";
  return ticket.eligibility === "eligible" ? "Eligible for a refund." : "Not eligible for a refund.";
}

function historyLine(row: AuditRow): string {
  const payload = parsePayload(row.payload_json);
  switch (row.kind) {
    case "draft_stored":
      return payload.resent ? "Draft rewritten after the ticket was reposted." : "Draft written. Eligibility checked by code.";
    case "approval_rejected":
      return `Approval blocked: ${rejectionSentence(payload.reason ?? "")}.`;
    case "action_executed":
      return `${ACTION_LABEL[payload.action ?? ""] ?? payload.action ?? "Action"}: ran as a simulation.`;
    case "citation_rejected":
      return `The model cited a policy that does not exist (${(payload.rejected ?? []).join(", ")}). Ignored.`;
    case "proposal_refreshed":
      return "Proposal cleared. Room history after a connection gap could not be checked.";
    case "model_failed":
      return "The model call failed. Nothing was drafted.";
    default:
      return row.kind.replaceAll("_", " ");
  }
}

function summaryLine(tickets: TicketView[]): string {
  if (tickets.length === 0) return "No tickets yet.";
  const waiting = tickets
    .filter((ticket) => !ticket.needs_refresh)
    .reduce((n, ticket) => n + ticket.proposals.filter((row) => row.status === "pending").length, 0);
  const blocked = tickets.reduce((n, ticket) => n + ticket.audits.filter((row) => row.kind === "approval_rejected").length, 0);
  const ran = tickets.reduce((n, ticket) => n + ticket.actions.length, 0);
  return [
    `${plural(tickets.length, "ticket", "tickets")}.`,
    `${plural(waiting, "action", "actions")} waiting for approval.`,
    `${plural(ran, "action", "actions")} ran.`,
    `${plural(blocked, "approval", "approvals")} blocked.`,
  ].join(" ");
}

export function renderLedgerHtml(tickets: TicketView[]): string {
  const body =
    tickets.length === 0
      ? `<section class="empty">
      <h2>No tickets yet</h2>
      <p>Mention the agent in the room with an order number, for example:</p>
      <p class="example">@refund-desk Order #4821 charged twice, customer wants a refund.</p>
      <p>This page picks it up within a few seconds.</p>
    </section>`
      : tickets.map(renderTicket).join("\n");
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light dark">
  <title>Refund Desk ledger</title>
  <noscript><meta http-equiv="refresh" content="3"></noscript>
  <style>${STYLES}</style>
</head>
<body>
  <header class="page-head">
    <h1>Refund Desk</h1>
    <p class="lede">The ledger behind the room. Every action here is simulated: no email is sent, no finance system is contacted, and no money moves. Approvals happen in the Mattermost thread, not on this page.</p>
    <p class="tally" id="tally">${escapeHtml(summaryLine(tickets))}</p>
  </header>
  <main id="ledger">
  ${body}
  </main>
  <footer class="page-foot"><p>Updates every 3 seconds. Last read <span id="stamp">${escapeHtml(clock(new Date().toISOString()))}</span>.</p></footer>
  <script>${SCRIPT}</script>
</body>
</html>`;
}

function renderTicket(ticket: TicketView): string {
  const state = ticketState(ticket);
  const ran = new Map(ticket.actions.map((row) => [row.action, row]));
  const order = Object.keys(ACTION_LABEL);
  const actionRows = [...ticket.proposals]
    .sort((a, b) => order.indexOf(a.action) - order.indexOf(b.action))
    .map((row) => {
      const done = row.status === "executed";
      const detail = done ? (ran.get(row.action)?.reason ?? "Ran as a simulation.") : "Waiting for your approval in the thread.";
      const when = done && ran.get(row.action) ? timeTag(ran.get(row.action)!.created_at) : "";
      return `<li class="action" data-state="${done ? "done" : "wait"}" data-key="${escapeHtml(`${ticket.id}:${row.action}:${row.status}`)}">
          <span class="mark" aria-hidden="true">${done ? "✓" : ""}</span>
          <div class="action-body">
            <p class="action-name">${escapeHtml(ACTION_LABEL[row.action] ?? row.action)} <span class="code">${escapeHtml(row.action)}</span></p>
            <p class="action-detail">${escapeHtml(detail)} ${when}</p>
          </div>
          <span class="sr-only">${done ? "Ran" : "Waiting"}</span>
        </li>`;
    })
    .join("");
  const actionsBlock = actionRows
    ? `<ul class="actions" aria-label="Proposed actions">${actionRows}</ul>`
    : ticket.needs_refresh
      ? `<p class="cleared-note">This proposal was cleared because room history could not be checked after a connection gap. Repost the ticket in the thread to draft it again.</p>`
      : `<p class="cleared-note">No actions proposed.</p>`;

  const blocked = ticket.audits.filter((row) => row.kind === "approval_rejected");
  const blockedBlock = blocked.length
    ? `<section class="blocked" aria-label="Blocked approvals">
        <h3>${blocked.length === 1 ? "Blocked approval" : "Blocked approvals"}</h3>
        <ul>${blocked
          .map((row) => {
            const payload = parsePayload(row.payload_json);
            return `<li data-key="${escapeHtml(`${ticket.id}:blocked:${row.created_at}`)}">
              <q>${escapeHtml(stripMention(payload.verbatim ?? ""))}</q>
              <p>${escapeHtml(sentence(rejectionSentence(payload.reason ?? "")))} Nothing was executed. ${timeTag(row.created_at)}</p>
            </li>`;
          })
          .join("")}</ul>
      </section>`
    : "";

  const who = [ticket.customer_name, ticket.amount_inr != null ? `₹${ticket.amount_inr.toLocaleString("en-IN")}` : null]
    .filter(Boolean)
    .join(", ");

  return `<article class="ticket" data-state="${state.key}">
    <header class="ticket-head">
      <h2 class="order"><span class="sr-only">Order </span><span class="hash" aria-hidden="true">#</span>${escapeHtml(ticket.order_id ?? "unknown")}</h2>
      <div class="ticket-meta">
        <p class="status">${escapeHtml(state.label)}</p>
        ${who ? `<p class="who">${escapeHtml(who)}</p>` : ""}
      </div>
    </header>
    <p class="verdict"><strong>${escapeHtml(verdict(ticket))}</strong> ${escapeHtml(ticket.summary)}</p>
    <p class="decided">Decided by code from the order and the refund policy. The model only writes the wording.</p>
    ${actionsBlock}
    ${blockedBlock}
    <details class="draft" data-key="${escapeHtml(`${ticket.id}:draft`)}" open>
      <summary>Draft reply to the customer <span class="hint">not sent</span></summary>
      <blockquote>${escapeHtml(ticket.customer_reply ?? "No draft yet.")}</blockquote>
    </details>
    <details class="history" data-key="${escapeHtml(`${ticket.id}:history`)}">
      <summary>History <span class="hint">${plural(ticket.audits.length, "event", "events")}</span></summary>
      <ol>${ticket.audits
        .map((row) => `<li class="${row.kind === "approval_rejected" ? "is-blocked" : ""}">${timeTag(row.created_at)}<span>${escapeHtml(historyLine(row))}</span></li>`)
        .join("")}</ol>
    </details>
  </article>`;
}

const STYLES = `
:root {
  --paper: #eef1f5; --surface: #ffffff; --ink: #172033; --muted: #5a6478; --line: #d5dbe5;
  --wait: #8a5200; --wait-bg: #fff3dc; --done: #17703f; --done-bg: #e3f3e9; --block: #a4262c; --block-bg: #fce9e9;
  --focus: #2457c5;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI Variable Text", "Segoe UI", Roboto, "Helvetica Neue", sans-serif;
  color: var(--ink); background: var(--paper);
  -webkit-text-size-adjust: 100%;
}
@media (prefers-color-scheme: dark) {
  :root {
    --paper: #0f1520; --surface: #171f2c; --ink: #e6ebf2; --muted: #9ba7b9; --line: #2a3546;
    --wait: #f2b85b; --wait-bg: #33270f; --done: #74d39d; --done-bg: #12301f; --block: #f3908f; --block-bg: #3a1719;
    --focus: #8fb2ff;
  }
}
* { box-sizing: border-box; }
body { margin: 0; font-size: 1rem; line-height: 1.5; }
.page-head, main, .page-foot { max-width: 42rem; margin: 0 auto; padding: 0 1rem; }
.page-head { padding-top: 2rem; padding-bottom: 0.5rem; }
h1 { font-size: 1.75rem; line-height: 1.15; margin: 0 0 0.5rem; letter-spacing: -0.01em; }
.lede { color: var(--muted); margin: 0 0 1rem; max-width: 36rem; }
.tally { margin: 0; font-weight: 600; font-variant-numeric: tabular-nums; }
.ticket { background: var(--surface); border: 1px solid var(--line); border-radius: 12px; margin: 1rem 0; padding: 1.25rem; border-top: 4px solid var(--state, var(--line)); }
.ticket[data-state="wait"], .ticket[data-state="cleared"] { --state: var(--wait); --state-bg: var(--wait-bg); }
.ticket[data-state="partial"], .ticket[data-state="done"] { --state: var(--done); --state-bg: var(--done-bg); }
.ticket-head { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 0.25rem 1rem; }
.order { margin: 0; font-size: clamp(2.25rem, 9vw, 3rem); line-height: 1; font-weight: 750; letter-spacing: -0.03em; font-variant-numeric: tabular-nums lining-nums; }
.hash { color: var(--muted); font-weight: 500; margin-right: 0.05em; }
.ticket-meta { text-align: right; }
.status { display: inline-block; margin: 0; padding: 0.2rem 0.65rem; border-radius: 999px; font-size: 0.875rem; font-weight: 650; color: var(--state); background: var(--state-bg); }
.who { margin: 0.25rem 0 0; color: var(--muted); font-size: 0.9rem; font-variant-numeric: tabular-nums; }
.verdict { margin: 1rem 0 0.25rem; }
.decided { margin: 0 0 1rem; color: var(--muted); font-size: 0.875rem; }
.actions { list-style: none; margin: 0; padding: 0; border-top: 1px solid var(--line); }
.action { display: grid; grid-template-columns: 1.75rem 1fr; gap: 0.75rem; padding: 0.75rem 0; border-bottom: 1px solid var(--line); }
.action:last-child { border-bottom: 0; }
.mark { width: 1.5rem; height: 1.5rem; border-radius: 50%; display: grid; place-items: center; font-size: 0.85rem; font-weight: 800; margin-top: 0.1rem; }
.action[data-state="done"] .mark { background: var(--done); color: var(--surface); }
.action[data-state="wait"] .mark { border: 2px dashed var(--wait); }
.action-name { margin: 0; font-weight: 600; }
.code { font-weight: 400; color: var(--muted); font-size: 0.85rem; white-space: nowrap; }
.action-detail { margin: 0.1rem 0 0; color: var(--muted); font-size: 0.9rem; }
.action[data-state="wait"] .action-detail { color: var(--wait); }
time { color: var(--muted); font-size: 0.8rem; font-variant-numeric: tabular-nums; white-space: nowrap; }
.cleared-note { margin: 0; padding: 0.75rem 1rem; border-radius: 8px; background: var(--wait-bg); color: var(--wait); }
.blocked { margin: 1rem 0 0; padding: 0.85rem 1rem; border-radius: 8px; background: var(--block-bg); border-left: 4px solid var(--block); }
.blocked h3 { margin: 0 0 0.35rem; font-size: 0.95rem; color: var(--block); }
.blocked ul { list-style: none; margin: 0; padding: 0; }
.blocked li + li { margin-top: 0.6rem; }
.blocked q { font-weight: 600; quotes: "“" "”"; }
.blocked p { margin: 0.1rem 0 0; font-size: 0.9rem; }
details { margin-top: 1rem; border-top: 1px solid var(--line); padding-top: 0.75rem; }
summary { cursor: pointer; font-weight: 600; list-style-position: outside; }
summary:focus-visible, a:focus-visible { outline: 3px solid var(--focus); outline-offset: 3px; border-radius: 4px; }
.hint { font-weight: 400; color: var(--muted); font-size: 0.875rem; margin-left: 0.25rem; }
blockquote { margin: 0.6rem 0 0; padding: 0.1rem 0 0.1rem 1rem; border-left: 3px solid var(--line); font-size: 1.02rem; line-height: 1.6; max-width: 36rem; white-space: pre-wrap; }
.history ol { list-style: none; margin: 0.6rem 0 0; padding: 0; }
.history li { display: grid; grid-template-columns: 4.5rem 1fr; gap: 0.5rem; padding: 0.3rem 0; font-size: 0.9rem; }
.history li.is-blocked span { color: var(--block); }
.empty { background: var(--surface); border: 1px dashed var(--line); border-radius: 12px; padding: 1.5rem; margin: 1rem 0; }
.empty h2 { margin: 0 0 0.5rem; font-size: 1.2rem; }
.example { font-weight: 600; }
.page-foot { color: var(--muted); font-size: 0.85rem; padding-bottom: 2rem; }
.sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }
.fresh { animation: fresh 2.4s ease-out; }
@keyframes fresh { from { background: var(--done-bg); box-shadow: 0 0 0 6px var(--done-bg); } to { background: transparent; box-shadow: 0 0 0 6px transparent; } }
@media (prefers-reduced-motion: reduce) { .fresh { animation: none; } }
@media (max-width: 30rem) {
  .page-head { padding-top: 1.25rem; }
  .ticket { padding: 1rem; border-radius: 10px; }
  .ticket-meta { text-align: left; width: 100%; }
  .history li { grid-template-columns: 1fr; gap: 0; }
}
`;

// Re-reads the page every 3 seconds and swaps only the ledger, so scroll position and
// open or closed sections survive. Rows that appear for the first time get one highlight.
const SCRIPT = `
(() => {
  const main = () => document.getElementById("ledger");
  let last = main().innerHTML;
  async function tick() {
    try {
      const res = await fetch(location.pathname, { cache: "no-store" });
      const doc = new DOMParser().parseFromString(await res.text(), "text/html");
      const next = doc.getElementById("ledger");
      document.getElementById("stamp").textContent = doc.getElementById("stamp").textContent;
      if (!next || next.innerHTML === last) return;
      last = next.innerHTML;
      const current = main();
      const open = new Map([...current.querySelectorAll("details[data-key]")].map((d) => [d.dataset.key, d.open]));
      const known = new Set([...current.querySelectorAll("li[data-key]")].map((li) => li.dataset.key));
      for (const d of next.querySelectorAll("details[data-key]")) if (open.has(d.dataset.key)) d.open = open.get(d.dataset.key);
      for (const li of next.querySelectorAll("li[data-key]")) if (!known.has(li.dataset.key)) li.classList.add("fresh");
      current.replaceWith(next);
      document.getElementById("tally").textContent = doc.getElementById("tally").textContent;
    } catch {}
  }
  setInterval(tick, 3000);
})();
`;

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
