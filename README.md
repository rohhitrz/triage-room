# Refund Desk

A Switch room where a support agent and a human finish a refund ticket together. A live model writes the customer wording. Code decides eligibility from the order and all three policy clauses. Send, finance flag, and refund record stay simulated, and they run only after a fail-closed approval in the same thread.

**Author:** Rohit Raj ([rohhitrz](https://github.com/rohhitrz)), solo.
**Track:** [Best Business Workflow](https://www.wemakedevs.org/hackathons/switch) (Flip the Switch, deadline 7 Nov 2026, 11:59 PM IST).
**Status:** Phase 1 is research and design. Application code is not in this commit. The commands below are the interface the build will implement. Research and the reason this shape won are in [docs/HACKATHON_NOTES.md](docs/HACKATHON_NOTES.md) and [docs/PRD.md](docs/PRD.md).

## What it is

A shop agent named `refund-desk` joins a Mattermost channel through Switch. A human pastes a ticket. The agent answers in that thread with an unsent draft. `Approved, don't issue the refund` is blocked and audited. `Approved, send the reply and flag finance` runs those two simulated actions. `issue_refund` stays pending, which is not a refusal.

Without Switch the agent has no room to join and no thread to bind the approval to. The loopback page is a view of the same ledger.

## How Switch is used

1. Switch Console, with Docker, runs a local Switch server and a bundled Mattermost. No Slack workspace and no admin rights.
2. This repo's agent registers once with `POST /agents` and holds a WebSocket at `/agents/{id}/connection/ws`. SSE is the old transport and is not used. Console does not run this agent. Creating it again from Console's New Agent form makes the server refuse the socket (`managed_by_controller`).
3. A room on the Mattermost bridge contains the human and `refund-desk`. Room instructions are the briefing. Addressing stays `owner_only`, and the human's Mattermost account is linked to the Switch user, or the agent refuses the owner as a stranger.
4. The agent posts with `post_message` and a thread id. It does not post at the channel root. Registration uses Rohit's registration key, not the deployment bootstrap key. Switch does not review tool calls. The gate lives in this process. See [Switch's shared-responsibility model](https://docs.switchagents.ai/switch-rooms/resources/shared-responsibility.md).

## Architecture

```
Mattermost channel
        │
        ▼
Switch server  ◄──── WebSocket (room claimed on open) ────  refund-desk (Node)
        ▲                                                  │  all 3 clauses, eligibility in code
        └──── post_message in thread ──────────────────────┤  one live model draft
                                                           │  fail-closed approval
                                                           ▼
                                                      SQLite ledger
                                                           │
                                                      HTML on 127.0.0.1
```

[docs/SYSTEM_DESIGN.md](docs/SYSTEM_DESIGN.md), [docs/API_DESIGN.md](docs/API_DESIGN.md), [docs/DATABASE_DESIGN.md](docs/DATABASE_DESIGN.md), [docs/BUILD_PLAN.md](docs/BUILD_PLAN.md).

## Setup

Prerequisites Rohit installs himself: Docker, Switch Console (macOS preferred; Windows and Linux are early access), Node.js 22, and optionally an OpenAI-compatible API key. A registration API key is created in the local Gateway after Console has started the server.

```bash
npm install
npm test
npm run db:migrate
npm run register    # registration key only; writes data/agent.json
npm start           # socket, live draft, ledger at http://127.0.0.1:8787
```

`npm start` drafts with a live model (`LLM_PROVIDER=openai` or `gemini`). `LLM_MODE=scripted` is for `npm test` only. The agent will not start in scripted mode, and a model failure does not substitute the fixture.

Create the room in Console on the bundled Mattermost bridge, add `refund-desk`, paste the room instructions from `docs/SYSTEM_DESIGN.md`, and link the Mattermost account. Phase 2 checks the Gateway click-path and the live `GET /agents/{id}/ops` schema before filming. Those two are the setup risks.

## Demo

Film the Mattermost channel, with the board visible for one cut. Target 90–120 seconds. The rules ask for a short video and do not set a length.

1. Human: `@refund-desk Order #4821 charged twice, customer wants a refund.`
2. Agent, in thread: unsent draft from the live model, eligibility from code, proposal version, and pending `send_reply`, `flag_finance`, `issue_refund`.
3. Human: `@refund-desk Approved, don't issue the refund.` Agent blocks it. The ledger page shows the negation reason. Nothing is executed.
4. Human: `@refund-desk Approved, send the reply and flag finance.` Agent reports the two simulated ledger rows. `issue_refund` stays pending.
5. Cut to `http://127.0.0.1:8787`: the blocked reason, then the simulated send and finance flag.

Say one sentence on the cut: the sign-off happened in the room, and the tool checked it.

`npm test` covers negation, the wrong thread, the wrong sender, a stale proposal version, a crash after queue, and a gap that does not move the checkpoint. The customer saying they already approved by email is ticket text, not an approval.

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
