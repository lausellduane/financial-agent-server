// Pull a JSON object out of a model reply. Models often wrap it in prose or fences.
export function extractJson(raw: string): unknown {
  const trimmed = raw.trim();
  const fenced = trimmed
    .replace(/^```(?:json|javascript|js)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();

  const candidates = [fenced];
  const start = fenced.indexOf("{");
  const end = fenced.lastIndexOf("}");
  if (start >= 0 && end > start) candidates.push(fenced.slice(start, end + 1));

  let lastError: unknown;
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error("Model did not return JSON");
}
