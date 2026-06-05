function numberValue(value) {
  const n = Number(value ?? 0);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
}

function isModelUsageEntry(entry) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
  return (
    "inputTokens" in entry ||
    "outputTokens" in entry ||
    "input_tokens" in entry ||
    "output_tokens" in entry
  );
}

export function summarizeTurnUsage(usage) {
  if (!usage || typeof usage !== "object") return null;

  let input = 0;
  let output = 0;
  const estimated = numberValue(usage.estimatedTokens);

  const nested = usage.usage && typeof usage.usage === "object" ? usage.usage : usage;
  input += numberValue(nested.input_tokens ?? nested.inputTokens);
  output += numberValue(nested.output_tokens ?? nested.outputTokens);

  for (const entry of Object.values(nested)) {
    if (!isModelUsageEntry(entry)) continue;
    input += numberValue(entry.inputTokens ?? entry.input_tokens);
    output += numberValue(entry.outputTokens ?? entry.output_tokens);
  }

  const total = input + output;
  if (total > 0) return { input, output, total };
  if (estimated > 0) return { input: 0, output: 0, total: estimated };
  return null;
}

export function formatTokenCount(value) {
  const n = numberValue(value);
  if (!n) return "";
  if (n >= 1_000_000) return `${(Math.round(n / 100_000) / 10)}M`;
  if (n >= 1000) return `${(Math.round(n / 100) / 10)}k`;
  return String(n);
}
