export class BootstrapKeyError extends Error {
  constructor() {
    super(
      "Refusing the bootstrap key. Create a registration key on the Gateway after Console signs you in. The bootstrap key assigns a dedicated owner and breaks owner-only approval.",
    );
    this.name = "BootstrapKeyError";
  }
}

export function assertRegistrationKey(input: { registrationKey: string; keyKind?: string; bootstrapKey?: string }): void {
  if (input.keyKind === "bootstrap" || (input.bootstrapKey && input.registrationKey === input.bootstrapKey)) {
    throw new BootstrapKeyError();
  }
  if (!input.registrationKey) throw new Error("SWITCH_REGISTRATION_KEY is empty.");
}

export async function registerAgent(input: {
  baseUrl: string;
  registrationKey: string;
  keyKind?: string;
  bootstrapKey?: string;
  name?: string;
  fetchImpl?: typeof fetch;
  persist?: (created: { id: string; api_key: string }) => void;
}): Promise<{ id: string; api_key: string; addressing: "owner_only" | "server_default" }> {
  assertRegistrationKey(input);
  const fetchImpl = input.fetchImpl ?? fetch;
  const name = input.name ?? "refund-desk";
  const response = await fetchImpl(`${input.baseUrl.replace(/\/$/, "")}/agents`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${input.registrationKey}`,
      "Content-Type": "application/json",
    },
    signal: AbortSignal.timeout(20_000),
    body: JSON.stringify({
      name,
      description:
        "Drafts a refund reply and executes simulated actions only after a fail-closed in-thread approval.",
      connector_type: "refund-desk",
      integration_profile: {
        connection_model: "always_on",
        message_exchange: true,
        pre_invocation_mediation: [],
        post_invocation_mediation: [],
        event_reporting: [],
      },
    }),
  });
  if (!response.ok) {
    throw new Error(`POST /agents failed: ${response.status} ${await response.text()}`);
  }
  const created = (await response.json()) as { id: string; api_key: string };
  input.persist?.(created);
  const addressing = await fetchImpl(`${input.baseUrl.replace(/\/$/, "")}/agents/${created.id}/ops/update_agent_detail`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${created.api_key}`,
      "Content-Type": "application/json",
    },
    signal: AbortSignal.timeout(20_000),
    body: JSON.stringify({ agent_id: created.id, addressing: "owner_only" }),
  });
  // Newer servers refuse this from the agent's own key: only the owner may change
  // addressing, in Console. A new agent already answers its owner only, so that
  // refusal leaves the setting we want in place.
  if (addressing.status === 403) {
    await addressing.text();
    return { ...created, addressing: "server_default" };
  }
  if (!addressing.ok) {
    throw new Error(`update_agent_detail failed: ${addressing.status} ${await addressing.text()}`);
  }
  return { ...created, addressing: "owner_only" };
}
