export type ModelTokenUsage = {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
};

export function normalizeModelTokenUsage(value: unknown): ModelTokenUsage | null {
  const root = readObject(value);
  if (!root) {
    return null;
  }

  const usage = readObject(root.last)
    ?? readObject(root.lastTokenUsage)
    ?? readObject(root.last_token_usage)
    ?? readObject(root.total)
    ?? readObject(root.totalTokenUsage)
    ?? readObject(root.total_token_usage)
    ?? root;
  const outputDetails = readObject(usage.outputTokensDetails) ?? readObject(usage.output_tokens_details);
  const values = [
    readUsageNumber(usage, "inputTokens", "input_tokens"),
    readUsageNumber(usage, "cachedInputTokens", "cached_input_tokens"),
    readUsageNumber(usage, "outputTokens", "output_tokens"),
    readUsageNumber(usage, "reasoningOutputTokens", "reasoning_output_tokens")
      ?? readUsageNumber(outputDetails, "reasoningTokens", "reasoning_tokens"),
    readUsageNumber(usage, "totalTokens", "total_tokens")
  ];
  if (values.every((item) => item === null)) {
    return null;
  }

  const inputTokens = values[0] ?? 0;
  const cachedInputTokens = values[1] ?? 0;
  const outputTokens = values[2] ?? 0;
  const reasoningOutputTokens = values[3] ?? 0;
  const totalTokens = values[4] ?? inputTokens + outputTokens;
  return { inputTokens, cachedInputTokens, outputTokens, reasoningOutputTokens, totalTokens };
}

export function modelTokenUsageFromCodexExecJson(stdout: string): ModelTokenUsage | null {
  let latest: ModelTokenUsage | null = null;
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    try {
      const event = readObject(JSON.parse(trimmed));
      if (!event || event.type !== "turn.completed") {
        continue;
      }
      latest = normalizeModelTokenUsage(event.usage) ?? latest;
    } catch {
      // Codex exec JSONL may be mixed with diagnostics. Ignore non-JSON lines.
    }
  }
  return latest;
}

function readUsageNumber(
  value: Record<string, unknown> | null,
  camelCaseKey: string,
  snakeCaseKey: string
) {
  const candidate = value?.[camelCaseKey] ?? value?.[snakeCaseKey];
  return typeof candidate === "number" && Number.isFinite(candidate)
    ? Math.max(0, Math.round(candidate))
    : null;
}

function readObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}
