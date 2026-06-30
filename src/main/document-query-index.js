"use strict";

const MAX_CHUNK_CHARS = 1_200;
const MAX_EXCERPT_CHARS = 220;
const MAX_PROMPT_CHUNKS = 12;

function compactWhitespace(value = "") {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function excerpt(value = "", limit = MAX_EXCERPT_CHARS) {
  const text = compactWhitespace(value);
  if (text.length <= limit) return text;
  return `${text.slice(0, limit - 1)}…`;
}

function headingHint(chunk = "") {
  const lines = String(chunk || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const markdown = lines.find((line) => /^#{1,6}\s+\S/.test(line));
  if (markdown) return markdown.replace(/^#{1,6}\s+/, "").slice(0, 120);
  const short = lines.find((line) => line.length <= 80 && /[:：]?$/.test(line));
  return short ? short.replace(/[:：]$/, "").slice(0, 120) : "";
}

function splitIntoChunks(text = "") {
  const source = String(text || "");
  const chunks = [];
  const headingMatches = [...source.matchAll(/^#{1,6}\s+\S.*$/gm)];
  if (headingMatches.length > 1) {
    for (let i = 0; i < headingMatches.length; i += 1) {
      const start = headingMatches[i].index;
      const end = i + 1 < headingMatches.length ? headingMatches[i + 1].index : source.length;
      const raw = source.slice(start, end).trim();
      if (raw) chunks.push({ text: raw, charStart: start, charEnd: end });
    }
    return chunks;
  }
  let cursor = 0;
  while (cursor < source.length) {
    let end = Math.min(source.length, cursor + MAX_CHUNK_CHARS);
    if (end < source.length) {
      const boundary = source.lastIndexOf("\n\n", end);
      if (boundary > cursor + 240) end = boundary;
    }
    const raw = source.slice(cursor, end).trim();
    if (raw) chunks.push({ text: raw, charStart: cursor, charEnd: end });
    cursor = end;
    while (cursor < source.length && /\s/.test(source[cursor])) cursor += 1;
  }
  return chunks;
}

function buildDocumentQueryIndex(documents = []) {
  const normalizedDocs = [];
  const chunks = [];
  let docIndex = 0;
  for (const document of Array.isArray(documents) ? documents : []) {
    const text = String(document?.text || "");
    if (!text.trim()) continue;
    docIndex += 1;
    const id = `doc${docIndex}`;
    const label = String(document?.label || document?.path || id);
    normalizedDocs.push({
      id,
      label,
      path: document?.path || "",
      charLength: text.length,
    });
    const docChunks = splitIntoChunks(text);
    docChunks.forEach((chunk, index) => {
      chunks.push({
        documentId: id,
        chunkId: `${id}-chunk${index + 1}`,
        label,
        charStart: chunk.charStart,
        charEnd: chunk.charEnd,
        heading: headingHint(chunk.text),
        excerpt: excerpt(chunk.text),
      });
    });
  }
  return {
    schemaVersion: 1,
    documents: normalizedDocs,
    chunks,
  };
}

function formatDocumentQueryIndexForPrompt(index = {}) {
  const documents = Array.isArray(index.documents) ? index.documents : [];
  const chunks = Array.isArray(index.chunks) ? index.chunks : [];
  if (!documents.length || !chunks.length) return "";
  const lines = [
    "[Document Query Index]",
    "Use chunk ids, document labels, and source paths when citing uploaded document evidence. This is a lightweight index over already extracted text, not a separate retrieval tool; verify claims against shown excerpts or extracted text.",
    "Documents:",
    ...documents.map((doc) => `- ${doc.id}: ${doc.label}${doc.path ? ` — ${doc.path}` : ""}${doc.charLength ? ` (${doc.charLength} chars)` : ""}`),
    "Chunks:",
  ];
  for (const chunk of chunks.slice(0, MAX_PROMPT_CHUNKS)) {
    lines.push(
      `- ${chunk.chunkId} (${chunk.label}${chunk.heading ? `, ${chunk.heading}` : ""}, chars ${chunk.charStart}-${chunk.charEnd}): ${chunk.excerpt}`,
    );
  }
  if (chunks.length > MAX_PROMPT_CHUNKS) {
    lines.push(`- ${chunks.length - MAX_PROMPT_CHUNKS} additional chunks omitted from prompt index.`);
  }
  lines.push("[End Document Query Index]");
  return lines.join("\n");
}

module.exports = {
  buildDocumentQueryIndex,
  formatDocumentQueryIndexForPrompt,
};
