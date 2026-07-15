import { t, getLocale } from "../i18n/index.js";

// Renders the "🧠 记忆 N" chip in a sealed assistant turn's header, showing which
// memories the turn actually used (hover for the list + recall mode). Purely
// reflects liveTurn.memoryUsage (built server-side, fail-open null) — never
// affects the answer. Idempotent: reused across re-renders, removed when absent.

function itemLabel(item) {
  return getLocale() === "zh-CN" ? item.label : (item.labelEn || item.label);
}

function scopeWord(scope) {
  return t(scope === "session" ? "turn.memory.scopeSession" : "turn.memory.scopeWorkspace");
}

function buildTooltip(usage) {
  const mode = t(usage.mode === "semantic" ? "turn.memory.semantic" : "turn.memory.lexical");
  const lines = [t("turn.memory.tooltipHeader", { count: usage.count, mode })];
  for (const item of usage.items || []) {
    const src = item.source ? ` · ${item.source}` : "";
    lines.push(`• ${itemLabel(item)} (${scopeWord(item.scope)})${src}`);
  }
  if (usage.truncated) lines.push("…");
  return lines.join("\n");
}

export function renderTurnMemoryChip(header, liveTurn) {
  if (!header) return null;
  const usage = liveTurn?.memoryUsage;
  const sealed = Boolean(liveTurn?.final);
  const existing = header.querySelector('[data-role="memory-chip"]');
  // Only on sealed turns that actually used memory; otherwise drop any stale chip.
  if (!usage || !usage.used || !usage.count || !sealed) {
    if (existing) existing.remove();
    return null;
  }
  const chip = existing || document.createElement("span");
  if (!existing) {
    chip.dataset.role = "memory-chip";
    header.append(chip);
  }
  chip.className = `assistant-turn-memory-chip${usage.mode === "semantic" ? " is-semantic" : ""}`;
  const sig = `${getLocale()}|${usage.count}|${usage.mode}|${(usage.items || []).length}`;
  if (chip.dataset.sig !== sig) {
    chip.textContent = t("turn.memory.chip", { count: usage.count });
    chip.title = buildTooltip(usage);
    chip.dataset.sig = sig;
  }
  return chip;
}
