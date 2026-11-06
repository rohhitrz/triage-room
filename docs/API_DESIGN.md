# API design — Refund Desk

Two surfaces. Switch's agent protocol is defined by Switch; the shapes below quote the current docs and mark the one field phase 2 must read live. The board API is ours. Nothing on the board API can approve, send, or refund.

## Auth

| Caller | Credential | Where |
| --- | --- | --- |
| Registration | Gateway key of type `registration`, or the deployment bootstrap key | `Authorization: Bearer` on `POST /agents` only. Rejected everywhere else. |
| Agent calls and the WebSocket | Agent API key returned once from registration | `Authorization: Bearer`. |
| Operation that depends on a room | Same agent key, plus `X-Switch-Connection-Id: {uuid}` | Header. A missing or dead id is 409. |
| Board → agent | Optional `DASHBOARD_TOKEN` | `Authorization: Bearer`. If the env var is unset, accept only connections from loopback. |
| Model provider | `LLM_API_KEY` | `Authorization: Bearer` on the outbound chat call. Never logged. |

The board has no session and no write token. Binding is `127.0.0.1`.

## Switch: registration and settings

### `GET /health`

No auth. 200 means this base URL is the bridge. 401 means the host answered and the path is wrong.

### `POST /agents`

Bearer: registration key.

Request:

| Field | Required | Value here |
| --- | --- | --- |
| `name` | yes | `refund-desk` |
| `description` | yes | One line, see system design. |
| `connector_type` | yes | `refund-desk` |
| `integration_profile.connection_model` | yes | `always_on` |
| `integration_profile.message_exchange` | yes | `true` |
| `integration_profile.pre_invocation_mediation` | yes | `[]` |
| `integration_profile.post_invocation_mediation` | yes | `[]` |
| `integration_profile.event_reporting` | yes | `[]` |
| `overwrite` | no | Omit. Never send `true` from the running agent. |

Response `200`: `{ "id": string, "api_key": string }`. Persist both. The secret is not retrievable later.

Errors: `409` name taken (or name owned by someone else). `401` wrong key type.

### `POST /agents/{agent_id}/ops/update_agent_detail`

Bearer: agent key. No connection required.

```json
{ "agent_id": "agt_…", "addressing": "owner_only" }
```

`addressing`: `owner_only` | `owner_and_owner_agents` | `anyone`. We send `owner_only`.

Response `200`: `{ "result": { } }` with whatever the operation returns. Treat a 200 as success. A 400 means the live signature did not match; dump `GET /ops` and fix the client.

### `GET /agents/{agent_id}/ops`

Bearer: agent key.

Response `200`:

```json
{
  "operations": {
    "post_message": { "description": "string", "input_schema": {} }
  }
}
```

The client loads this at startup and fails if `post_message` or `read_context` is missing. It does not ship a hand-copied schema as the authority.

## Switch: WebSocket

`GET /agents/{agent_id}/connection/ws?connection_id={uuid}&rooms={roomId}&scope=single&filter=all&start_from=head&expected_generation={n}&client=refund-desk&client_version=0.1.0`

Upgrade. Bearer agent key. No subprotocol.

Query we rely on:

| Param | Use |
| --- | --- |
| `connection_id` | Required. Stable UUID in `.env` after first run. |
| `rooms` | The one room. Takeover on open. |
| `scope` | `single`. |
| `filter` | `all`, so a non-addressed message is visible for the log and still ignored for action. |
| `start_from` | `head` on first connect, else last sequence. |
| `expected_generation` | Omit on first connect. Send on resume. |

Close codes we handle: `4401` bad key, `4400` bad query, `4403` room cannot be served, `4409` taken over / protocol mismatch / `managed_by_controller` / too many connections. A `refused` frame can precede the close, except for `4401`.

### Frames the client must handle

Domain envelope:

```json
{
  "event": "message",
  "id": 4813,
  "data": {
    "type": "message",
    "room_id": "room_…",
    "bridge_id": "bridge_…",
    "channel_type": "channel_public",
    "sequence": 4813,
    "payload": {
      "addressed": true,
      "sender": "opaque",
      "sender_name": "Rohit",
      "message_id": "msg_…",
      "body": "@refund-desk Order #4821 charged twice, customer wants a refund.",
      "timestamp": 1762420000000,
      "thread_id": "thread_…",
      "attachments": []
    }
  }
}
```

`id` and `sequence` are the same number. The cursor is this per-agent sequence, not the room `seq`.

| Frame | Client behavior |
| --- | --- |
| `connection_state` | Store `generation`, `rooms`, `cursor`, `heartbeat_interval_seconds`. Do not assume they echo the query. |
| `ping` | Immediately send `{"type":"pong","cursor":N}`. This is the only frame we send. |
| `message` | If `payload.addressed`, enqueue. Always advance the cursor after persist. |
| `gap` | Set cursor to `resumed_at`. Call `read_context` before the next draft. |
| `evicted` | `taken_over`: exit. `heartbeat_lapsed` and the recoverable codes: reopen. `closed`: log `reason`, exit. |
| `refused` | Log `status` and `detail`, exit. |
| `command`, `room_join`, `subscription_changed`, `room_released` | Advance past them. Do not draft. |

### `POST /agents/{agent_id}/ops/post_message`

Bearer agent key. `X-Switch-Connection-Id`. Body is the arguments object.

Documented today: the operation exists in the messaging group. The no-connection shortcut is specified as:

### `POST /agents/{agent_id}/message`

```json
{ "room_id": "room_…", "content": "string" }
```

Response `200` with the bridge's message body. This shortcut has no thread field in the docs. Phase 2 uses it only if `post_message`'s live `input_schema` has no thread argument. If the schema has a thread field (expected name `thread_id`, to be confirmed, not assumed), the client sends that and does not use the shortcut.

### `POST /agents/{agent_id}/ops/read_context`

Called after a gap and on first claim if the open did not include room context. Arguments from the live schema. The handler needs enough of the recent thread to see the ticket. If the schema is awkward, the ledger already has the messages we persisted, and `read_context` is only to fill a gap.

### Operation errors

| Status | Meaning | Client |
| --- | --- | --- |
| 400 | Bad or unexpected arguments | Fix the payload. Do not retry blindly. |
| 403 | Owner access or addressing | Stop and log. Usually a setup mistake. |
| 404 | Unknown operation | Exit. The server is not the version we read. |
| 409 | Unknown or dead connection | Reopen the socket, then retry the post once. |

## Internal HTTP

Base: `http://127.0.0.1:8787`. JSON only. Errors:

```json
{ "error": { "code": "not_found", "message": "No ticket with that id." } }
```

| Status | `code` |
| --- | --- |
| 400 | `bad_request` |
| 401 | `unauthorized` |
| 404 | `not_found` |
| 409 | `conflict` |
| 500 | `internal` |

### `GET /health`

```json
{ "ok": true, "switch": "connected", "mode": "scripted" }
```

`switch` is `connected` | `connecting` | `stopped`. Used by the human, not by Switch.

### `GET /api/tickets`

```json
{
  "tickets": [
    {
      "id": "tkt_01",
      "order_id": "4821",
      "label": "refund",
      "status": "awaiting_approval",
      "summary": "Order 4821 was charged twice and is inside the 30-day window.",
      "created_at": "2026-11-07T10:00:00.000Z"
    }
  ]
}
```

`status`: `triaged` | `awaiting_approval` | `partially_executed` | `closed`.

### `GET /api/tickets/:id`

```json
{
  "ticket": {
    "id": "tkt_01",
    "room_id": "room_…",
    "thread_id": "thread_…",
    "source_message_id": "msg_…",
    "order_id": "4821",
    "label": "refund",
    "status": "partially_executed",
    "summary": "…",
    "created_at": "2026-11-07T10:00:00.000Z"
  },
  "order": {
    "id": "4821",
    "customer_name": "Asha Menon",
    "email": "asha@example.com",
    "amount_inr": 1299,
    "charge_count": 2,
    "status": "paid",
    "placed_on": "2026-11-04"
  },
  "draft": {
    "customer_reply": "…",
    "internal_note": "…",
    "eligibility": "eligible",
    "cited_chunks": [{ "id": "duplicate-charge", "heading": "Duplicate charge" }]
  },
  "proposals": [
    { "action": "send_reply", "status": "executed" },
    { "action": "flag_finance", "status": "executed" }
  ],
  "approvals": [
    {
      "id": "apr_01",
      "message_id": "msg_ok",
      "sender_id": "opaque",
      "verbatim": "Approved, send the reply and flag finance.",
      "actions": ["send_reply", "flag_finance"],
      "created_at": "2026-11-07T10:01:00.000Z"
    }
  ],
  "actions": [
    {
      "action": "send_reply",
      "outcome": "executed",
      "reason": "approval apr_01",
      "created_at": "2026-11-07T10:01:01.000Z"
    }
  ],
  "messages": [
    {
      "message_id": "msg_…",
      "sender_name": "Rohit",
      "body": "…",
      "created_at": "2026-11-07T10:00:00.000Z"
    }
  ]
}
```

`order` is `null` when the ticket had no id yet. `draft` is `null` before a successful model or fixture call.

### `GET /api/audit?ticket_id=&outcome=`

`outcome` filters action rows: `executed` | `denied`. Omit for both, plus the non-action audit kinds.

```json
{
  "events": [
    {
      "id": 4,
      "ticket_id": "tkt_01",
      "kind": "action_denied",
      "payload": { "action": "issue_refund", "reason": "approval did not name issue_refund" },
      "created_at": "2026-11-07T10:02:00.000Z"
    }
  ]
}
```

### Routes that do not exist

- No `POST /api/approvals`.
- No `POST /api/tickets`. Tickets are created from room events.
- No `POST /api/actions`.
- A dev inject route is not part of the server. Tests call the gate functions in-process.

## Approval parser

Input: message body, ticket's pending proposal names.

Output: `{ "actions": ["send_reply", "flag_finance"] }` or a miss.

Rules, in order:

1. Take the first non-empty line, strip a leading `@refund-desk` mention.
2. If it does not match `/^approved\b/i`, miss.
3. Scan the whole body for the tokens `send_reply`, `flag_finance`, `issue_refund`, and for the phrases `send the reply`, `flag finance`, `issue the refund`.
4. If at least one token or phrase hits, the set is those hits, mapped to the three names.
5. If none hit, the set is the pending proposals.
6. Intersect with the pending proposals. An approval cannot create a proposal that was not made. Asking for `issue_refund` when it was not proposed is a miss with reason `not_proposed`, and the agent posts that. It does not insert a denied execution unless a test calls the tool directly.

`Approved, send the reply and flag finance.` on the demo ticket yields `send_reply` and `flag_finance`.

## Model request

Only when `LLM_MODE=live`.

`POST {LLM_BASE_URL}/chat/completions`

```json
{
  "model": "gpt-4o-mini",
  "temperature": 0,
  "messages": [
    { "role": "system", "content": "Return one JSON object. Do not claim an action was taken." },
    { "role": "user", "content": "{order, chunks, ticket text}" }
  ]
}
```

The system string is fixed in code. The user string is data. Timeout 20s. We do not send room history beyond the single ticket body, the order row, and the chunks.

Scripted mode does not make this call. Fixtures live next to the tests, keyed by order id.

## Idempotency and errors inside the agent

| Situation | Result |
| --- | --- |
| Same Switch `message_id` again | `409` internally, no second ticket, no second approval. |
| Tool without a matching approval | Action row `denied`, function returns `{ outcome: "denied", reason }`. |
| Tool with an approval for a different action | Denied for the unnamed action. The named one still runs. |
| Tool when that proposal is already `executed` | Return the existing row. No second ledger line. |
