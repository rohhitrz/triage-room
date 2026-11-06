import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { buildDraftPrompt, type Assessment, type Clause, type OrderRow } from "../policy/ground.ts";

export type DraftOutput = {
  customer_reply: string;
  internal_note: string;
  cited_chunk_ids: string[];
};

export function assertRunnableMode(mode: string | undefined): void {
  if (mode === "scripted") {
    throw new Error("LLM_MODE=scripted is for tests only. npm start requires a live model.");
  }
  if (mode && mode !== "live") throw new Error("LLM_MODE must be live.");
}

export function optionalEnv(value: string | undefined | null): string | undefined {
  if (value == null) return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

export function assertHttpUrl(value: string, name = "LLM_BASE_URL"): void {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${name} is not a URL: ${value}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`${name} must be http or https: ${value}`);
  }
}

export function resolveChat(provider: string, model: string | undefined, baseUrl: string | undefined): { url: string; model: string } {
  const base = optionalEnv(baseUrl);
  const chosen = optionalEnv(model);
  if (base) assertHttpUrl(base);
  if (provider === "gemini") {
    const url = base ?? "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions";
    return { url, model: chosen ?? "gemini-2.5-flash" };
  }
  const root = (base ?? "https://api.openai.com/v1").replace(/\/$/, "");
  const url = root.endsWith("/chat/completions") ? root : `${root}/chat/completions`;
  return { url, model: chosen ?? "gpt-4o-mini" };
}

export function validateLlmEnv(env: NodeJS.ProcessEnv): void {
  const base = optionalEnv(env.LLM_BASE_URL);
  if (base) assertHttpUrl(base);
  resolveChat(optionalEnv(env.LLM_PROVIDER) ?? "openai", env.LLM_MODEL, base);
}

export function scriptedDraft(orderId: string): DraftOutput {
  return {
    customer_reply: `Hello, we have your note about order #${orderId}. This wording is a fixture for tests and has not been sent.`,
    internal_note: "scripted fixture",
    cited_chunk_ids: orderId === "4821" ? ["duplicate-charge", "window"] : ["window"],
  };
}

// OpenAI reasoning models (o-series, gpt-5 family) reject a temperature other than the default.
export function acceptsTemperature(model: string): boolean {
  return !/^(o\d|gpt-5)/i.test(model.trim());
}

export function chatBody(provider: string, model: string, prompt: { system: string; user: string }): Record<string, unknown> {
  return {
    model,
    ...(acceptsTemperature(model) ? { temperature: 0 } : {}),
    // JSON mode makes the model return a parseable object instead of prose or fenced code.
    ...(provider === "openai" ? { response_format: { type: "json_object" } } : {}),
    messages: [
      { role: "system", content: prompt.system },
      { role: "user", content: prompt.user },
    ],
  };
}

export async function liveDraft(input: {
  provider: string;
  apiKey: string;
  model?: string;
  baseUrl?: string;
  order: OrderRow;
  clauses: Clause[];
  ticketText: string;
  assessment: Assessment;
  fetchImpl?: typeof fetch;
}): Promise<DraftOutput> {
  if (!input.apiKey) throw new Error("LLM_API_KEY is empty.");
  const fetchImpl = input.fetchImpl ?? fetch;
  const target = resolveChat(input.provider, input.model, input.baseUrl);
  const prompt = buildDraftPrompt({
    order: input.order,
    clauses: input.clauses,
    ticketText: input.ticketText,
    assessment: input.assessment,
  });
  const response = await fetchImpl(target.url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${input.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(chatBody(input.provider, target.model, prompt)),
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`model request failed: ${response.status} ${await response.text()}`);
  const payload = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
  const content = payload.choices?.[0]?.message?.content ?? "";
  return parseDraft(content);
}

export function parseDraft(content: string): DraftOutput {
  const cleaned = content.trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  const parsed = JSON.parse(cleaned) as Partial<DraftOutput>;
  if (typeof parsed.customer_reply !== "string" || !parsed.customer_reply.trim()) {
    throw new Error("model returned no customer_reply");
  }
  return {
    customer_reply: parsed.customer_reply.trim(),
    internal_note: typeof parsed.internal_note === "string" ? parsed.internal_note : "",
    cited_chunk_ids: Array.isArray(parsed.cited_chunk_ids) ? parsed.cited_chunk_ids.filter((id) => typeof id === "string") : [],
  };
}

export function recordLlmCall(db: DatabaseSync, input: { ticketId: string | null; provider: string; model: string; prompt: string; response: DraftOutput; latencyMs: number }): void {
  db.prepare(
    `INSERT INTO llm_calls (id, ticket_id, provider, model, prompt_hash, response_json, latency_ms, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    randomUUID(),
    input.ticketId,
    input.provider,
    input.model,
    createHash("sha256").update(input.prompt).digest("hex"),
    JSON.stringify(input.response),
    input.latencyMs,
    new Date().toISOString(),
  );
}
