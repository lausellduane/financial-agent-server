import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { DEFAULT_WORKERS_AI_MODEL } from "./constants.ts";
import {
  WORKERS_AI_MAX_TOKENS,
  WORKERS_AI_TEMPERATURE,
  completeChat,
  llmProvider,
  type ChatTurn,
} from "./llm.ts";

const messages: ChatTurn[] = [{ role: "user", content: "ping" }];

afterEach(() => {
  delete process.env.LLM_PROVIDER;
  delete process.env.WORKERS_AI_MODEL;
});

test("provider selection follows LLM_PROVIDER and the runtime", () => {
  delete process.env.LLM_PROVIDER;
  assert.equal(llmProvider(), "ollama");

  process.env.LLM_PROVIDER = "workers-ai";
  assert.equal(llmProvider(), "workers-ai");

  process.env.LLM_PROVIDER = "ollama";
  assert.equal(llmProvider(), "ollama");

  process.env.LLM_PROVIDER = "something-else";
  assert.equal(llmProvider(), "ollama");
});

test("completeChat throws when Workers AI returns an empty body", async () => {
  process.env.LLM_PROVIDER = "workers-ai";
  await assert.rejects(
    () =>
      completeChat(messages, {
        workersAi: async () => ({ response: "   " }),
      }),
    /Workers AI returned an empty response/,
  );
});

test("completeChat passes temperature and max_tokens to Workers AI", async () => {
  process.env.LLM_PROVIDER = "workers-ai";
  process.env.WORKERS_AI_MODEL = DEFAULT_WORKERS_AI_MODEL;
  let seen:
    | { model: string; temperature: number; max_tokens: number }
    | undefined;
  const text = await completeChat(messages, {
    workersAi: async (model, input) => {
      seen = {
        model,
        temperature: input.temperature,
        max_tokens: input.max_tokens,
      };
      return { response: "ok" };
    },
  });
  assert.equal(text, "ok");
  assert.deepEqual(seen, {
    model: DEFAULT_WORKERS_AI_MODEL,
    temperature: WORKERS_AI_TEMPERATURE,
    max_tokens: WORKERS_AI_MAX_TOKENS,
  });
});

test("completeChat passes temperature to Ollama", async () => {
  process.env.LLM_PROVIDER = "ollama";
  let temperature: number | undefined;
  const text = await completeChat(messages, {
    ollamaChat: async (args) => {
      temperature = args.options.temperature;
      return { message: { content: "local" } };
    },
  });
  assert.equal(text, "local");
  assert.equal(temperature, WORKERS_AI_TEMPERATURE);
});
