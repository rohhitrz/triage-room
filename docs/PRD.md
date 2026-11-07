# PRD — Refund Desk

## Decision

I'm entering Refund Desk in Track 01, Best Business Workflow.

A human and one agent finish a duplicate-charge ticket in a Switch room. The model writes the customer wording. Code decides eligibility from the order and all three policy clauses. Nothing is sent, flagged, or recorded as a refund until a fail-closed approval in that thread binds the owner, the proposal version, and the exact actions. The filmed demo uses a real model. A local HTML page shows the ledger, including a blocked attempt.

## Problem

A refund is easy to promise and hard to undo. Switch will carry the conversation between the teammate and the agent. It will not inspect the tool call. The control has to sit in the process that would perform the action, and it has to fail closed when the sentence is sloppy.

## Users

| User | Who they are here | What they need |
| --- | --- | --- |
| Support teammate | Me, the room owner, in Mattermost | A short unsent draft, a clear pending list, and a way to approve exact actions. |
| Agent | `refund-desk` | The order, all three clauses, one model draft, and a gate it cannot talk its way around. |
| Judge | Clones the repo, watches the video | A real model in the video, tests that pass without Switch, and a README that reaches a room on their own Console. |

One human, one agent.

## Goals

- The filmed ticket is drafted by a live OpenAI-compatible model (OpenAI or Gemini).
- Eligibility and the proposed action set come from code, using the order row and all three clauses.
- The customer reply is shown as an unsent draft until a ledger row says a simulated send happened.
- A blocked approval is visible in the audit log, with a reason, before the authorized actions run.
- `Approved, don't send the reply` executes nothing.
- A valid approval names the owner, a non-null thread, the current proposal version, and the exact actions. A new draft invalidates it.
- Simulated send, finance flag, and refund record are labeled as simulated. No email, no finance system, no payment.
- `npm test` covers the gate, grounding, and durability without a model key and without Switch.

## Non-goals

- Real email, real finance, real card refunds.
- Full-text search, pgvector, Langfuse, a second process, Next.js.
- Bootstrap-key registration. That key's owner is a dedicated account, not me, so owner-only approval would not bind to my account.
- Channel-root posts, Mattermost buttons, Slack, Switch Trust.
- Scripted wording in the demo video. Scripted mode is for tests and CI.
- A browser token. The page is loopback-only.

## Demo story

Order `#4821` is a duplicate charge inside the 30-day window. Code proposes `send_reply`, `flag_finance`, and `issue_refund`. Absence of a proposal is not how I show a refusal. The film shows a real blocked request, then the actions that were authorized.

1. `@refund-desk Order #4821 charged twice, customer wants a refund.`
2. Agent posts the unsent draft, the code's eligibility, the clauses it used, and proposal version 1. Nothing is executed.
3. `@refund-desk Approved, don't issue the refund.` Agent posts that the approval was blocked because it contains a negation. The audit row carries that reason. Every proposal stays pending.
4. `@refund-desk Approved, send the reply and flag finance.` Agent posts only what the ledger committed: simulated send, simulated finance flag, `issue_refund` still pending. Pending is not a refusal.

## Stories the tests pin

- Negation, a question mark, or leftover words do not approve.
- A bare `Approved` binds the exact pending set at the current version.
- Wrong thread, null thread, or a sender who is not the configured owner does not approve.
- After the draft changes, the old approval does not execute.
- A crash after the event is queued still leads to one execution. A duplicate delivery does not create a second one. A gap keeps the receipt cursor and sets the stream cursor to `resumed_at`.
- An unknown citation id is rejected and is not shown as policy.

## Success metrics

| Check | Pass |
| --- | --- |
| Room | Live model draft appears in the Mattermost thread for `#4821`. |
| Block | The negation produces an audit reason and no executed row. |
| Allow | Send and finance flag execute only after the affirmative approval, and the chat text matches the ledger. |
| Tests | `npm test` passes with no network. |
| Machine | Someone new can follow the README and see a real reply in under 30 minutes, assuming Docker is already installed. |

## Risks

| Risk | Response |
| --- | --- |
| Live `post_message` schema has no thread field | The client refuses to post and records the discovered schema. There is no fallback to the channel root. |
| Owner participant id is unknown until the first message | Approvals fail closed until `SWITCH_OWNER_PARTICIPANT_ID` is set from that sender id. |
| Model timeout during filming | Post the ticket again. The agent does not substitute the scripted fixture. |
| Console early access on Linux | Prefer macOS. The fake server proves the client; the README's smoke checklist proves the real server. |
