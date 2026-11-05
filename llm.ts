import { Ollama } from "ollama/browser";
import process from "node:process";
import { onWorkers } from "./access.js";
import { describeAiResult, workersAiText } from "./workers-ai-text.js";

export type ChatTurn = { role: "system" | "user"; content: string };

export type LlmProvider = "workers-ai" | "ollama";

// Current Llama 3.1 8B instruct model on Workers AI. The older
// llama-3.1-8b-instruct-fp8-fast id is no longer in the catalog.
const DEFAULT_WORKERS_AI_MODEL = "@cf/meta/llama-3.1-8b-instruct-fast";

export function llmProvider(): LlmProvider {
  const configured = process.env.LLM_PROVIDER?.trim().toLowerCase();
  if (configured === "workers-ai" || configured === "ollama") return configured;
  return onWorkers() ? "workers-ai" : "ollama";
}

export function ollamaModel(): string {
  return process.env.OLLAMA_MODEL || "llama3.1:latest";
}

export function workersAiModel(): string {
  return process.env.WORKERS_AI_MODEL || DEFAULT_WORKERS_AI_MODEL;
}

function ollamaClient(): Ollama {
  const host = process.env.OLLAMA_HOST;
  const apiKey = process.env.OLLAMA_API_KEY;
  return new Ollama({
    ...(host ? { host } : {}),
    ...(apiKey ? { headers: { Authorization: `Bearer ${apiKey}` } } : {}),
  });
}

// One chat completion. Workers AI on the Worker, Ollama under Node.
// Callers must not send ledger rows. Categorization gets unknown merchant
// names. Queries get the question and the previous intent only.
export async function completeChat(messages: ChatTurn[]): Promise<string> {
  if (llmProvider() === "workers-ai") {
    const { env } = await import("cloudflare:workers");
    const result = await env.AI.run(workersAiModel(), {
      messages,
      temperature: 0,
      max_tokens: 2048,
    });
    const text = await workersAiText(result);
    if (!text) {
      throw new Error(
        `Workers AI returned an empty response (${describeAiResult(result)})`,
      );
    }
    return text;
  }

  const response = await ollamaClient().chat({
    model: ollamaModel(),
    messages,
    options: { temperature: 0 },
  });
  return response.message.content;
}
