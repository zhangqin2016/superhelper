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
