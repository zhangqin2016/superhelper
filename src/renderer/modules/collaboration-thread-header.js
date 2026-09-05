import { identityName, resolvePerson, conversationDisplayTitle } from "./collaboration-social-ui.js";

/** The open thread's title, by the same rule as every list row: the stored
 *  title, else the other member(s) — resolved first from the profiles the
 *  hydrated conversation carries, then from the directory — never the id. */
export function paintConversationTitle(node, conversation, directory) {
  if (!node) return;
  const profiles = Array.isArray(conversation?.profiles) ? conversation.profiles : [];
  node.textContent = conversationDisplayTitle(conversation, {
    currentUserId: directory?.profile?.userId || "",
    resolveName: (userId) => identityName(profiles.find((p) => p.userId === userId) || resolvePerson(directory, userId)),
  });
}
