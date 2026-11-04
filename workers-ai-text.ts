// Workers AI does not use one reply shape.
// Legacy instruct models return { response: string }.
// A JSON reply can arrive already parsed, so response is an object.
// Newer models leave response null and put the text on
// choices[0].message.content. The REST envelope wraps that in result.
// stream: true returns a ReadableStream of SSE frames.

export async function workersAiText(result: unknown): Promise<string> {
  if (isReadableStream(result)) {
    return (await textFromStream(result)).trim();
  }
  if (isResponse(result)) {
    const body = await result.text();
    const parsed = tryParseJson(body);
    if (parsed === undefined) return body.trim();
    const text = readAiText(parsed, 0).trim();
    return text || body.trim();
  }
  return readAiText(result, 0).trim();
}

export function describeAiResult(result: unknown): string {
  if (result === null) return "null";
  if (isReadableStream(result)) return "ReadableStream";
  if (isResponse(result)) return "Response";
  if (typeof result !== "object") return typeof result;
  if (Array.isArray(result)) return `array(${result.length})`;
  const record = result as Record<string, unknown>;
  const parts = [`keys=${Object.keys(record).join(",") || "(none)"}`];
  if ("response" in record) {
    const response = record.response;
    const kind =
      response === null
        ? "null"
        : Array.isArray(response)
          ? "array"
          : typeof response;
    parts.push(`response=${kind}`);
  }
  if (Array.isArray(record.choices)) {
    parts.push(`choices=${record.choices.length}`);
  }
  return parts.join(" ");
}

function readAiText(result: unknown, depth: number): string {
  if (typeof result === "string") return result;
  if (!result || typeof result !== "object" || Array.isArray(result)) return "";
  if (depth > 3) return "";

  const record = result as Record<string, unknown>;
  const fromChoices = readChoices(record.choices);
  if (fromChoices.trim()) return fromChoices;

  if (typeof record.response === "string" && record.response.trim()) {
    return record.response;
  }
  if (record.response && typeof record.response === "object") {
    return JSON.stringify(record.response);
  }
  if (typeof record.response_text === "string" && record.response_text.trim()) {
    return record.response_text;
  }

  const message = record.message;
  if (message && typeof message === "object" && !Array.isArray(message)) {
    const content = (message as { content?: unknown }).content;
    if (typeof content === "string" && content.trim()) return content;
    if (content && typeof content === "object") return JSON.stringify(content);
  }

  if ("result" in record) return readAiText(record.result, depth + 1);
  if (typeof record.response === "string") return record.response;
  return "";
}

function readChoices(choices: unknown): string {
  if (!Array.isArray(choices) || choices.length === 0) return "";
  const first = choices[0];
  if (!first || typeof first !== "object") return "";
  const choice = first as {
    message?: { content?: unknown };
    delta?: { content?: unknown };
  };
  const content = choice.message?.content ?? choice.delta?.content;
  if (typeof content === "string") return content;
  if (content && typeof content === "object") return JSON.stringify(content);
  return "";
}

function isReadableStream(value: unknown): value is ReadableStream<Uint8Array> {
  return typeof ReadableStream !== "undefined" && value instanceof ReadableStream;
}

function isResponse(value: unknown): value is Response {
  return typeof Response !== "undefined" && value instanceof Response;
}

function tryParseJson(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
}

async function textFromStream(stream: ReadableStream<Uint8Array>): Promise<string> {
  const raw = await new Response(stream).text();
  if (!raw.includes("data:")) return raw;
  const parts: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const payload = trimmed.slice("data:".length).trim();
    if (!payload || payload === "[DONE]") continue;
    const parsed = tryParseJson(payload);
    parts.push(parsed === undefined ? payload : readAiText(parsed, 0));
  }
  return parts.join("");
}
