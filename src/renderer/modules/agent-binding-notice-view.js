/**
 * In-conversation agent traces.
 *
 *  1. `appendAgentBindingNotice` — a compact platform card for a committed
 *     message carrying `meta.agentBinding` (activated / deactivated /
 *     replaced_by_role). The main process already rendered `content` as text
 *     (title line + bullet lines); the card shows the agent's icon/monogram,
 *     the title, and the bullets as a list. Platform status, not an assistant
 *     bubble: no duration, footer, retry or rewind controls.
 *  2. `decorateAgentAnswerLabel` — the "由智能体「X」回答" label on a sealed
 *     assistant article when `record.meta.agent` (or legacy `meta.agent`)
 *     says an agent answered. Never rendered without that field.
 */
import { t } from "../i18n/index.js";
import { agentIconGlyph, agentMonogram } from "./agent-library-model.js";

const KINDS = new Set(["activated", "deactivated", "replaced_by_role"]);
const MAX_LINES = 24;

export function agentBindingOf(message) {
  const binding = message?.meta?.agentBinding || message?.record?.meta?.agentBinding;
  return binding && typeof binding === "object" ? binding : null;
}

export function answeringAgentOf(message) {
  const agent = message?.record?.meta?.agent || message?.meta?.agent;
  if (!agent || typeof agent !== "object") return null;
  const name = typeof agent.name === "string" ? agent.name.trim() : "";
  if (!name) return null;
  return { id: typeof agent.id === "string" ? agent.id : "", name, icon: agentIconGlyph(agent.icon) };
}

function splitContent(content) {
  const lines = String(content || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const title = lines.shift() || "";
  const bullets = lines.slice(0, MAX_LINES).map((line) => line.replace(/^(?:[-*•·]|\d+[.)])\s*/, ""));
  return { title, bullets };
}

function avatarFor(binding) {
  const avatar = document.createElement("span");
  const icon = agentIconGlyph(binding.icon);
  avatar.className = `agent-binding-notice-avatar${icon ? " is-agent-icon" : ""}`;
  avatar.textContent = icon || agentMonogram(binding.name);
  avatar.setAttribute("aria-hidden", "true");
  return avatar;
}

export function appendAgentBindingNotice(listEl, message, beforeNode = null, key = "") {
  if (!listEl) return null;
  const binding = agentBindingOf(message);
  if (!binding) return null;
  const kind = KINDS.has(binding.kind) ? binding.kind : "activated";
  const article = document.createElement("article");
  article.className = `agent-binding-notice assistant-process-notice is-${kind}`;
  article.setAttribute("role", "status");
  article.dataset.agentBindingKind = kind;
  if (typeof binding.agentId === "string" && binding.agentId) article.dataset.agentId = binding.agentId;
  if (key) article.dataset.messageKey = key;

  const { title, bullets } = splitContent(message.content);
  const head = document.createElement("div");
  head.className = "agent-binding-notice-head";
  head.appendChild(avatarFor(binding));
  const titleEl = document.createElement("span");
  titleEl.className = "agent-binding-notice-title";
  titleEl.textContent = title || binding.name || "";
  head.appendChild(titleEl);
  article.appendChild(head);

  if (bullets.length) {
    const list = document.createElement("ul");
    list.className = "agent-binding-notice-lines";
    for (const line of bullets) {
      const item = document.createElement("li");
      item.textContent = line;
      list.appendChild(item);
    }
    article.appendChild(list);
  }
  if (beforeNode && listEl.contains(beforeNode)) listEl.insertBefore(article, beforeNode);
  else listEl.appendChild(article);
  return article;
}

/** Adds the "answered by agent" label to a sealed assistant article; no-op otherwise. */
export function decorateAgentAnswerLabel(article, message) {
  const agent = answeringAgentOf(message);
  if (!article || !agent) return null;
  const speaker = article.querySelector(".assistant-turn-speaker") || article;
  const label = document.createElement("span");
  label.className = "assistant-turn-agent-label";
  label.dataset.agentId = agent.id;
  const glyph = document.createElement("span");
  glyph.className = `assistant-turn-agent-glyph${agent.icon ? " is-agent-icon" : ""}`;
  glyph.textContent = agent.icon || agentMonogram(agent.name);
  glyph.setAttribute("aria-hidden", "true");
  const text = document.createElement("span");
  text.className = "assistant-turn-agent-text";
  text.textContent = t("message.answeredByAgent", { name: agent.name });
  label.append(glyph, text);
  label.title = text.textContent;
  speaker.appendChild(label);
  article.dataset.answeredByAgent = agent.id || "true";
  return label;
}
