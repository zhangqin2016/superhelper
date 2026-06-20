const MERMAID_START_RE = /^(?:graph|flowchart|sequenceDiagram|classDiagram|stateDiagram|erDiagram|journey|gantt|pie|mindmap|timeline|quadrantChart|requirementDiagram|gitGraph|C4Context|sankey-beta|xychart-beta|block-beta|packet-beta)\b/;

export const MERMAID_LANGUAGES = new Set([
  "mermaid",
  "flowchart",
  "sequence",
  "sequenceDiagram",
  "classDiagram",
  "stateDiagram",
  "erDiagram",
  "journey",
  "gantt",
  "pie",
  "pieChart",
]);

export function normalizeCodeLanguage(lang = "") {
  return String(lang || "").trim().split(/\s+/)[0];
}

export function looksLikeMermaidCode(source = "") {
  const firstLine = String(source).split("\n").map((line) => line.trim()).find(Boolean) || "";
  return MERMAID_START_RE.test(firstLine);
}

export function isMermaidLanguage(lang = "") {
  return MERMAID_LANGUAGES.has(normalizeCodeLanguage(lang));
}

// A line that is ONLY pipes / dashes / colons / whitespace (e.g. a stray markdown
// table separator "| --- | --- | --- |") — never valid Mermaid. Models sometimes
// interleave these into a diagram and break the whole render; drop them so the
// rest still parses. A real edge label line like `A -->|fail| B` has other chars
// and is NOT matched.
const TABLE_SEPARATOR_LINE_RE = /^\s*\|[\s|:-]*\|\s*$/;

export function sanitizeMermaidSource(source = "") {
  return String(source)
    .split("\n")
    .filter((line) => !TABLE_SEPARATOR_LINE_RE.test(line))
    .join("\n")
    .trim();
}
