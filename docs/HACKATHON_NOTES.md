# Flip the Switch — my research notes

I collected these on 6 Nov 2026, about 16:00 IST, before building. Primary event page is WeMakeDevs. DevTools Academy is a co-host and disagrees on some prize counts; both are cited. Switch behavior below is from the current docs at docs.switchagents.ai, which say to prefer the docs over the GitHub tree for released behavior.

## Eligibility verdict

**A solo entrant from India is eligible.** Nothing in the published rules excludes it. Age and affiliation are personal conditions every entrant confirms for themselves.

| Check | Result | Source |
| --- | --- | --- |
| Geography | India is not on the comprehensive-sanctions list (Cuba, Iran, North Korea, Syria, and the Crimea, Donetsk, Luhansk, Zaporizhzhia, and Kherson regions of Ukraine). | [Rules §1–2](https://www.wemakedevs.org/hackathons/switch/rules) |
| Age | Must be at least 18, or the age of majority where you live, whichever is greater. In India that floor is 18. | [Rules §1](https://www.wemakedevs.org/hackathons/switch/rules), [DevTools Academy FAQ](https://www.devtoolsacademy.com/hackathons/flip-the-switch) |
| Team size | Solo, or a team of up to 4. Solo is explicitly allowed. | [Event page](https://www.wemakedevs.org/hackathons/switch) |
| Affiliation | Employees, officers, directors, and contractors of the Sponsor (Switch AI) and its parent, affiliates, judges, and their immediate family or household cannot win. | [Rules §4](https://www.wemakedevs.org/hackathons/switch/rules) |
| Identity | One natural person, legal name, real email. No bots, extra accounts, or automated registration. Using AI to build the submission is allowed. | [Rules §3](https://www.wemakedevs.org/hackathons/switch/rules) |
| Cost | Free to enter. Switch is free to self-host. I bring my own model key. | [Event FAQ](https://www.wemakedevs.org/hackathons/switch) |
| Prior work | Existing agents and libraries are allowed. The Switch setup and the workflow the agents run must be built during the hackathon (4 Nov 2026, 12:01 AM IST through 7 Nov 2026, 11:59 PM IST). | [DevTools Academy FAQ](https://www.devtoolsacademy.com/hackathons/flip-the-switch) |

Prize payout can require tax forms (the rules name IRS W-9 or W-8BEN) and identity verification. Winners are responsible for their own taxes. ([Rules §3 and §7](https://www.wemakedevs.org/hackathons/switch/rules).)

I keep ownership of the submission and grants the Sponsor a non-exclusive license to host and promote it. ([Rules §5](https://www.wemakedevs.org/hackathons/switch/rules).)

## Event facts

- Name: Flip the Switch. Hosts: WeMakeDevs, DevTools Academy, Switch.
- When: 4 Nov 2026, 12:01 AM IST to 7 Nov 2026, 11:59 PM IST. Online. ([Schedule](https://www.wemakedevs.org/hackathons/switch/schedule).)
- What you build: a workflow in a team chat where at least one person and one AI agent finish a real task together, connected through Switch. A chatbot is not required. ([Event FAQ](https://www.wemakedevs.org/hackathons/switch).)
- Switch is mandatory. The README must show how it is used. A project that still works with Switch removed fails the top judging question.

## Tracks and prizes

WeMakeDevs is the only page that states the Track 01 and Track 02 cash amounts. DevTools Academy still says those two prizes are "to be announced" and uses different counts for Track 03, the blog, and swag. Treat the WeMakeDevs figures as the ones to enter against, and re-read both pages on submit day.

### WeMakeDevs (event home)

Source: [hackathon page](https://www.wemakedevs.org/hackathons/switch). Prize pool stated as $10,000.

| Track | Prize | What it asks for |
| --- | --- | --- |
| 01 Best Business Workflow | $2,000 | The most practical workflow where people and agents get work done. Open to any mix of people, agents, and rooms. |
| 02 Best Personal or Creative Workflow | $2,000 | Switch for everyday tasks, personal projects, or creative work. |
| 03 Best Core Contribution | $100 × 20 | Top 20 pull requests to Switch's open source core. Issue must be labelled `hackathon`, assigned before coding, PR open by the deadline, `Closes #number`. Low-effort PRs are not judged. CLA on the first PR. Up to 5 open PRs. |
| Code with Wispr (side) | $500 | Build by voice with Wispr Flow. Submit a screenshot of the Insights scorecard. |
| Best Blog (side) | AirPods 5 | Best post about the build: what you made, how you set it up, what you learned. Can be entered alone or on top of a track. |
| #HowISwitch | Logitech mechanical keyboards for the best posts | Social posts with that hashtag. The page does not give a count. |
| Random draw | Swag for 20 submissions | Picked at random from project submissions. |
| Everyone | Certificate | Every submission. |

Star [sandbox-quantum/switch](https://github.com/sandbox-quantum/switch) for a Keychron keyboard draw. That star is not a judging criterion.

### Where the co-host page disagrees

Source: [DevTools Academy](https://www.devtoolsacademy.com/hackathons/flip-the-switch).

- Track 01 and Track 02: "Prize to be announced."
- Track 03: $100 each for the top 10 pull requests, and "work on one issue at a time" rather than up to five open PRs.
- Best Blog: AirPods 5 for each of the top 5 posts.
- Swag: "shipped to the top 20 #HowISwitch posts," not a random draw of 20 projects.

[Luma](https://luma.com/switchai) also compresses the prize list differently. Do not cite Luma in the submission.

## Judging

Both pages ask the same four questions. Only DevTools Academy publishes weights. The WeMakeDevs page names the criteria; the fetched page rendered each weight as 0%, which is a broken counter, not a published score.

| Criterion | Weight (DevTools Academy) | Question |
| --- | --- | --- |
| Use of Switch | 30% | Is Switch central, and would the project stop working without it? |
| Technical execution | 25% | Does it run, and could someone clone the repo and reproduce it? |
| Creativity and impact | 25% | Is it a fresh idea that solves a problem a real team has? |
| Presentation | 20% | Do the demo video and README make clear what was built and how Switch is used? |

Process: every submission is reviewed, WeMakeDevs shortlists, then Switch, DevTools Academy, and WeMakeDevs judge the finalists. ([Event page](https://www.wemakedevs.org/hackathons/switch), [DevTools Academy judging](https://www.devtoolsacademy.com/hackathons/flip-the-switch).)

What that implies for a 24-hour solo build:

- Switch has to be on the critical path. A dashboard that triages tickets with no room loses the 30% criterion even if the UI is polished.
- A judge must be able to clone and run it. A demo that only works on one laptop with an unstated prompt fails technical execution.
- The official sample on the event page is already a triage room (`triage-pair.template.yaml`: one agent labels, another reproduces). Copying that sample spends the creativity points.
- The video and README carry 20%. They have to show the room, not only a web app.

## Required submission items

Agreed by [DevTools Academy, "What you submit"](https://www.devtoolsacademy.com/hackathons/flip-the-switch) and the [WeMakeDevs schedule](https://www.wemakedevs.org/hackathons/switch/schedule) ("Submit your repo, demo video and README"):

1. A **public** project repository.
2. A **short demo video** of the workflow running. The organisers' final email asks for it to be under three minutes. Mine is about two.
3. A **README** that says which agents were connected, how the channel is set up, and how to run it.

Optional, and only if actually done:

- A blog post, which also enters Best Blog.
- A Wispr Flow Insights screenshot, which enters Code with Wispr. The scorecard has to be real usage, not a plan to dictate later.

**A live or deployed URL is not a required field** on either page. The resources tab points at a local Console + Docker + Mattermost setup, then "submit your repo, demo video, and README." ([Resources](https://www.wemakedevs.org/hackathons/switch/resources), [DevTools Academy get-started](https://www.devtoolsacademy.com/hackathons/flip-the-switch).)

Help during the event is the WeMakeDevs Discord. The DevTools Academy page also mentions a Switch Discord.

## How Switch must be used

Switch ships no agents and no models. It connects a chat app to agents the participant brings. ([Event page](https://www.wemakedevs.org/hackathons/switch), [Rooms intro](https://docs.switchagents.ai/switch-rooms).)

### Console, Docker, Mattermost

- Switch Console is the desktop app. It can start a local Switch server **in Docker**. Docker must already be installed (Docker Desktop, Rancher Desktop, or Homebrew). Console then starts the server, the Gateway, and a Mattermost, creates an admin, and signs itself in. There is no URL or secret to copy for that local server. Quitting Console leaves the server running; a reboot does not bring it back. ([Add a server](https://docs.switchagents.ai/switch-rooms/getting-started/add-a-server.md).)
- Console downloads: macOS Apple silicon and Intel are the stable builds. Windows and Linux are early access and "still changing." ([Install](https://docs.switchagents.ai/switch-rooms/getting-started/install-switch-console.md).) The event FAQ says the same. ([Event FAQ](https://www.wemakedevs.org/hackathons/switch).)
- Bundled Mattermost is the supported way to demo with no Slack workspace and no admin rights. Each agent gets its own Mattermost bot account. Adding that account to a channel creates the room; the other direction also works (create the room in Switch, and Switch creates the channel). Sign-in details are on the server Home page, Messaging apps, "Sign-in details…". ([Mattermost](https://docs.switchagents.ai/switch-rooms/deploy/messaging-apps/mattermost.md).)
- The human's Mattermost account must be linked to the Switch user ("This is me"). Until it is linked, an agent restricted to its owner cannot tell the human is the owner and refuses the work. ([Add a server](https://docs.switchagents.ai/switch-rooms/getting-started/add-a-server.md).)
- Slack, Teams, Discord, and Telegram are optional. Teams needs Switch reachable from the internet. Skip all of them for this build.
- Mattermost has no native slash-command UI for Switch. Inviting another agent from inside the channel is `!invite-agent @agent-name`. Buttons on posts require a Callback Base URL set when the connection is created; connection details cannot be edited later from Console. Do not depend on buttons. ([Mattermost](https://docs.switchagents.ai/switch-rooms/deploy/messaging-apps/mattermost.md).)

### Rooms

A room is one channel plus a shared log: instructions, documents, references, roles, tasks. Room instructions are the briefing an agent reads when it joins; an agent already in the room keeps the copy it received until it reconnects. ([Payments room](https://docs.switchagents.ai/switch-rooms/building/payments-room.md), [Create a room](https://docs.switchagents.ai/switch-rooms/getting-started/create-a-room.md).)

New rooms are public-read and public-write. That is acceptable for a local demo. Do not attach anything real. ([Shared responsibility](https://docs.switchagents.ai/switch-rooms/resources/shared-responsibility.md).)

The marketing YAML on the event page (`agents`, `room`, `kickoff`, `{team}` fields) is a teaching example. The template language Console actually imports is version 1 or version 2 in the Switch repo; Switch 0.31 reads both. Version 2 uses `version: 2` and a `resources:` list. A template that **creates** an agent needs `provider`, `machine` (or `location`), and `directory`, and Console runs that agent. `allow_existing: true` is how a template uses an agent that already exists. ([Templates](https://docs.switchagents.ai/switch-rooms/administer/room-templates.md), [changelog notes on #851](https://github.com/sandbox-quantum/switch/blob/main/CHANGELOG.md).)

### Agent protocol (the integration I built)

Sources: [protocol](https://docs.switchagents.ai/switch-rooms/internals/agent-protocol.md), [connection](https://docs.switchagents.ai/switch-rooms/internals/agent-connection.md), [events](https://docs.switchagents.ai/switch-rooms/internals/agent-events.md).

The event page still says "Server-sent events in, HTTP out." That is the old client. **SSE is deprecated.** Current clients open a WebSocket and call HTTP for everything they do. There is no client library.

Registration, once:

- `POST /agents` with a **registration** API key (`Authorization: Bearer`). An agent API key cannot register. The key is created on the Gateway API Keys page; its creator becomes the agent owner. A brand-new deployment can use its bootstrap key instead. Refund Desk does not: that key's agents belong to a dedicated account, so owner-only approval would not bind to me. I create a registration key instead (Console 0.40.1 has no API Keys page, so `npm run key` does it through the gateway API).
- Do **not** call `POST /agents/register-known`. That route only registers the agent types Console runs.
- Body requires `name` (`^[a-z0-9][a-z0-9._-]*$`), `description`, `connector_type` (free-form), and `integration_profile`.
- `integration_profile` requires `connection_model` (`always_on`, `session_addressable`, `auto_session`, or `session_passive`), `message_exchange` (boolean), and `pre_invocation_mediation`, `post_invocation_mediation`, `event_reporting` (send `[]` if unused).
- Response is `{id, api_key}`. The API key is returned once.
- Registering the same name again is 409. `overwrite: true` issues a new key and kills the old one.

A new agent answers its owner only. Widen that with `POST /agents/{agent_id}/ops/update_agent_detail` and `{"agent_id","addressing"}` where addressing is `owner_only`, `owner_and_owner_agents`, or `anyone`. For a refund agent, stay on `owner_only`.

Connection:

- `GET /agents/{agent_id}/connection/ws?connection_id=<uuid>&rooms=<id>` with the agent API key. Reuse the same `connection_id`. Scheme matches the server (`ws://` locally).
- Browser WebSockets cannot set the Authorization header. The client has to be a server process.
- If the agent is run by an agent controller, the socket is refused `managed_by_controller` (close 4409). Console's New Agent form creates that kind of agent. A protocol client you run yourself must be registered with `POST /agents` and not also created as a Console-managed agent of the same name.
- On a Console-run local server, agent management is on by default and Console moves **agents it runs** onto a managed machine. That move is about Console-run agents, not a socket you hold yourself. I still checked early that my socket stays up. ([What keeps your agent running](https://docs.switchagents.ai/switch-rooms/getting-started/what-keeps-your-agent-running.md).)
- First frame is `connection_state`. Keep `generation`, `rooms`, and `cursor` from that frame.
- Server sends `ping` every 2 seconds. Reply immediately with `{"type":"pong","cursor":<highest sequence processed>}`. Silence for 6 seconds lapses the claim (`heartbeat_lapsed`), which is recoverable.
- `taken_over` is final: do not reconnect. Pass `expected_generation` on resume so two retries do not steal the socket from each other.
- Act on a `message` only when `payload.addressed` is true. With `filter=all` the socket also receives messages that do not address the agent.
- Participant ids are opaque. Do not parse them to decide who is human.
- Domain events: `message` (`addressed`, `sender`, `sender_name`, `message_id`, `body`, `timestamp`, `thread_id`, `attachments`), `command`, `room_join`.
- Post with the `post_message` operation, or `POST /agents/{agent_id}/message` with `{room_id, content}` and no connection. Operation calls are `POST /agents/{agent_id}/ops/{operation}` with `X-Switch-Connection-Id` and the arguments unwrapped. Discover the live argument list with `GET /agents/{agent_id}/ops` rather than hard-coding it. Failures: 400, 403, 404, 409.
- There is no task protocol. One agent hands work to another by posting a message. The changelog records the old task tools as removed.
- `read_context` is how a client re-reads history after a `gap` frame. Cursors only move forward.

`GET /health` on the bridge base URL is the unauthenticated probe. A 401 means the right host and the wrong path.

### What Switch will not do for us

From the [shared responsibility model](https://docs.switchagents.ai/switch-rooms/resources/shared-responsibility.md) (checked by the docs against Console 0.31.0 / switch-core 0.21.0; later pages mention Console 0.40, so treat the line as product policy, not a build pin):

> Switch doesn't look at what a tool call would do, and a room doesn't turn a tool call into a reviewed action. Put the control where the agent runs.

An in-thread "Approved" is a message. It becomes a control only if my process refuses the tool without a recorded approval. Prompt text that says "wait for a human" is not that control. Switch Trust can redact PII before a message reaches a room ([guardrails scenario](https://docs.switchagents.ai/switch-rooms/use-cases/guardrails.md)); that is a separate product, not part of a local Console install, and not something this build should depend on.

### Docs map used for this pass

- Event: https://www.wemakedevs.org/hackathons/switch
- Rules: https://www.wemakedevs.org/hackathons/switch/rules
- Schedule: https://www.wemakedevs.org/hackathons/switch/schedule
- Resources: https://www.wemakedevs.org/hackathons/switch/resources
- Co-host page: https://www.devtoolsacademy.com/hackathons/flip-the-switch
- Docs index: https://docs.switchagents.ai/llms.txt
- Quickstart: https://docs.switchagents.ai/switch-rooms/getting-started
- Protocol, connection, events: linked above
- Repo (do not treat `docs/official/` inside it as source of truth): https://github.com/sandbox-quantum/switch

## Early assumptions I changed

My first plan was a guess. These are the parts the sources corrected.

| What I assumed at first | What the sources say |
| --- | --- |
| Transport is SSE in, HTTP out | SSE is deprecated. Use the WebSocket. |
| Point the room at my existing `dukaan-agent` repo | Allowed as prior art, but a bad bet. Judges must clone and run the workflow, and the workflow itself has to be built during the hackathon. This repo contains the agent. |
| A marketing-style room template is what Console imports | It matches the marketing sample, not the versioned template language. |
| A support-triage chat is the obvious Track 01 entry | The event page's own sample is a triage pair. A label-and-route room spends the creativity criterion, so I built an approval workflow instead. |
| A public live link is part of looking finished | Not required. A local audit view is still worth building, because the chat transcript alone cannot prove a tool was refused. |
