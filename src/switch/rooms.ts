export async function listRooms(input: { baseUrl: string; agentId: string; apiKey: string; fetchImpl?: typeof fetch }): Promise<unknown> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const response = await fetchImpl(`${input.baseUrl.replace(/\/$/, "")}/agents/${input.agentId}/ops/list_rooms`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${input.apiKey}`,
      "Content-Type": "application/json",
    },
    body: "{}",
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`list_rooms failed: ${response.status} ${text}`);
  return JSON.parse(text) as unknown;
}
