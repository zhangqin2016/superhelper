export const DEFAULT_ANTHROPIC_VERSION = "2023-06-01";

export function base64urlEncode(input) {
  return Buffer.from(input)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

export function base64urlDecodeText(input) {
  const value = String(input || "").replace(/-/g, "+").replace(/_/g, "/");
  const pad = value.length % 4 ? "=".repeat(4 - (value.length % 4)) : "";
  return Buffer.from(value + pad, "base64").toString("utf8");
}

export function parseJsonEnv(value, fallback) {
  const text = String(value || "").trim();
  if (!text) return fallback;
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" ? parsed : fallback;
  } catch {
    return fallback;
  }
}

export function cleanBaseUrl(url) {
  return String(url || "").replace(/\/+$/, "");
}

export function textFromContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (part?.type === "text") return part.text || "";
      if (part?.type === "tool_result") return typeof part.content === "string" ? part.content : textFromContent(part.content);
      return "";
    })
    .filter(Boolean)
    .join("\n");
}
