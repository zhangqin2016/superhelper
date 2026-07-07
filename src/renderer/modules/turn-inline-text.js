import { renderMarkdownContent } from "./content-blocks.js";
import { renderStreamingMarkdown } from "./markdown.js";

export function renderInlineTextEntry(entry, live = false, {
  renderStreaming = renderStreamingMarkdown,
  renderContent = renderMarkdownContent,
} = {}) {
  const text = String(entry.text || "").trim();
  if (!text) return null;
  const node = document.createElement("div");
  node.className = "assistant-turn-inline-text markdown-body";
  node.dataset.textId = entry.id || "";
  // Streaming stays lightweight; sealed/history text gets the full markdown pass.
  if (live) renderStreaming(node, text);
  else renderContent(node, text);
  return node;
}
