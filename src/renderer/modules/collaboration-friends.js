import { t } from "../i18n/index.js";

export function renderCollaborationFriends(node, relationships = []) {
  if (!node) return;
  node.replaceChildren();
  const rows = Array.isArray(relationships) ? relationships : [];
  if (rows.length === 0) { const empty = document.createElement("p"); empty.className = "collaboration-empty"; empty.textContent = t("collaboration.noFriends"); node.append(empty); return; }
  for (const relationship of rows) { const row = document.createElement("p"); row.textContent = String(relationship.displayName || relationship.peerUserId || ""); node.append(row); }
}
