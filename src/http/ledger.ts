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
  email: string | null;
  amount_inr: number | null;
  charge_count: number | null;
  placed_on: string | null;
  created_at: string;
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
              t.created_at, o.customer_name, o.email, o.amount_inr, o.charge_count, o.placed_on,
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
  send_reply: "Send reply to customer",
  flag_finance: "Flag for finance review",
  issue_refund: "Record refund",
};

type Tone = "success" | "warning" | "danger" | "info" | "neutral";

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

function clock(iso: string, seconds = false): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", ...(seconds ? { second: "2-digit" } : {}), hour12: false });
}

function day(value: string | null): string {
  if (!value) return "—";
  const date = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
}

function timeTag(iso: string, seconds = false): string {
  return `<time datetime="${escapeHtml(iso)}">${escapeHtml(clock(iso, seconds))}</time>`;
}

function money(amount: number | null): string {
  return amount == null ? "—" : `₹${amount.toLocaleString("en-IN")}`;
}

function sentence(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return trimmed;
  return `${trimmed[0].toUpperCase()}${trimmed.slice(1)}${/[.!?]$/.test(trimmed) ? "" : "."}`;
}

function badge(tone: Tone, label: string): string {
  return `<span class="badge badge-${tone}"><span class="badge-dot" aria-hidden="true"></span>${escapeHtml(label)}</span>`;
}

function ticketStatus(ticket: TicketView): { tone: Tone; label: string } {
  if (ticket.needs_refresh) return { tone: "warning", label: "Needs repost" };
  if (ticket.status === "closed") return { tone: "success", label: "Completed" };
  if (ticket.status === "partially_executed") return { tone: "info", label: "Partially executed" };
  return { tone: "warning", label: "Awaiting approval" };
}

function eligibilityBadge(ticket: TicketView): string {
  if (ticket.label === "question") return badge("neutral", "Not a refund request");
  return ticket.eligibility === "eligible" ? badge("success", "Eligible") : badge("neutral", "Not eligible");
}

function lastActivity(ticket: TicketView): string {
  return ticket.audits.reduce((latest, row) => (row.created_at > latest ? row.created_at : latest), ticket.created_at);
}

function activityLine(row: AuditRow): { tone: Tone; text: string } {
  const payload = parsePayload(row.payload_json);
  switch (row.kind) {
    case "draft_stored":
      return { tone: "neutral", text: payload.resent ? "Draft rewritten after the ticket was reposted" : "Ticket opened and draft prepared" };
    case "approval_rejected":
      return { tone: "danger", text: `Approval blocked: ${rejectionSentence(payload.reason ?? "")}` };
    case "action_executed":
      return { tone: "success", text: `${ACTION_LABEL[payload.action ?? ""] ?? payload.action ?? "Action"} executed (simulated)` };
    case "citation_rejected":
      return { tone: "warning", text: `Model cited an unknown policy clause (${(payload.rejected ?? []).join(", ")}); ignored` };
    case "proposal_refreshed":
      return { tone: "warning", text: "Proposal cleared after a connection gap in room history" };
    case "model_failed":
      return { tone: "danger", text: "Draft failed: the model request did not succeed" };
    default:
      return { tone: "neutral", text: sentence(row.kind.replaceAll("_", " ")) };
  }
}

function metrics(tickets: TicketView[]): Array<{ label: string; value: number }> {
  const awaiting = tickets
    .filter((ticket) => !ticket.needs_refresh)
    .reduce((n, ticket) => n + ticket.proposals.filter((row) => row.status === "pending").length, 0);
  return [
    { label: "Tickets", value: tickets.length },
    { label: "Actions awaiting approval", value: awaiting },
    { label: "Actions executed", value: tickets.reduce((n, ticket) => n + ticket.actions.length, 0) },
    { label: "Approvals blocked", value: tickets.reduce((n, t) => n + t.audits.filter((row) => row.kind === "approval_rejected").length, 0) },
  ];
}

const MARK = `<svg viewBox="0 0 20 20" width="20" height="20" aria-hidden="true"><rect width="20" height="20" rx="5" fill="currentColor"/><path d="M6 5.5h8M6 9h8M6 12.5h4.5" stroke="var(--mark-ink)" stroke-width="1.6" stroke-linecap="round"/><path d="m11.5 13.6 1.4 1.4 2.6-2.8" stroke="var(--mark-ink)" stroke-width="1.6" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

const INFO = `<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M8 7.2v3.6M8 5.2v.1" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>`;

export function renderLedgerHtml(tickets: TicketView[]): string {
  const stats = metrics(tickets)
    .map((m) => `<div class="metric"><dt>${escapeHtml(m.label)}</dt><dd>${m.value}</dd></div>`)
    .join("");
  const body =
    tickets.length === 0
      ? `<section class="empty">
          <h2>No tickets yet</h2>
          <p>Mention the agent in the Mattermost room with an order number. The ticket appears here within a few seconds.</p>
          <p class="example">@refund-desk Order #4821 charged twice, customer wants a refund.</p>
        </section>`
      : `<div class="workspace">
          <section class="queue" aria-label="Tickets">
            <header class="queue-head"><h2>Tickets</h2><span class="count">${tickets.length}</span></header>
            <ul class="queue-list">${tickets.map((ticket, i) => renderRow(ticket, i === 0)).join("")}</ul>
          </section>
          <div class="details">${tickets.map((ticket, i) => renderDetail(ticket, i === 0)).join("")}</div>
        </div>`;
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light dark">
  <title>Refund Desk · Ledger</title>
  <noscript><meta http-equiv="refresh" content="3"></noscript>
  <style>${STYLES}</style>
</head>
<body>
  <header class="topbar">
    <div class="topbar-inner">
      <a class="brand" href="/">${MARK}<span>Refund Desk</span></a>
      <div class="topbar-status">
        <span class="mode" title="Sends, finance flags and refunds are recorded in the ledger only. No email, finance system or payment is touched.">Simulation mode</span>
        <span class="live"><span class="live-dot" aria-hidden="true"></span>Live <span class="live-time">updated <span id="stamp">${escapeHtml(clock(new Date().toISOString(), true))}</span></span></span>
      </div>
    </div>
  </header>
  <div class="page">
    <header class="page-head">
      <h1>Ledger</h1>
      <p>Refund tickets from the Mattermost room. Approvals are given in each ticket's thread; this page is read-only.</p>
    </header>
    <dl class="metrics" id="metrics">${stats}</dl>
    <main id="ledger">${body}</main>
  </div>
  <script>${SCRIPT}</script>
</body>
</html>`;
}

function renderRow(ticket: TicketView, selected: boolean): string {
  const status = ticketStatus(ticket);
  return `<li>
    <a class="row" href="#${escapeHtml(ticket.id)}" data-ticket-row="${escapeHtml(ticket.id)}" aria-current="${selected}">
      <span class="row-main">
        <span class="row-order">Order ${escapeHtml(ticket.order_id ?? "unknown")}</span>
        <span class="row-customer">${escapeHtml(ticket.customer_name ?? "Unknown customer")}</span>
      </span>
      <span class="row-side">
        ${badge(status.tone, status.label)}
        <span class="row-meta"><span class="num">${escapeHtml(money(ticket.amount_inr))}</span> ${timeTag(lastActivity(ticket))}</span>
      </span>
    </a>
  </li>`;
}

function renderDetail(ticket: TicketView, selected: boolean): string {
  const status = ticketStatus(ticket);
  const ran = new Map(ticket.actions.map((row) => [row.action, row]));
  const order = Object.keys(ACTION_LABEL);
  const proposals = [...ticket.proposals].sort((a, b) => order.indexOf(a.action) - order.indexOf(b.action));
  const actionRows = proposals
    .map((row) => {
      const done = row.status === "executed";
      const run = ran.get(row.action);
      const detail = done ? (run?.reason ?? "Executed as a simulation.") : "Runs only after the owner approves it in the ticket thread.";
      return `<li class="item" data-key="${escapeHtml(`${ticket.id}:${row.action}:${row.status}`)}">
        <div class="item-main">
          <p class="item-title">${escapeHtml(ACTION_LABEL[row.action] ?? row.action)} <span class="item-code">${escapeHtml(row.action)}</span></p>
          <p class="item-sub">${escapeHtml(detail)}</p>
        </div>
        <div class="item-side">${done ? badge("success", "Executed") : badge("warning", "Awaiting approval")}${done && run ? timeTag(run.created_at) : ""}</div>
      </li>`;
    })
    .join("");
  const actionsBody = actionRows
    ? `<ul class="items">${actionRows}</ul>`
    : `<p class="panel-empty">${
        ticket.needs_refresh
          ? "This proposal was cleared because room history could not be verified after a connection gap. Repost the ticket in its thread to draft it again."
          : "No actions proposed."
      }</p>`;

  const blocked = ticket.audits.filter((row) => row.kind === "approval_rejected");
  const blockedPanel = blocked.length
    ? `<section class="panel">
        <header class="panel-head"><h3>Blocked approvals</h3><span class="count">${blocked.length}</span></header>
        <ul class="items">${blocked
          .map((row) => {
            const payload = parsePayload(row.payload_json);
            return `<li class="item" data-key="${escapeHtml(`${ticket.id}:blocked:${row.created_at}`)}">
              <div class="item-main">
                <p class="item-title quote">“${escapeHtml(stripMention(payload.verbatim ?? ""))}”</p>
                <p class="item-sub">${escapeHtml(sentence(rejectionSentence(payload.reason ?? "")))} Nothing was executed.</p>
              </div>
              <div class="item-side">${badge("danger", "Blocked")}${timeTag(row.created_at)}</div>
            </li>`;
          })
          .join("")}</ul>
      </section>`
    : "";

  const activity = ticket.audits
    .map((row) => {
      const line = activityLine(row);
      return `<li class="event event-${line.tone}"><span class="event-dot" aria-hidden="true"></span><span class="event-text">${escapeHtml(line.text)}</span>${timeTag(row.created_at, true)}</li>`;
    })
    .join("");

  return `<article class="detail" data-ticket-detail="${escapeHtml(ticket.id)}" id="${escapeHtml(ticket.id)}"${selected ? "" : " hidden"}>
    <header class="detail-head">
      <div class="detail-title">
        <h2>Order ${escapeHtml(ticket.order_id ?? "unknown")}</h2>
        ${badge(status.tone, status.label)}
      </div>
      <p class="detail-sub">Opened ${timeTag(ticket.created_at)} from a room thread</p>
    </header>

    <section class="panel">
      <dl class="facts">
        <div><dt>Customer</dt><dd>${escapeHtml(ticket.customer_name ?? "—")}${ticket.email ? `<span class="fact-sub">${escapeHtml(ticket.email)}</span>` : ""}</dd></div>
        <div><dt>Amount</dt><dd class="num">${escapeHtml(money(ticket.amount_inr))}${ticket.charge_count != null ? `<span class="fact-sub">Charged ${ticket.charge_count} ${ticket.charge_count === 1 ? "time" : "times"}</span>` : ""}</dd></div>
        <div><dt>Placed on</dt><dd>${escapeHtml(day(ticket.placed_on))}</dd></div>
        <div><dt>Eligibility</dt><dd>${eligibilityBadge(ticket)}</dd></div>
      </dl>
      <div class="decision">
        ${INFO}
        <div>
          <p>${escapeHtml(ticket.summary)}</p>
          <p class="decision-note">Eligibility comes from the order record and the refund policy. The model only drafts the customer wording.</p>
        </div>
      </div>
    </section>

    <section class="panel">
      <header class="panel-head"><h3>Proposed actions</h3><span class="count">${proposals.length}</span></header>
      ${actionsBody}
    </section>

    ${blockedPanel}

    <section class="panel">
      <header class="panel-head"><h3>Draft reply</h3>${badge("neutral", "Not sent")}</header>
      <div class="draft">${escapeHtml(ticket.customer_reply ?? "No draft yet.")}</div>
    </section>

    <section class="panel">
      <header class="panel-head"><h3>Activity</h3><span class="count">${ticket.audits.length}</span></header>
      <ol class="events">${activity}</ol>
    </section>
  </article>`;
}

const STYLES = `
:root {
  --bg: #f6f7f9; --surface: #ffffff; --subtle: #f9fafb; --border: #e4e7ec; --border-strong: #d0d5dd;
  --text: #101828; --text-2: #475467; --text-3: #667085;
  --brand: #3b5bdb; --brand-soft: #eef2ff; --mark-ink: #ffffff;
  --success: #067647; --success-bg: #ecfdf3; --success-line: #abefc6;
  --warning: #b54708; --warning-bg: #fffaeb; --warning-line: #fedf89;
  --danger: #b42318; --danger-bg: #fef3f2; --danger-line: #fecdca;
  --info: #175cd3; --info-bg: #eff8ff; --info-line: #b2ddff;
  --neutral: #344054; --neutral-bg: #f2f4f7; --neutral-line: #e4e7ec;
  --shadow: 0 1px 2px rgba(16, 24, 40, 0.05);
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI Variable Text", "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  font-size: 14px; line-height: 20px; color: var(--text); background: var(--bg);
  -webkit-font-smoothing: antialiased; -webkit-text-size-adjust: 100%;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #0c0e12; --surface: #13161b; --subtle: #181c22; --border: #22262f; --border-strong: #333741;
    --text: #f5f5f6; --text-2: #cecfd2; --text-3: #94969c;
    --brand: #7c93f5; --brand-soft: #1b2340; --mark-ink: #0c0e12;
    --success: #75e0a7; --success-bg: #0b2a1c; --success-line: #135a39;
    --warning: #fdb022; --warning-bg: #2b1d06; --warning-line: #5c3c07;
    --danger: #fda29b; --danger-bg: #2d0e0b; --danger-line: #6b1e17;
    --info: #84caff; --info-bg: #0a2340; --info-line: #144b84;
    --neutral: #cecfd2; --neutral-bg: #1f242f; --neutral-line: #333741;
    --shadow: none;
  }
}
* { box-sizing: border-box; }
body { margin: 0; }
h1, h2, h3, p, dl, dd, ol, ul { margin: 0; }
ul, ol { list-style: none; padding: 0; }
a { color: inherit; text-decoration: none; }
:focus-visible { outline: 2px solid var(--brand); outline-offset: 2px; border-radius: 6px; }
.num, time, .count, .metric dd { font-variant-numeric: tabular-nums; }
time { color: var(--text-3); font-size: 12px; white-space: nowrap; }

.topbar { background: var(--surface); border-bottom: 1px solid var(--border); position: sticky; top: 0; z-index: 2; }
.topbar-inner { max-width: 1200px; margin: 0 auto; padding: 0 24px; height: 56px; display: flex; align-items: center; justify-content: space-between; gap: 16px; }
.brand { display: inline-flex; align-items: center; gap: 10px; font-weight: 600; font-size: 15px; color: var(--text); }
.brand svg { color: var(--brand); flex: none; }
.topbar-status { display: flex; align-items: center; gap: 16px; color: var(--text-2); font-size: 13px; }
.mode { border: 1px solid var(--border-strong); border-radius: 6px; padding: 2px 8px; font-weight: 500; color: var(--text-2); cursor: help; }
.live { display: inline-flex; align-items: center; gap: 6px; font-weight: 500; }
.live-time { color: var(--text-3); font-weight: 400; }
.live-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--success); box-shadow: 0 0 0 3px var(--success-bg); }

.page { max-width: 1200px; margin: 0 auto; padding: 28px 24px 48px; }
.page-head h1 { font-size: 24px; line-height: 32px; font-weight: 600; letter-spacing: -0.01em; }
.page-head p { margin-top: 4px; color: var(--text-2); max-width: 640px; }

.metrics { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); margin: 24px 0; background: var(--surface); border: 1px solid var(--border); border-radius: 10px; box-shadow: var(--shadow); }
.metric { padding: 14px 20px; }
.metric + .metric { border-left: 1px solid var(--border); }
.metric dt { color: var(--text-2); font-size: 13px; font-weight: 500; }
.metric dd { font-size: 24px; line-height: 32px; font-weight: 600; margin-top: 4px; }

.workspace { display: grid; grid-template-columns: 340px minmax(0, 1fr); gap: 24px; align-items: start; }
.queue { background: var(--surface); border: 1px solid var(--border); border-radius: 10px; box-shadow: var(--shadow); position: sticky; top: 80px; overflow: hidden; }
.queue-head, .panel-head { display: flex; align-items: center; gap: 8px; padding: 12px 16px; border-bottom: 1px solid var(--border); }
.queue-head h2, .panel-head h3 { font-size: 14px; font-weight: 600; }
.panel-head .badge { margin-left: auto; }
.count { font-size: 12px; font-weight: 500; color: var(--text-2); background: var(--neutral-bg); border-radius: 999px; padding: 0 8px; line-height: 20px; }
.queue-list li + li { border-top: 1px solid var(--border); }
.row { display: flex; justify-content: space-between; gap: 12px; padding: 12px 16px; border-left: 3px solid transparent; }
.row:hover { background: var(--subtle); }
.row[aria-current="true"] { background: var(--brand-soft); border-left-color: var(--brand); }
.row-main, .row-side { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.row-side { align-items: flex-end; flex: none; }
.row-order { font-weight: 600; }
.row-customer { color: var(--text-2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.row-meta { color: var(--text-2); font-size: 12px; display: inline-flex; gap: 8px; }

.detail { display: grid; gap: 16px; }
.detail[hidden] { display: none; }
.detail-title { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.detail-title h2 { font-size: 20px; line-height: 28px; font-weight: 600; letter-spacing: -0.01em; }
.detail-sub { color: var(--text-3); margin-top: 2px; font-size: 13px; }
.detail-sub time { font-size: 13px; }

.panel { background: var(--surface); border: 1px solid var(--border); border-radius: 10px; box-shadow: var(--shadow); overflow: hidden; }
.panel-empty { padding: 16px; color: var(--text-2); }
.facts { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); }
.facts > div { padding: 14px 16px; }
.facts > div + div { border-left: 1px solid var(--border); }
.facts dt { font-size: 12px; color: var(--text-3); font-weight: 500; }
.facts dd { margin-top: 4px; font-weight: 500; display: flex; flex-direction: column; align-items: flex-start; gap: 2px; }
.fact-sub { font-size: 12px; font-weight: 400; color: var(--text-3); overflow-wrap: anywhere; }
.decision { display: flex; gap: 10px; padding: 14px 16px; border-top: 1px solid var(--border); background: var(--subtle); color: var(--text-2); }
.decision svg { flex: none; margin-top: 2px; color: var(--text-3); }
.decision p:first-child { color: var(--text); }
.decision-note { margin-top: 2px; font-size: 13px; color: var(--text-3); }

.items li + li { border-top: 1px solid var(--border); }
.item { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; padding: 12px 16px; }
.item-main { min-width: 0; }
.item-title { font-weight: 500; }
.item-title.quote { font-weight: 500; }
.item-code { color: var(--text-3); font-size: 12px; font-weight: 400; margin-left: 4px; }
.item-sub { color: var(--text-2); font-size: 13px; margin-top: 2px; }
.item-side { display: flex; flex-direction: column; align-items: flex-end; gap: 4px; flex: none; }

.draft { padding: 16px; white-space: pre-wrap; line-height: 22px; max-width: 68ch; }

.events { padding: 8px 16px 12px; }
.event { display: grid; grid-template-columns: 16px minmax(0, 1fr) auto; gap: 10px; align-items: baseline; padding: 6px 0; position: relative; }
.event:not(:last-child)::before { content: ""; position: absolute; left: 3px; top: 18px; bottom: -8px; width: 2px; background: var(--border); }
.event-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--text-3); position: relative; top: -1px; }
.event-success .event-dot { background: var(--success); }
.event-danger .event-dot { background: var(--danger); }
.event-warning .event-dot { background: var(--warning); }
.event-text { color: var(--text-2); }

.badge { display: inline-flex; align-items: center; gap: 6px; padding: 0 8px; border-radius: 999px; font-size: 12px; line-height: 20px; font-weight: 500; white-space: nowrap; border: 1px solid; }
.badge-dot { width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
.badge-success { color: var(--success); background: var(--success-bg); border-color: var(--success-line); }
.badge-warning { color: var(--warning); background: var(--warning-bg); border-color: var(--warning-line); }
.badge-danger { color: var(--danger); background: var(--danger-bg); border-color: var(--danger-line); }
.badge-info { color: var(--info); background: var(--info-bg); border-color: var(--info-line); }
.badge-neutral { color: var(--neutral); background: var(--neutral-bg); border-color: var(--neutral-line); }

.empty { background: var(--surface); border: 1px dashed var(--border-strong); border-radius: 10px; padding: 32px; text-align: center; }
.empty h2 { font-size: 16px; font-weight: 600; }
.empty p { color: var(--text-2); margin-top: 6px; }
.empty .example { display: inline-block; margin-top: 12px; padding: 6px 12px; border-radius: 6px; background: var(--neutral-bg); color: var(--text); font-weight: 500; }

.fresh { animation: fresh 2s ease-out; }
@keyframes fresh { from { background: var(--success-bg); } to { background: transparent; } }
@media (prefers-reduced-motion: reduce) { .fresh { animation: none; } }

@media (max-width: 960px) {
  .workspace { grid-template-columns: 1fr; }
  .queue { position: static; }
  .facts { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .facts > div:nth-child(3) { border-left: 0; }
  .facts > div:nth-child(n + 3) { border-top: 1px solid var(--border); }
}
@media (max-width: 640px) {
  .topbar-inner { padding: 0 16px; }
  .live-time, .mode { display: none; }
  .page { padding: 20px 16px 40px; }
  .metrics { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .metric { padding: 12px 16px; }
  .metric:nth-child(3) { border-left: 0; }
  .metric:nth-child(n + 3) { border-top: 1px solid var(--border); }
  .metric dd { font-size: 20px; line-height: 28px; }
  .item { flex-direction: column; gap: 8px; }
  .item-side { flex-direction: row; align-items: center; gap: 8px; }
}
`;

// Selection, and a 3-second refresh that swaps only the ledger so scroll position,
// the selected ticket and anything highlighted survive. New rows get one brief highlight.
const SCRIPT = `
(() => {
  let selected = decodeURIComponent(location.hash.slice(1)) || sessionStorage.getItem("rd-selected") || "";
  const narrow = matchMedia("(max-width: 960px)");
  const calm = matchMedia("(prefers-reduced-motion: reduce)");
  function apply() {
    const root = document.getElementById("ledger");
    const rows = [...root.querySelectorAll("[data-ticket-row]")];
    if (!rows.length) return;
    if (!rows.some((r) => r.dataset.ticketRow === selected)) selected = rows[0].dataset.ticketRow;
    for (const r of rows) r.setAttribute("aria-current", String(r.dataset.ticketRow === selected));
    for (const d of root.querySelectorAll("[data-ticket-detail]")) d.hidden = d.dataset.ticketDetail !== selected;
  }
  document.addEventListener("click", (event) => {
    const row = event.target.closest("[data-ticket-row]");
    if (!row) return;
    event.preventDefault();
    selected = row.dataset.ticketRow;
    sessionStorage.setItem("rd-selected", selected);
    history.replaceState(null, "", "#" + encodeURIComponent(selected));
    apply();
    if (narrow.matches) {
      const detail = document.querySelector("[data-ticket-detail=\\"" + CSS.escape(selected) + "\\"]");
      if (detail) detail.scrollIntoView({ behavior: calm.matches ? "auto" : "smooth", block: "start" });
    }
  });
  apply();
  let last = document.getElementById("ledger").innerHTML;
  async function tick() {
    try {
      const res = await fetch(location.pathname, { cache: "no-store" });
      const doc = new DOMParser().parseFromString(await res.text(), "text/html");
      document.getElementById("stamp").textContent = doc.getElementById("stamp").textContent;
      const next = doc.getElementById("ledger");
      if (!next || next.innerHTML === last) return;
      last = next.innerHTML;
      const current = document.getElementById("ledger");
      const known = new Set([...current.querySelectorAll("[data-key]")].map((el) => el.dataset.key));
      for (const el of next.querySelectorAll("[data-key]")) if (!known.has(el.dataset.key)) el.classList.add("fresh");
      current.replaceWith(next);
      document.getElementById("metrics").replaceWith(doc.getElementById("metrics"));
      apply();
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
