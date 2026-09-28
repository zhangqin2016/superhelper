"use strict";

/**
 * What the model actually touched this turn, for the answer-evidence gate:
 * the text its tools returned, and whether any tool call named one of the
 * user's input files. Extracted from answer-evidence-finalizer.js (architecture
 * ratchet).
 */

function toolEvidenceText(tools = []) {
  const chunks = [];
  for (const tool of tools) {
    const result = tool?.result;
    if (typeof result === "string") chunks.push(result);
    else if (result && typeof result.output === "string") chunks.push(result.output);
    else if (Array.isArray(result?.content)) {
      chunks.push(result.content.map((item) => (item && typeof item.text === "string" ? item.text : "")).join(" "));
    } else if (typeof tool?.content === "string") chunks.push(tool.content);
    else if (typeof tool?.output === "string") chunks.push(tool.output);
    else {
      try { chunks.push(JSON.stringify(result ?? tool?.content ?? tool?.output ?? "")); } catch { /* ignore */ }
    }
  }
  return chunks.filter(Boolean).join("\n").slice(0, 40_000);
}

/** A tool call this turn whose input names one of the user's input files. */
function toolTouchedInputFile(tools = [], inputFiles = []) {
  const names = (Array.isArray(inputFiles) ? inputFiles : [])
    .flatMap((file) => [file?.path, file?.name, file?.filename, typeof file === "string" ? file : ""])
    .map((value) => String(value || "").trim())
    .flatMap((value) => [value, value.split(/[\\/]/).pop()])
    .filter((value) => value.length >= 3);
  if (!names.length) return false;
  return (Array.isArray(tools) ? tools : []).some((tool) => {
    let input = "";
    try { input = JSON.stringify(tool?.input ?? tool?.args ?? tool?.arguments ?? ""); } catch { input = ""; }
    return names.some((name) => input.includes(name));
  });
}

module.exports = { toolEvidenceText, toolTouchedInputFile };
