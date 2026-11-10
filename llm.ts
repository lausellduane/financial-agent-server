import { Ollama } from "ollama/browser";
import process from "node:process";
import { onWorkers } from "./access.js";
import { DEFAULT_WORKERS_AI_MODEL } from "./constants.js";
import { describeAiResult, workersAiText } from "./workers-ai-text.js";

export type ChatTurn = { role: "system" | "user"; content: string };

export type LlmProvider = "workers-ai" | "ollama";

export const WORKERS_AI_TEMPERATURE = 0;
export const WORKERS_AI_MAX_TOKENS = 2048;
export const LLM_TIMEOUT_MS = 20_000;

export function llmProvider(): LlmProvider {
  const configured = process.env.LLM_PROVIDER?.trim().toLowerCase();
  if (configured === "workers-ai" || configured === "ollama") return configured;
  // Unset and unknown values follow the runtime: Workers AI there, Ollama on Node.
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

type WorkersAiRun = (
  model: string,
  input: {
    messages: ChatTurn[];
    temperature: number;
    max_tokens: number;
  },
) => Promise<unknown>;

type OllamaChat = (args: {
  model: string;
  messages: ChatTurn[];
  options: { temperature: number };
}) => Promise<{ message: { content: string } }>;

// Node tests set this so a categorization retry does not need a live Ollama.
let testComplete: ((messages: ChatTurn[]) => Promise<string>) | null = null;

export function setCompleteChatForTests(
  fn: ((messages: ChatTurn[]) => Promise<string>) | null,
): void {
  testComplete = fn;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error("LLM request timed out"));
    }, ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

// One chat completion. Workers AI on the Worker, Ollama under Node.
// Callers must not send ledger rows. Categorization gets unknown merchant
// names. Queries get the question and the previous intent only.
export async function completeChat(
  messages: ChatTurn[],
  deps?: { workersAi?: WorkersAiRun; ollamaChat?: OllamaChat },
): Promise<string> {
  if (testComplete) return testComplete(messages);

  if (llmProvider() === "workers-ai") {
    const run =
      deps?.workersAi ??
      (async (model, input) => {
        const { env } = await import("cloudflare:workers");
        return env.AI.run(model, input);
      });
    const result = await withTimeout(
      run(workersAiModel(), {
        messages,
        temperature: WORKERS_AI_TEMPERATURE,
        max_tokens: WORKERS_AI_MAX_TOKENS,
      }),
      LLM_TIMEOUT_MS,
    );
    const text = await workersAiText(result);
    if (!text) {
      throw new Error(
        `Workers AI returned an empty response (${describeAiResult(result)})`,
      );
    }
    return text;
  }

  const chat = deps?.ollamaChat ?? ((args) => ollamaClient().chat(args));
  const response = await withTimeout(
    chat({
      model: ollamaModel(),
      messages,
      options: { temperature: WORKERS_AI_TEMPERATURE },
    }),
    LLM_TIMEOUT_MS,
  );
  return response.message.content;
}
