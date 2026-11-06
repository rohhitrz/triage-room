# API design — Refund Desk

## Auth

| Call | Credential |
| --- | --- |
| `POST /agents` | `SWITCH_REGISTRATION_KEY` only. The register script exits if `SWITCH_KEY_KIND=bootstrap` or if the value equals `SWITCH_BOOTSTRAP_KEY`. |
| Socket and operations | Agent API key from registration. |
| Room operations | `X-Switch-Connection-Id` as well. |
| Ledger page | None. The listener is `127.0.0.1`. The HTML and the JSON contain no bearer token. |

## Registration

`POST {SWITCH_BASE_URL}/agents`

```json
{
  "name": "refund-desk",
  "description": "Drafts a refund reply and executes simulated actions only after a fail-closed in-thread approval.",
  "connector_type": "refund-desk",
  "integration_profile": {
    "connection_model": "always_on",
    "message_exchange": true,
    "pre_invocation_mediation": [],
    "post_invocation_mediation": [],
    "event_reporting": []
  }
}
```

Response `200`: `{ "id", "api_key" }`. Stored in gitignored `data/agent.json`. `409` means the name exists; keep the saved key.

`POST /agents/{id}/ops/update_agent_detail`

```json
{ "agent_id": "<id>", "addressing": "owner_only" }
```

## Discovery

On startup, and from `npm run discover`:

- `GET /health`
- `GET /agents/{id}/ops` when the agent key exists

Write `data/switch-discovery.json`:

```json
{
  "base_url": "http://127.0.0.1:8000",
  "fetched_at": "2026-11-07T00:00:00.000Z",
  "health_status": 200,
  "health_body": {},
  "server_version": null,
  "console_version": null,
  "post_message_schema": {}
}
```

`server_version` is taken from the health body when a version field is present (`version`, `server_version`, or `switch_version`). `console_version` is `SWITCH_CONSOLE_VERSION` from the environment, because Console does not report itself on the bridge. Rohit copies both into the smoke notes. This environment cannot fill them in.

`docs/switch-ops.expected.json` is the argument object this client sends. The live `post_message.input_schema` must mention `thread_id` (in `properties` or in the raw schema text). If it does not, the process exits. It does not call `POST /agents/{id}/message`.

## WebSocket

`GET /agents/{id}/connection/ws?connection_id={uuid}&rooms={roomId}&scope=single&filter=all&start_from={checkpoint}&client=refund-desk&client_version=0.1.0`

Resume adds `expected_generation`.

| Frame | Effect on checkpoint | Work |
| --- | --- | --- |
| `connection_state` | None | Store `generation`. Then `read_context`. |
| `ping` | None | Pong the committed checkpoint. |
| Domain event with numeric `id` | Advance to that id after the inbox insert commits | Worker runs after the ack point. |
| `gap` | None | `read_context`. |
| `evicted` `taken_over` | None | Exit. |
| `evicted` recoverable | None | Reconnect from the checkpoint. |

`read_context` and `post_message` are `POST /agents/{id}/ops/{name}` with the agent key, the connection header, and an unwrapped body.

`post_message` body:

```json
{
  "room_id": "room_…",
  "content": "string",
  "thread_id": "thread_…"
}
```

`thread_id` is required. A missing value is a local error, not a root post.

`read_context` body:

```json
{ "room_id": "room_…", "limit": 50 }
```

If the live schema rejects `limit`, retry once with `{ "room_id" }` only and record that in the discovery file.

## Approval grammar

Strip one leading `@refund-desk`. Trim. Reject the whole message if the body contains `?` or a negation word: `don't`, `dont`, `do not`, `never`, `cannot`, `can't`, `except`, `without`, `unless`, `however`, `not`, `no`, `but`.

| Input | Result |
| --- | --- |
| `Approved` | Bare. Actions are the exact pending set at the current version. |
| `Approved, send the reply and flag finance.` | Exactly `send_reply` and `flag_finance`. |
| `Approved, send_reply, flag_finance` | Same. |
| `Approved, don't issue the refund` | Reject `negation`. |
| `Approved, send the reply?` | Reject `ambiguous`. |
| `looks good` | Reject `not_approval`. |
| `Approved, send the reply and wire the money` | Reject `ambiguous`. Nothing executes. |

Named phrases, whole clauses only: `send the reply`, `flag finance`, `issue the refund`, or the three snake names. Joined by commas and `and`.

Binder, after a successful parse:

| Check | Rejection code |
| --- | --- |
| `SWITCH_OWNER_PARTICIPANT_ID` unset | `owner_not_configured` |
| `sender_id` differs | `wrong_sender` |
| `thread_id` null or different from the ticket | `wrong_thread` |
| Named action is not pending | `not_proposed` |
| Approval's `proposal_version` differs, or `invalidated_at` is set | `stale_approval` |

A rejection writes `audit_events` and does not write `approvals` or `actions`.

## Execution transaction

```text
BEGIN
  reload approval, ticket, proposals
  fail the transaction if version, sender, thread, or pending set does not match
  INSERT actions (outcome=executed, simulated=1, reason=<simulated label>)
  UPDATE proposals SET status='executed'
  UPDATE tickets.finance_note when flag_finance is in the set
  UPDATE orders.status='refund_recorded' when issue_refund is in the set
COMMIT
```

The follow-up chat message is a SELECT of those rows. Pending proposals are listed as pending, not as refused.

## Model

`LLM_MODE=live` is the process default.

| `LLM_PROVIDER` | URL | Default model |
| --- | --- | --- |
| `openai` | `{LLM_BASE_URL}/chat/completions`, default base `https://api.openai.com/v1` | `gpt-4o-mini` |
| `gemini` | default `https://generativelanguage.googleapis.com/v1beta/openai/chat/completions` | `gemini-2.5-flash` |

Bearer `LLM_API_KEY`. Temperature 0. Timeout 20s. Response JSON: `customer_reply`, `internal_note`, `cited_chunk_ids`. Extra fields are ignored. `LLM_MODE=scripted` returns fixtures and does not call the network. `npm start` refuses `scripted`.

## Local HTTP

`GET /` HTML. `GET /api/ledger` JSON. Both on `127.0.0.1:8787`. No other routes. No POST.
