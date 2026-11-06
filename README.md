# Refund Desk

A Switch room where a support agent and a human finish a refund ticket together. The agent looks up the order, cites the written policy, and drafts the customer reply. It does not send that reply, flag finance, or record a refund until the human approves in the same thread. The approval is checked in code, in the process that would perform the action.

**Author:** Rohit Raj ([rohhitrz](https://github.com/rohhitrz)), solo.
**Track:** [Best Business Workflow](https://www.wemakedevs.org/hackathons/switch) (Flip the Switch, deadline 7 Nov 2026, 11:59 PM IST).
**Status:** Phase 1 is research and design. Application code is not in this commit. The commands below are the interface the build will implement. Research and the reason this shape won are in [docs/HACKATHON_NOTES.md](docs/HACKATHON_NOTES.md) and [docs/PRD.md](docs/PRD.md).

## What it is

A shop agent named `refund-desk` joins a Mattermost channel through Switch. A human pastes a ticket. The agent answers in that thread with four things: a one-line restatement, a label, the policy clause it used, and a draft the customer has not been sent. The human replies `Approved, send the reply and flag finance.` The agent sends and flags those two actions only. `issue_refund` stays unexecuted unless the approval names it.

Without Switch the agent has no room to join, no thread to read, and no place for the approval to land. The local board is a view of the same ledger. It is not a second product.

## How Switch is used

1. Switch Console, with Docker, runs a local Switch server and a bundled Mattermost. No Slack workspace and no admin rights.
2. This repo's agent registers once with `POST /agents` and holds a WebSocket at `/agents/{id}/connection/ws`. SSE is the old transport and is not used. Console does not run this agent. Creating it again from Console's New Agent form makes the server refuse the socket (`managed_by_controller`).
3. A room on the Mattermost bridge contains the human and `refund-desk`. Room instructions are the briefing. Addressing stays `owner_only`, and the human's Mattermost account is linked to the Switch user, or the agent refuses the owner as a stranger.
4. The agent posts with the bridge (`post_message`, or `POST /agents/{id}/message`). The human approves by typing in the thread. Switch does not review tool calls. The gate that refuses `send_customer_reply`, `flag_finance`, and `issue_refund` lives in this process. See [Switch's shared-responsibility model](https://docs.switchagents.ai/switch-rooms/resources/shared-responsibility.md).

## Architecture

```
Mattermost channel
        │  (bundled, via the collaboration bridge)
        ▼
Switch server  ◄──── WebSocket events ────  refund-desk (Node)
        ▲                                    │  order lookup, policy search
        └──── HTTP post_message ─────────────┤  one structured draft
                                             │  approval gate
                                             ▼
                                        SQLite ledger
                                             ▲
                                             │  read-only HTTP
                                        Next.js board (127.0.0.1)
```

Detail, including failure modes: [docs/SYSTEM_DESIGN.md](docs/SYSTEM_DESIGN.md). HTTP and event contracts: [docs/API_DESIGN.md](docs/API_DESIGN.md). Tables: [docs/DATABASE_DESIGN.md](docs/DATABASE_DESIGN.md). Build order: [docs/BUILD_PLAN.md](docs/BUILD_PLAN.md).

## Setup

Prerequisites Rohit installs himself: Docker, Switch Console (macOS preferred; Windows and Linux are early access), Node.js 22, and optionally an OpenAI-compatible API key. A registration API key is created in the local Gateway after Console has started the server.

```bash
# once Switch is healthy and .env has SWITCH_BASE_URL, SWITCH_REGISTRATION_KEY,
# SWITCH_AGENT_KEY (filled by the register script), and optionally LLM_BASE_URL / LLM_API_KEY
npm install
npm run db:migrate
npm run db:seed
npm run agent:register   # once; prints the agent id and stores the key
npm run agent            # holds the WebSocket
npm run board            # http://127.0.0.1:3000  read-only
```

`LLM_MODE=scripted` (the default) drafts order `#4821` from a fixture, so a judge can reproduce the room without a model key. `LLM_MODE=live` calls the configured chat-completions endpoint. The gate tests do not call a model either way.

Create the room in Console on the bundled Mattermost bridge, add `refund-desk`, paste the room instructions from `docs/SYSTEM_DESIGN.md`, and link the Mattermost account. Phase 2 checks the Gateway click-path and the live `GET /agents/{id}/ops` schema before filming. Those two are the setup risks.

## Demo

Film the Mattermost channel, with the board visible for one cut. Target 90–120 seconds. The rules ask for a short video and do not set a length.

1. Human: `@refund-desk Order #4821 charged twice, customer wants a refund.`
2. Agent, in thread: restatement, label `refund`, duplicate-charge clause, customer draft, and the line `Pending approval: send_reply, flag_finance. issue_refund was not proposed.`
3. Human: `@refund-desk Approved, send the reply and flag finance.`
4. Agent: confirms those two actions and says the refund was not recorded.
5. Cut to the board: the two actions `executed`, `issue_refund` absent, the approval row storing the human's message id.

Say one sentence on the cut: the sign-off happened in the room, and the tool checked it.

A second, unfilmed check is in the test log: the same draft with no approval row returns `denied`, including when the ticket text says the customer already approved by email.

## Submission

| Field | Value |
| --- | --- |
| Project | Refund Desk |
| Track | Best Business Workflow |
| Team | Solo — Rohit Raj (rohhitrz) |
| Repo | https://github.com/rohhitrz/triage-room |
| Demo video | TODO — upload URL |
| Live link | Not required. Board is local. |
| Blog | TODO — skip unless a post is actually published |
| Wispr scorecard | TODO — skip unless the build was dictated |

## License

MIT, for the code this repo will contain. Switch, Mattermost, and model providers keep their own licenses.
