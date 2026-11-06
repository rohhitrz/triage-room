# Demo script

Film the Mattermost channel. Keep it under two minutes. The ledger cut is the last ten seconds. `npm start` must be on `LLM_MODE=live`. Do not film scripted mode.

Say this once, at the start or the end: "Switch put the agent in the room. The refund does not run until the approval in this thread checks out."

| Time | Who | Do this | What you should see |
| --- | --- | --- | --- |
| 0:00 | You | Show the channel members. `refund-desk` is in the room. | The agent has its own Mattermost account. |
| 0:10 | You | `@refund-desk Order #4821 charged twice, customer wants a refund.` | A reply in that thread. It says unsent draft, eligible, and pending `send_reply`, `flag_finance`, `issue_refund`. The wording is the model's, not a canned paragraph. |
| 0:40 | You | `@refund-desk Approved, don't issue the refund.` | `Blocked. Nothing was executed.` Reason: the approval contained a negation. |
| 0:55 | You | `@refund-desk Approved, send the reply and flag finance.` | Ledger lines for a simulated send and a simulated finance flag. `issue_refund` stays pending. It does not say refused. |
| 1:15 | You | Switch to `http://127.0.0.1:8787`. | The negation is in the audit list. Then the two simulated executions. `issue_refund` is still pending. |

If the model is slow, wait. Do not paste a prepared reply over it. If the draft fails, say the ticket again. The agent will not substitute the test fixture.

Reset by deleting `data/refund-desk.sqlite` and running `npm run db:migrate && npm run db:seed` before the take you keep. Leave `data/agent.json` in place.
