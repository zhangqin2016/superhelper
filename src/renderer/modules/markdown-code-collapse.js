/**
 * Collapsed code blocks: which ones the reader expanded.
 *
 * Long code blocks render as a compact <details> header that expands on
 * demand (see wrapCollapsibleCodeBlock in markdown.js). This module owns the
 * threshold and the memory of what was expanded, which has to survive the
 * innerHTML re-renders that streaming updates and cached renders both do.
 * Display only: no model behaviour depends on it.
 */
export const CODE_COLLAPSE_MIN_LINES = 16;
const CODE_COLLAPSE_EXPANDED_LIMIT = 200;
/** Content hashes the user expanded — survives innerHTML re-renders and caches. */
const expandedCodeBlocks = new Set();

function rememberExpandedCodeBlock(key, open) {
  if (!key) return;
  if (!open) {
    expandedCodeBlocks.delete(key);
    return;
  }
  expandedCodeBlocks.add(key);
  if (expandedCodeBlocks.size > CODE_COLLAPSE_EXPANDED_LIMIT) {
    expandedCodeBlocks.delete(expandedCodeBlocks.values().next().value);
  }
}

export function countCodeLines(text = "") {
  const lines = String(text).split("\n");
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  return lines.length;
}

/** Re-apply the user's expand choices after any re-render (streaming updates
 *  and cached renders both rebuild innerHTML), and track new toggles. */
export function wireCodeCollapse(element) {
  if (!element?.querySelectorAll) return;
  for (const details of element.querySelectorAll("details.markdown-code-collapse")) {
    const key = details.dataset?.codeKey || "";
    if (key && expandedCodeBlocks.has(key)) details.open = true;
    if (details.dataset?.collapseWired === "1") continue;
    if (details.dataset) details.dataset.collapseWired = "1";
    details.addEventListener?.("toggle", () => {
      rememberExpandedCodeBlock(details.dataset?.codeKey || "", details.open);
    });
  }
}
