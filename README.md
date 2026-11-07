# Refund Desk

A Switch room where a support agent and a human finish a duplicate-charge ticket together. A live model writes the customer wording. Code decides eligibility from the order and all three policy clauses. A negated approval is blocked and audited. A later affirmative approval runs only the actions it names, and those actions are simulated: no email, no finance system, no payment.

**Author:** Rohit Raj ([rohhitrz](https://github.com/rohhitrz)), solo.
**Track:** [Best Business Workflow](https://www.wemakedevs.org/hackathons/switch). Deadline 7 Nov 2026, 11:59 PM IST.
**Demo video (2 min):** https://youtu.be/v_CuUYktW4g

Without Switch there is no room, no thread, and nothing for the approval to bind to. The loopback page only reads the ledger.

## How Switch is used

1. Switch Console and Docker run a local Switch server and bundled Mattermost.
2. `npm run register` calls `POST /agents` with a **registration** key and sets `addressing` to `owner_only`. The bootstrap key is refused. Console does not run this agent. Creating the same name from Console's New Agent form makes the server refuse the socket (`managed_by_controller`).
3. The process opens `/agents/{id}/connection/ws` with the room id on the URL, so the room is claimed as the socket opens, then calls `read_context`.
4. Replies go through `post_message` with a `thread_id`. There is no channel-root fallback.
5. The human approves in the thread. Switch does not review the tool. This process does.

Design notes: [docs/SYSTEM_DESIGN.md](docs/SYSTEM_DESIGN.md), [docs/API_DESIGN.md](docs/API_DESIGN.md), [docs/DATABASE_DESIGN.md](docs/DATABASE_DESIGN.md).

## Run it on your machine

Tested live on Switch Console 0.40.1 (switch-core 0.31.0, agent protocol 9) with the bundled Mattermost and `gpt-4o-mini`. The test suite runs against a fake Switch server shaped like that release. Console and Mattermost have to run on your computer. Budget about 30 minutes after Docker is installed. Prefer macOS. Windows and Linux Console builds are early access.

### 1. Install Switch

1. Install Docker and leave it running. [Add a server](https://docs.switchagents.ai/switch-rooms/getting-started/add-a-server) requires it before the local stack will start.
2. Install [Switch Console](https://docs.switchagents.ai/switch-rooms/getting-started/install-switch-console). Apple silicon and Intel are the stable builds.
3. Open Console → **Run a server on this computer** → Start. Wait until the local server is running.
4. On the server Home page, under **Messaging apps**, open **Sign-in details…** for Mattermost. Log in. Then **Link** that account and choose **This is me**. If you skip the link, the agent cannot tell you are the owner.
5. Copy the **server address** agents use. That origin is `SWITCH_BASE_URL`. Check it:

```bash
curl -sS "$SWITCH_BASE_URL/health"
```

You want HTTP 200 from the bridge, not the Mattermost page. A 401 means the host is right and the path is wrong.

6. Create a key of type **registration** and put it in `SWITCH_REGISTRATION_KEY`. Do not use the deployment bootstrap key. That key's agents belong to a dedicated account, so owner-only approval would not bind to you.
   - If your Console has an API Keys page (Gateway, same origin), create it there.
   - **Console 0.40.1 with a native local server has no API Keys page and no Gateway UI.** Use `npm run key` instead (after step 2 below). It asks for a Switch account, signs in to `/gateway/auth/login`, calls `POST /gateway/api-keys`, and writes the key into `.env` without printing it. The password is read without echo. On a Console-run server, the admin login is the `GATEWAY_ADMIN_EMAIL` and `GATEWAY_ADMIN_PASSWORD` lines in `~/Library/Application Support/switchdash/local-switch-server/native/run/switch-core.env`. Read them yourself; the script never opens that file.

### 2. Install this repo

Node.js 22.13 or newer.

```bash
git clone https://github.com/rohhitrz/triage-room.git
cd triage-room
npm install
cp .env.example .env
```

Edit `.env`:

```bash
SWITCH_BASE_URL=http://127.0.0.1:8000
SWITCH_REGISTRATION_KEY=paste-the-registration-key
LLM_MODE=live
LLM_PROVIDER=openai
LLM_API_KEY=paste-an-openai-or-gemini-key
LLM_MODEL=
SWITCH_CONSOLE_VERSION=
```

`LLM_PROVIDER=gemini` uses `https://generativelanguage.googleapis.com/v1beta/openai/chat/completions` and defaults to `gemini-2.5-flash`. Set `LLM_BASE_URL` only if you need a different OpenAI-compatible host. Leave `LLM_MODE=live`. `scripted` is for `npm test` and `npm start` will exit if you set it.

```bash
npm test
npm run register
```

`npm run register` writes gitignored `data/agent.json` and sets `owner_only`. A second run returns 409 if the name already exists. Keep the saved key. Do not send `overwrite`.

### 3. Create the room

1. In Console, create a room on the bundled Mattermost bridge. Name it `refund-desk`. Do not add a second agent.
2. Paste [room/instructions.md](room/instructions.md) into the room instructions.
3. Invite yourself if the channel does not already contain you.
4. Add the agent. Console's agent picker lists only agents Console runs, so `refund-desk` will not appear there. In the Mattermost channel, send `/invite @refund-desk`. Switch posts a greeting from the bot when the room assignment lands.

```bash
npm run rooms
```

Copy the `room_id` of the room named `refund-desk` into `.env` as `SWITCH_ROOM_ID`. The command opens its own short-lived connection, so it is safe to run while `npm start` is up.

```bash
npm run discover
npm start
```

`npm start` migrates and seeds the ledger, serves `http://127.0.0.1:8787`, claims the room, and waits. `data/switch-discovery.json` records health, the server version when the bridge sends one, `SWITCH_CONSOLE_VERSION`, and the live `post_message` schema. If that schema has no `thread_id`, the process exits. It will not post at the top of the channel.

Leave this process running.

### 4. Bind the owner, then film

In Mattermost:

```text
@refund-desk hello
```

The terminal prints `addressed sender_id=...`. Put that exact value in `.env`:

```bash
SWITCH_OWNER_PARTICIPANT_ID=paste-the-sender-id
```

Stop `npm start` and start it again. Until this is set, every approval is rejected with `owner_not_configured`.

Follow [DEMO.md](DEMO.md). The ledger is `http://127.0.0.1:8787`. It refreshes every 3 seconds. It has no token.

### Smoke checklist

- [ ] `curl` to `$SWITCH_BASE_URL/health` returns 200.
- [ ] Mattermost account is linked (**This is me**).
- [ ] `npm test` passes with no API key and no Switch.
- [ ] `npm run register` used a registration key, not the bootstrap key.
- [ ] `data/switch-discovery.json` exists. Note `server_version` and `console_version`.
- [ ] The socket stayed up through a real five-minute wait (the test suite compresses 150 pings; this check is the real interval).
- [ ] `@refund-desk` reply lands **in the thread**, not at the channel root.
- [ ] The draft text is from the live model (`LLM_MODE=live`).
- [ ] `Approved, don't issue the refund` leaves every proposal pending and adds an audit reason.
- [ ] `Approved, send the reply and flag finance` shows two simulated ledger lines. `issue_refund` stays pending.
- [ ] `http://127.0.0.1:8787` shows that block, then those two executions.

## Tests

```bash
npm test
```

Covers the seed, registration refusal, a 150-ping heartbeat, in-thread post, ack-after-queue, reconnect, gap, negation, wrong thread, wrong sender, stale version, eligibility, citation rejection, crash resume, atomic rollback, the live request shape, and the loopback page. No network.

## Submission

| Field | Value |
| --- | --- |
| Project | Refund Desk |
| Track | Best Business Workflow |
| Team | Solo — Rohit Raj (rohhitrz) |
| Repo | https://github.com/rohhitrz/triage-room |
| Demo video | https://youtu.be/v_CuUYktW4g |
| Live link | Not required. Ledger is local. |
| Blog / Wispr | Skip unless you actually publish or dictate. |

Star https://github.com/sandbox-quantum/switch if you want the keyboard draw. Submit the public repo, the video, and this README on the hackathon form before 11:59 PM IST on 7 Nov 2026.

## License

MIT. Switch, Mattermost, and the model providers keep their own licenses.
