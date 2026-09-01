import { t } from "../i18n/index.js";

function clear(node) { node?.replaceChildren(); }

export function renderCollaborationInbox(node, conversations = [], { onOpen = () => {}, teams = [] } = {}) {
  if (!node) return;
  clear(node);
  const rows = [...conversations].sort((a, b) => Number(b.lastSeq || 0) - Number(a.lastSeq || 0) || Number(b.updatedAt || 0) - Number(a.updatedAt || 0));
  if (rows.length === 0) {
    const empty = document.createElement("p");
    empty.className = "collaboration-empty";
    empty.textContent = t("collaboration.empty");
    node.append(empty);
    return;
  }
  for (const conversation of rows) {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "collaboration-inbox-item";
    item.dataset.conversationId = String(conversation.id || "");
    const scopeId = String(conversation.scopeId || "personal");
    const scope = scopeId.startsWith("team:") ? `${teams.find((team) => team.scopeId === scopeId)?.name || t("collaboration.scopeTeam")} · ${scopeId}` : t("collaboration.scopePersonal");
    item.textContent = `${conversation.title || conversation.id || ""} · ${scope}`;
    item.addEventListener("click", () => onOpen(String(conversation.id || "")));
    node.append(item);
  }
}
