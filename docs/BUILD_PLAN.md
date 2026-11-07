# Build plan — Refund Desk

How I built Refund Desk: in this order, one commit per stage, pushing only after that stage's tests passed.

The deadline was 7 Nov 2026, 11:59 PM IST, so I cut scope early: no full-text search, no tracing, no Next.js app. Switch came first because the room is the product. The machine setup (Docker, Console, keys, filming) lives in the README, not in the code.

## Stages

### 1. Scaffold

Package, `.gitignore` (`.env`, `data/`), `.env.example`, SQLite schema, migrator, seed orders and the three policy clauses. One test that the seed loads and the window clock is frozen.

Commit: `Add the project scaffold, ledger schema, and seed data.`

### 2. Switch socket and registration

Client against the documented protocol, plus a fake Switch server for tests. Register only with a registration key. Set `owner_only`. Open the socket with the room claimed, then fetch context. Answer pings for a compressed 5-minute heartbeat (150 pings). Post only with a thread id. Record health, versions, and the op schema when a real server answers. No channel-root fallback.

Commit: `Register with Switch and hold an in-thread WebSocket session.`

### 3. Approval gate

Fail-closed parser and binder. Tests for negation, ambiguous text, a bare `Approved`, a named affirmative list, wrong thread, wrong sender, and a stale proposal version.

Commit: `Reject negated, stale, and unbound refund approvals.`

### 4. Policy and grounding

Load all three clauses. Compute duplicate-charge and 30-day eligibility in code. Reject unknown citation ids. Render `customer_reply` as an unsent draft.

Commit: `Ground refund eligibility in code against all three policy clauses.`

### 5. Durable ledger and atomic execution

Inbox states, sequence checkpoint, ack only after a numbered domain event is queued. Crash, duplicate, disconnect, and gap tests. One transaction rechecks the approval and writes the execution, the proposal, and the finance or order row.

Commit: `Queue Switch events durably and execute approvals atomically.`

### 6. AI draft

One OpenAI-compatible chat call (OpenAI or Gemini). The filmed path is live. `LLM_MODE=scripted` is for tests only and is never the default for `npm start`.

Commit: `Draft the customer reply with a live model, scripted in tests.`

### 7. Ledger page

One read-only HTML page served by the agent on `127.0.0.1`. No token in the page. Shows the blocked attempt and its reason, then the simulated executions.

Commit: `Serve a loopback ledger page from the agent.`

### 8. README and demo script

`Run it on your machine` with copy-paste steps and a smoke checklist you can finish in under 30 minutes.

Commit: `Document how to run Refund Desk on a local Switch Console.`

## Cut line

If the real socket misbehaved on a live server, posting and the owner id came before any work on the page. I did not add a second agent, another chat app, tracing, or a hosted deploy, and I did not film scripted mode.

## What I cut

Full-text search, Langfuse, a Next.js board, a dashboard token, bootstrap-key registration, and posting at the channel root.
