import { t } from "../i18n/index.js";

function commandId() { return globalThis.crypto?.randomUUID?.() || `collab-${Date.now()}-${Math.random().toString(16).slice(2)}`; }

export function initCollaborationComposer({ textarea, sendButton, getConversationId, onSent = () => {}, onError = () => {} } = {}) {
  if (!textarea || !sendButton) return { setConversation: () => {}, destroy: () => {} };
  let conversationId = "";
  const drafts = new Map();
  const sending = new Set();
  const intents = new Map();
  let disposed = false;
  let editVersion = 0;
  let generation = 0;
  const api = () => window.assistantClient?.collaboration;
  const updateButton = () => { sendButton.disabled = !conversationId || sending.has(conversationId); };
  const saveDraft = (id, text) => {
    if (!id || disposed) return;
    drafts.set(id, text);
    void Promise.resolve(api()?.saveDraft?.({ conversationId: id, text })).then((result) => {
      if (result?.ok === false && !disposed) onError(new Error(result.code));
    }).catch((error) => { if (!disposed) onError(error); });
  };
  const send = async () => {
    const id = conversationId;
    const epoch = generation;
    const bodyText = textarea.value;
    if (disposed || !id || !bodyText.trim() || sending.has(id)) return;
    const prior = intents.get(id);
    const intent = prior?.bodyText === bodyText ? prior : { bodyText, clientCommandId: commandId() };
    intents.set(id, intent);
    sending.add(id);
    updateButton();
    try {
      const result = await window.assistantClient?.collaboration?.send?.({ conversationId: id, ...intent });
      if (!result?.ok) throw new Error(result?.code || "COLLABORATION_UNAVAILABLE");
      if (disposed || epoch !== generation) return;
      intents.delete(id);
      // Main cleared only the submitted draft in the enqueue transaction.
      // Neither a new edit nor another conversation belongs to this ACK.
      if (drafts.get(id) === bodyText) drafts.set(id, "");
      if (conversationId === id && textarea.value === bodyText) textarea.value = "";
      onSent(result, { conversationId: id });
    } catch (error) { if (!disposed && epoch === generation) onError(error); } finally { if (epoch === generation) { sending.delete(id); if (!disposed) updateButton(); } }
  };
  const input = () => { editVersion += 1; saveDraft(conversationId, textarea.value); };
  const keydown = (event) => {
    if (event.key !== "Enter" || event.shiftKey || event.isComposing || event.keyCode === 229) return;
    event.preventDefault();
    void send(); // Enter sends; Shift+Enter stays multiline.
  };
  const click = () => void send();
  sendButton.addEventListener("click", click);
  textarea.addEventListener("input", input);
  textarea.addEventListener("keydown", keydown);
  return {
    setConversation(nextId) {
      const id = String(nextId ?? getConversationId?.() ?? "");
      if (disposed || id === conversationId) return;
      conversationId = id;
      const version = ++editVersion;
      textarea.value = drafts.get(id) || "";
      textarea.placeholder = t("collaboration.messagePlaceholder");
      updateButton();
      if (!id || drafts.has(id)) return;
      void Promise.resolve(api()?.getDraft?.(id)).then((result) => {
        if (disposed || conversationId !== id || editVersion !== version || !result?.ok) return;
        textarea.value = String(result.text || "");
        drafts.set(id, textarea.value);
      }).catch((error) => { if (!disposed) onError(error); });
    },
    reset() { generation += 1; editVersion += 1; drafts.clear(); intents.clear(); sending.clear(); conversationId = ""; textarea.value = ""; updateButton(); },
    destroy() { disposed = true; drafts.clear(); intents.clear(); sendButton.removeEventListener("click", click); textarea.removeEventListener("input", input); textarea.removeEventListener("keydown", keydown); },
  };
}
