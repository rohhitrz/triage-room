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
}): Promise<{ id: string; api_key: string }> {
  assertRegistrationKey(input);
  const fetchImpl = input.fetchImpl ?? fetch;
  const name = input.name ?? "refund-desk";
  const response = await fetchImpl(`${input.baseUrl.replace(/\/$/, "")}/agents`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${input.registrationKey}`,
      "Content-Type": "application/json",
    },
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
  const addressing = await fetchImpl(`${input.baseUrl.replace(/\/$/, "")}/agents/${created.id}/ops/update_agent_detail`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${created.api_key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ agent_id: created.id, addressing: "owner_only" }),
  });
  if (!addressing.ok) {
    throw new Error(`update_agent_detail failed: ${addressing.status} ${await addressing.text()}`);
  }
  return created;
}
