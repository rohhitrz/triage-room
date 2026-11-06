# Build plan — Refund Desk

Phase 2 only. Do not start it until the design review says to. No application code is in the phase-1 branch.

The deadline is 7 Nov 2026, 11:59 PM IST. The budget below is 14 hours of building and 3 hours to reset the room, film, and submit. That fits a start at or before 07:00 IST on Saturday, and it fits Friday night with sleep in between. It does not fit a Saturday afternoon start. If the start slips, apply the cut line before adding anything.

Each stage ends in one commit on the build branch. Push after the tests for that stage pass, not after every typo.

## Before stage 1 (Rohit, not a commit)

These block the socket and are not automatable from this environment.

- Install Docker. Install Switch Console. macOS is the stable build. Windows and Linux are early access.
- Console → run a server on this computer. Wait until Mattermost shows under Messaging apps. Copy Sign-in details, log in, and link that account ("This is me").
- In the Gateway, create an API key of type `registration`. Put it in `.env` as `SWITCH_REGISTRATION_KEY`. Put the bridge base URL in `SWITCH_BASE_URL`.
- Confirm `GET /health` on that URL returns 200.
- Star https://github.com/sandbox-quantum/switch if he wants the keyboard draw. Register on the hackathon form if he has not.

If the registration key has no obvious page on the bundled server, that is the first thing to ask in the WeMakeDevs Discord. Do not invent a second registration path.

## Stages

### Stage 1 — Ledger (1.5h)

`db/migrations/001_init.sql`, migrator, seed, `.env.example`, package with `better-sqlite3` and a test runner. `npm run db:migrate && npm run db:seed` then a test that `#4821` is inside the window and `#1008` is not, with today frozen at `2026-11-06`.

Commit: `Add the refund ledger, migrations, and seed orders.`

### Stage 2 — Gate (2.5h)

Order lookup, FTS search, approval parser, and the three tools. Tests, no network, no Switch:

- no approval → all three `denied`
- approval naming send and flag does not execute `issue_refund`
- `looks good` parses as a miss
- ticket text containing "the customer approved by email" does not insert an approval
- same `message_id` twice does not double-execute
- cited chunk ids outside the table are dropped

Commit: `Refuse sends and refunds unless the thread approval names them.`

### Stage 3 — Socket (3.5h)

The long pole. Against the local server:

- register once, refuse to overwrite
- set `owner_only`
- connect, answer pings for five minutes without `heartbeat_lapsed`
- dump `GET /agents/{id}/ops` to `docs/switch-ops.snapshot.json` and implement `post_message` from that schema, including the thread field if it exists
- create the room in Console, invite only this agent, post `pong` when addressed

If the close code is `managed_by_controller`, stop and fix registration. Do not start the orchestrator on top of a dead socket.

Commit: `Join the Switch room over the agent WebSocket.`

### Stage 4 — Ticket loop (2.5h)

Wire stage 2 to stage 3. Scripted drafts for the three seed orders. Composed posts, not raw model text. Live mode behind `LLM_MODE=live`, one call, fail closed. Manual check in Mattermost of the demo script's four messages.

Commit: `Draft the ticket in-thread and execute only approved actions.`

### Stage 5 — Board (2.0h)

Next.js, read-only, `127.0.0.1:3000`. Ticket list, ticket detail (draft, clause, approval verbatim, actions), audit filter for `denied`. No write UI.

Commit: `Show the ticket ledger and the denied refund on a local board.`

### Stage 6 — Submission copy (1.5h)

Replace the README setup with the commands that just worked, including the real port. Add `DEMO.md` only if the steps no longer fit the README. Room instructions committed as `room/instructions.md` (the text already in the system design, adjusted to whatever the room actually did). Fill the video placeholder still as TODO. `npm test` green.

Commit: `Document the working room setup and the demo script.`

## Cut line

Apply in order, as soon as stage 3 has slipped past 4 hours or the clock is past 18:00 IST Saturday with stage 4 unfinished.

1. Drop live LLM. Ship scripted only.
2. Replace the Next board with one HTML page served by the agent on `127.0.0.1:8787`. Same read-only JSON.
3. Drop FTS and match policy chunks with a keyword list. Keep the citation test.
4. Do not drop the gate tests, the WebSocket, or the Mattermost thread. A board without a room is not a submission.

Do not add, even if a stage finishes early: a second agent, Slack, buttons, Switch Trust, pgvector, Langfuse-required tracing, a public deploy, a Track 03 pull request, a blog, Wispr.

## After the last commit (3h, Rohit)

- Reset the room to a clean thread. Run the demo once without recording. Then record 90–120 seconds: channel, agent reply, approval, confirmation, one cut of the board showing `issue_refund` not executed.
- README: repo URL, video URL.
- Submit the public repo, the video, and the README on https://www.wemakedevs.org/hackathons/switch before 11:59 PM IST.
- Re-read the prize section that day. WeMakeDevs and DevTools Academy still disagree on counts.

## Commit map

| Stage | Commit message |
| --- | --- |
| 1 | Add the refund ledger, migrations, and seed orders. |
| 2 | Refuse sends and refunds unless the thread approval names them. |
| 3 | Join the Switch room over the agent WebSocket. |
| 4 | Draft the ticket in-thread and execute only approved actions. |
| 5 | Show the ticket ledger and the denied refund on a local board. |
| 6 | Document the working room setup and the demo script. |

Phase 1's commits stay on this docs branch and are not part of that map.
