import { t } from "../i18n/index.js";
import { identityName, resolvePerson } from "./collaboration-social-ui.js";

export function renderCollaborationTypingHint({ node, state, conversationId, currentUserId, directory }) {
  if (!node) return;
  const ids = (conversationId && state?.typing?.[conversationId]) || [];
  const others = ids.filter((userId) => userId && userId !== currentUserId);
  if (!others.length) { node.hidden = true; node.textContent = ""; return; }
  const named = others.map((userId) => identityName(resolvePerson(directory, userId))).filter((name) => name && !/^usr_[a-z0-9]+$/i.test(name));
  node.textContent = others.length > 1
    ? t("collaboration.typing.many", { count: others.length })
    : (named[0] ? t("collaboration.typing.one", { name: named[0] }) : t("collaboration.typing.someone"));
  node.hidden = false;
}
