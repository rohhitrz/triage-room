# PRD — Refund Desk

## Decision

Keep the support-room hypothesis. Sharpen it into a refund desk with a tool-level approval gate. Do not ship the attached "label the ticket and draft a reply" loop as the product, and do not depend on `dukaan-agent`.

Why this is the winnable 24-hour project:

- Track 01 pays for a practical workflow a real team already does. Duplicate charges and "don't refund until a person says so" are that workflow. Track 02 (personal/creative) fits Rohit's stack less well. Track 03 pays $100 per PR, needs an assigned `hackathon` issue and a CLA, and loses if the issue is already taken. It is not the plan.
- Use of Switch is 30% of the published rubric. The agent is useless without the room: the approval is a message id in that room, and the actions are posted back into it.
- The event page's sample is already a triage pair that labels a report and hands a bug to a reproducer. A room that only restates and labels will look like that sample. The difference a judge can see in under two minutes is a refused action, then an allowed one, tied to a sentence the human typed.
- Technical execution is 25%. `LLM_MODE=scripted` plus gate tests let a judge clone the repo and run the workflow without an API key. A prompt-only Claude Code session does not.
- Rohit's stack (TypeScript, Next.js, tool calling, a small retrieval set, evals) covers the build. Python, FastAPI, pgvector, and Langfuse do not earn a place in the critical path. One language, one file database, one model call.

## Problem

Support work happens in a team channel. The decision to refund is a policy decision, and the act of telling the customer is hard to undo. A coding agent in a terminal can draft the reply. It cannot show a teammate the draft, and a sentence in its system prompt cannot stop it calling a refund tool. Switch will carry the conversation. It will not inspect the tool call. ([Shared responsibility](https://docs.switchagents.ai/switch-rooms/resources/shared-responsibility.md).)

## Users

| User | In this hackathon | What they need |
| --- | --- | --- |
| Support teammate | Rohit, playing the human in Mattermost | Paste a ticket, read a short draft in the thread, approve specific actions in that thread. |
| Support agent | `refund-desk` | Facts from the order book and the policy, a draft, and a hard stop. |
| Reviewer / judge | Clones the public repo | A README, a video, and a scripted path that reproduces the room. |
| Finance (off-screen) | Nobody | A ledger row that says they were flagged. No real payout. |

There is one human and one agent. A second agent doubles the protocol work and copies the sample template.

## Goals

- A human and `refund-desk` complete one refund ticket inside a Switch room on bundled Mattermost.
- The agent cites a clause from a written policy, not a general essay about refunds.
- `send_customer_reply` and `flag_finance` run only after an in-thread approval that names them, or after a bare `Approved` that accepts the proposed set.
- `issue_refund` does not run in the demo, and a test proves it returns `denied` when the approval did not name it.
- The board shows the ticket, the cited clause, the draft, the approval message id, and each action's outcome.
- The scripted path and the gate tests pass with no network.

## Non-goals

- A real payment processor, a real inbox, or a real ticketing product. `send_customer_reply` writes the reply into the ledger and posts a confirmation in the room. It does not email anyone.
- Slack, Teams, Discord, Telegram, interactive Mattermost buttons, Switch Trust, Switch ROI.
- A second agent, roles, cross-room handoff, or a task protocol (Switch removed the task tools).
- pgvector, a hosted vector database, Langfuse as a required service, multi-step tool calling by the model.
- A public deployment. A live URL is not a submission field. Tunneling the board is a stretch after the video is cut.
- Console-managed Claude Code / Codex as the worker. Those are fine for writing the code. They are the wrong runtime for the room agent, because the gate has to sit in our process.
- Using `dukaan-agent` as a library. Patterns can be copied into this repo during the build. A second repo is not a dependency.
- Wispr and the blog, unless Rohit actually dictates or publishes. They are not part of the build.

## User stories

1. As the teammate, I post `@refund-desk Order #4821 charged twice, customer wants a refund.` and get, in that thread, a restatement, the label `refund`, the duplicate-charge clause, a customer draft, and an explicit list of actions waiting for approval.
2. As the teammate, I reply `@refund-desk Approved, send the reply and flag finance.` and the agent confirms those two actions and no others.
3. As the teammate, I say `looks good` and the agent asks for the word `Approved` plus the actions. Nothing is sent.
4. As the teammate, I paste a ticket whose text claims the customer already approved by email. The agent still waits. The refund tool stays denied.
5. As the teammate, I post order `#1008` (outside the 30-day window). The agent drafts a polite refusal and proposes no refund.
6. As a judge, I run the seed, the agent, and the board against my own Console and see the same ledger the room wrote.

## Demo ticket

Order `#4821`, customer charged twice, within the refund window, status paid. The policy says refund the duplicate only, tell the customer, and flag finance. The proposed actions are `send_reply` and `flag_finance`. `issue_refund` is a stronger action the demo does not approve, so the video can show a line that was not taken.

Two extra seed orders exist so the eval is not a single fixture: `#1008` is too old, `#2204` was charged once and is a shipping question rather than a refund.

## Scope for the build

In, in this order (see [BUILD_PLAN.md](BUILD_PLAN.md)):

1. SQLite ledger, seed orders, seed policy.
2. Retrieval and the three gated tools, with tests, before any Switch socket.
3. A protocol client that registers, stays connected, and posts.
4. One orchestrator: parse the order id, load facts, one structured draft, post a composed reply (never the raw model text).
5. Approval parsing and execution of only the approved names.
6. A read-only Next.js board.
7. README demo section filled with the real commands, and a room-instructions file taken from a room that actually exists.

Out if the socket slips: the board shrinks to one server-rendered page, live LLM mode is skipped, and the video uses scripted mode. The gate tests and the Mattermost thread stay. Those two are the submission.

## Success metrics

Measured before submit, not as a dashboard vanity number:

| Check | Pass |
| --- | --- |
| Room | `refund-desk` replies in the Mattermost thread to the `#4821` prompt. |
| Gate | Approving `send_reply` and `flag_finance` leaves `issue_refund` unexecuted. A missing approval denies all three. |
| Repro | `npm test` passes with no API key and no Switch. The scripted room path is written down well enough that Rohit can reset and re-film. |
| Presentation | Video under two minutes shows the channel and one cut of the board. README states the Switch steps. |
| Switch-shaped | Stopping the agent process stops the replies. The board alone cannot approve anything. |

## Risks

| Risk | Why it matters | Response |
| --- | --- | --- |
| Protocol client takes the day | 30% of the score is Switch, and the socket has no library. | Build the echo-and-post client before the draft. If it fails, the submission is not a standalone web app. |
| Console claims the agent | `managed_by_controller` closes the socket. | Register only via `POST /agents`. Do not also create a Console agent with that name. First hour proves the socket survives. |
| Account not linked | Owner-only agent ignores the human. | Linking Mattermost is a setup step in the README, before any prompt tuning. |
| Model claims it refunded | A judge reads the transcript and the tool did something else, or the model skips the wait. | Chat text is composed by our code from structured fields. Side effects happen only in the gate. |
| Sample-shaped project | Creativity is 25%. | The filmed difference is the refused refund, not the label. |
| Windows/Linux Console rough edges | Early access. | Prefer macOS. Budget time for Docker and the first room, not for a second chat app. |
| Prize pages disagree | Submitting to the wrong mental model. | Enter Track 01 against the WeMakeDevs page. Re-read both pages on submit day. |
| Age or affiliation | Rules can void the prize after the work. | Rohit confirms he is 18+ and not with the Sponsor, judges, or their households. |

## Open questions

Carried in the phase-1 report. None of them change the shape above. The one that can change setup steps is the Gateway click-path for a registration key on a Console-bundled server, which phase 2 checks before writing the client against a guess.
