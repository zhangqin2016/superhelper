"use strict";

function compactCommand(input = {}) {
  return String(input.command || input.cmd || input.script || "").trim();
}

function isBackgroundActivityEvent(ev) {
  const marker = `${ev?.type || ""}:${ev?.subtype || ""}`.toLowerCase();
  return (
    marker.includes("task_") ||
    marker === "system:status" ||
    marker.includes("background") ||
    marker.includes("workflow") ||
    marker.includes("agent")
  );
}

function isBackgroundCompletionEvent(ev) {
  const subtype = String(ev?.subtype || "");
  return (
    subtype.endsWith("_complete") ||
    subtype.endsWith("_completed") ||
    subtype.endsWith("_failed")
  );
}

function isShellTool(name) {
  return /^(bash|shell|runcommand)$/i.test(String(name || ""));
}

function looksLikeLongRunningShellCommand(command) {
  const normalized = String(command || "")
    .replace(/\\\n/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
  if (!normalized) return false;

  const longRunningPatterns = [
    /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:dev|start|serve|preview|watch)\b/,
    /\b(?:vite|next|nuxt|astro|webpack-dev-server|webpack\s+serve)\b/,
    /\b(?:ng|vue-cli-service)\s+serve\b/,
    /\b(?:react-scripts|nodemon|ts-node-dev)\s+start\b/,
    /\b(?:python(?:3)?\s+-m\s+)?(?:uvicorn|gunicorn|flask|fastapi)\b.*\b(?:--reload|--host|--port)\b/,
    /\b(?:tail|less)\s+-(?:[a-z]*f|f[a-z]*)\b/,
    /\b(?:docker|podman)\s+logs\b.*\s-f\b/,
    /\bkubectl\s+logs\b.*\s-f\b/,
    /\bjournalctl\b.*\s-f\b/,
  ];

  return longRunningPatterns.some((pattern) => pattern.test(normalized));
}

function isDetachedShellInput(name, input = {}) {
  if (!isShellTool(name)) return false;
  const command = compactCommand(input);
  if (!command) return false;
  return /(?:^|\s)(?:nohup|setsid)\s+/i.test(command) ||
    /(?:^|\s)disown(?:\s|$)/i.test(command) ||
    /&\s*(?:>|2>|1>|$)/.test(command) ||
    looksLikeLongRunningShellCommand(command);
}

function backgroundActivityFromEvent(ev) {
  if (!isBackgroundActivityEvent(ev)) return null;
  return {
    kind: "background",
    short: isBackgroundCompletionEvent(ev),
    type: ev?.type || "",
    subtype: ev?.subtype || "",
  };
}

module.exports = {
  compactCommand,
  isBackgroundActivityEvent,
  isBackgroundCompletionEvent,
  isShellTool,
  isDetachedShellInput,
  looksLikeLongRunningShellCommand,
  backgroundActivityFromEvent,
};
