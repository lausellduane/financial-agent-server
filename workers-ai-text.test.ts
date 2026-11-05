import assert from "node:assert/strict";
import { test } from "node:test";
import { workersAiText } from "./workers-ai-text.ts";

test("reads the legacy response string", async () => {
  const text = await workersAiText({
    response: '{"indexes":[1,4]}',
  });
  assert.deepEqual(JSON.parse(text), { indexes: [1, 4] });
});

test("reads a JSON reply that Workers AI already parsed into an object", async () => {
  const text = await workersAiText({
    response: { indexes: [1, 4] },
    tool_calls: [],
  });
  assert.deepEqual(JSON.parse(text), { indexes: [1, 4] });
});

test("reads choices when response is null", async () => {
  const text = await workersAiText({
    response: null,
    choices: [
      {
        message: {
          role: "assistant",
          content: '{"indexes":[2]}',
        },
      },
    ],
  });
  assert.deepEqual(JSON.parse(text), { indexes: [2] });
});

test("prefers choices when both choices and response are set", async () => {
  const text = await workersAiText({
    response: "from response",
    choices: [{ message: { content: "from choices" } }],
  });
  assert.equal(text, "from choices");
});

test("reads choices when response is an empty string", async () => {
  const text = await workersAiText({
    response: "",
    choices: [{ message: { content: "from choices" } }],
  });
  assert.equal(text, "from choices");
});

test("unwraps the REST result envelope", async () => {
  const text = await workersAiText({
    success: true,
    result: { response: "Costco: $86.20" },
  });
  assert.equal(text, "Costco: $86.20");
});

test("reads one SSE frame whose response is a JSON string", async () => {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(
        encoder.encode('data: {"response":"{\\"indexes\\":[1]}"}\n\n'),
      );
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });
  const text = await workersAiText(stream);
  assert.deepEqual(JSON.parse(text), { indexes: [1] });
});

test("concatenates streamed response chunks", async () => {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode('data: {"response":"hello "}\n\n'));
      controller.enqueue(encoder.encode('data: {"response":"world"}\n\n'));
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });
  assert.equal(await workersAiText(stream), "hello world");
});
