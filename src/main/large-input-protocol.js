"use strict";

const LARGE_INPUT_PROTOCOL_MARKER = "## Large Input Protocol";

const LARGE_INPUT_PROTOCOL_GUIDANCE = [
  LARGE_INPUT_PROTOCOL_MARKER,
  "",
  "For large files, large directories, unknown binaries, scanned documents, or inputs likely to exceed context, do not read or attach the entire input blindly.",
  "Use the lily_file_intelligence MCP tool inspect_file first. Then choose sample_file, extract_file_range, index, query, or summarize based on the user's goal and available tools.",
  "Be explicit about coverage and cite source locations. Do not claim full-file coverage from samples or partial ranges.",
  "If the Lily file intelligence tool is unavailable or fails, fall back to normal tools without blocking the task, and say what coverage was possible.",
].join("\n");

function appendLargeInputProtocolGuidance(guide) {
  const base = String(guide || "").trim();
  if (base.includes(LARGE_INPUT_PROTOCOL_MARKER)) return base;
  return [base, LARGE_INPUT_PROTOCOL_GUIDANCE].filter(Boolean).join("\n\n");
}

module.exports = {
  LARGE_INPUT_PROTOCOL_GUIDANCE,
  appendLargeInputProtocolGuidance,
};
