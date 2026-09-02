import { t, onLocaleChange } from "../i18n/index.js";
import { draftReplyPreview, replyDisplay } from "./collaboration-reply-view.js";
import { initCollaborationMentions } from "./collaboration-mentions.js";

function commandId() { return globalThis.crypto?.randomUUID?.() || `collab-${Date.now()}-${Math.random().toString(16).slice(2)}`; }
function draftIntent(value = {}) { return { text: String(value.text || ""), replyToMessageId: value.replyToMessageId || null, mentionUserIds: [...new Set(value.mentionUserIds || [])].sort() }; }
function sameIntent(a, b) { return Boolean(a && b) && a.text === b.text && a.replyToMessageId === b.replyToMessageId && JSON.stringify(a.mentionUserIds) === JSON.stringify(b.mentionUserIds); }
const activeComposerByTextarea = new WeakMap();

const TYPING_THROTTLE_MS = 3_000;

export function initCollaborationComposer({ textarea, sendButton, getConversationId, getReplySourceStatus = () => null, onSent = () => {}, onError = () => {} } = {}) {
  if (!textarea || !sendButton) return { setConversation: () => {}, destroy: () => {} };
  activeComposerByTextarea.get(textarea)?.destroy?.();
  let conversationId = "";
  const drafts = new Map(), sending = new Map(), intents = new Map();
  let disposed = false, active = true, editVersion = 0, generation = 0, selectionVersion = 0, previewVersion = 0;
  let editTarget = null;
  let previewValue = { status: "unavailable" };
  let preview = textarea.parentElement?.querySelector("#collaborationReplyPreview");
  if (!preview && textarea.ownerDocument && textarea.before) { preview = textarea.ownerDocument.createElement("div"); preview.id = "collaborationReplyPreview"; textarea.before(preview); }
  preview?.classList.add("collaboration-reply-preview");
  preview?.setAttribute("aria-live", "polite");
  const api = () => window.assistantClient?.collaboration;
  const currentIntent = () => draftIntent({ ...drafts.get(conversationId), text: textarea.value });
  const mentions = initCollaborationMentions({ textarea, getIds: () => currentIntent().mentionUserIds, onChange: ({ text, mentionUserIds }) => {
    if (disposed || !active || !conversationId) return;
    const value = { ...currentIntent(), text, mentionUserIds };
    textarea.value = text; editVersion += 1; saveDraft(conversationId, value); mentions.update(); refreshReply();
  } });
  const current = (id, epoch, selection, version) => !disposed && active && conversationId === id && generation === epoch && selectionVersion === selection && editVersion === version;
  const updateButton = () => { sendButton.disabled = !active || !conversationId || sending.has(conversationId); };
  const paintPreview = () => {
    if (!preview) return;
    const replyId = currentIntent().replyToMessageId;
    preview.hidden = !active || !conversationId || !replyId;
    if (preview.hidden) { preview.replaceChildren(); return; }
    let label = preview.querySelector(".collaboration-reply-label"), content = preview.querySelector(".collaboration-reply-content"), clear = preview.querySelector('[data-action="clear-reply"]');
    if (!label) { label = document.createElement("small"); label.className = "collaboration-reply-label"; preview.append(label); }
    label.textContent = t("collaboration.reply.preview");
    if (!content) { content = document.createElement("span"); content.className = "collaboration-reply-content"; content.dir = "auto"; preview.append(content); }
    const text = replyDisplay(previewValue); if (content.textContent !== text) content.textContent = text;
    if (!clear) { clear = document.createElement("button"); clear.type = "button"; clear.dataset.action = "clear-reply"; preview.append(clear); }
    clear.textContent = t("collaboration.reply.clear"); clear.setAttribute("aria-label", t("collaboration.reply.clear"));
    const id = conversationId, epoch = generation, selection = selectionVersion;
    clear.onclick = () => {
      if (!disposed && active && id === conversationId && epoch === generation && selection === selectionVersion && currentIntent().replyToMessageId === replyId && clear.parentElement === preview && preview.isConnected && !preview.closest("[hidden]")) setReply({ messageId: null });
    };
  };
  const saveDraft = (id, value) => {
    if (!id || disposed) return;
    const intent = draftIntent(value), epoch = generation, selection = selectionVersion, version = editVersion;
    drafts.set(id, intent);
    // Invoke before a possible same-task send, preserving preload IPC order.
    let result;
    try { result = api()?.saveDraft?.({ conversationId: id, ...intent }); }
    catch (error) { if (current(id, epoch, selection, version)) onError(error); return; }
    void Promise.resolve(result).then((result) => {
      if (result?.ok === false && current(id, epoch, selection, version)) onError(new Error(result.code));
    }).catch((error) => { if (current(id, epoch, selection, version)) onError(error); });
  };
  const refreshReply = (messages) => {
    const id = conversationId, epoch = generation, selection = selectionVersion, version = editVersion, replyId = currentIntent().replyToMessageId;
    const request = ++previewVersion;
    if (!active || disposed || !id || !replyId) { paintPreview(); return; }
    const sourceStatus = getReplySourceStatus(id, replyId);
    if (sourceStatus) { previewValue = { status: sourceStatus }; paintPreview(); return; }
    const source = messages?.find((message) => message.id === replyId && message.conversationId === id);
    if (source) { previewValue = draftReplyPreview(source); paintPreview(); return; }
    // Never leave the prior selection's body visible while reading this ID.
    previewValue = { status: "unavailable" }; paintPreview();
    const isCurrent = () => current(id, epoch, selection, version) && request === previewVersion && currentIntent().replyToMessageId === replyId;
    void Promise.resolve().then(() => isCurrent() ? api()?.readMessages?.({ conversationId: id, messageIds: [replyId] }) : null).then((result) => {
      if (!isCurrent()) return;
      const message = result?.ok && !result.unavailableMessageIds?.includes(replyId) ? result.messages?.find((row) => row.id === replyId && row.conversationId === id) : null;
      const status = getReplySourceStatus(id, replyId);
      previewValue = status ? { status } : draftReplyPreview(message); paintPreview();
    }).catch(() => { if (isCurrent()) { previewValue = { status: "unavailable" }; paintPreview(); } });
  };
  function setReply({ messageId } = {}) {
    if (disposed || !active || !conversationId) return;
    const value = currentIntent(); value.replyToMessageId = messageId || null;
    editVersion += 1;
    saveDraft(conversationId, value); refreshReply();
  }
  const restoreDraft = () => {
    const id = conversationId, epoch = generation, selection = selectionVersion, version = editVersion;
    if (!id || !active || drafts.has(id)) { refreshReply(); return; }
    let result;
    try { result = api()?.getDraft?.(id); }
    catch (error) { if (current(id, epoch, selection, version)) onError(error); return; }
    void Promise.resolve(result).then((result) => {
      if (!current(id, epoch, selection, version) || !result?.ok) return;
      const intent = draftIntent(result); drafts.set(id, intent); textarea.value = intent.text; mentions.update(); mentions.refresh(); refreshReply();
    }).catch((error) => { if (current(id, epoch, selection, version)) onError(error); });
  };
  const send = async () => {
    const id = conversationId, epoch = generation, selection = selectionVersion;
    const value = currentIntent();
    if (disposed || !active || !id || !value.text.trim() || sending.has(id)) return;
    drafts.set(id, value);
    const prior = intents.get(id);
    const intent = sameIntent(prior?.value, value) ? prior : { value, clientCommandId: commandId() };
    intents.set(id, intent); sending.set(id, intent); updateButton();
    try {
      const editing = editTarget && editTarget.conversationId === id && editTarget.messageId ? editTarget : null;
      const result = editing
        ? await api()?.edit?.({ conversationId: id, messageId: editing.messageId, clientCommandId: intent.clientCommandId, expectedRevision: editing.baseRevision, bodyText: value.text })
        : await api()?.send?.({ conversationId: id, clientCommandId: intent.clientCommandId, bodyText: value.text, replyToMessageId: value.replyToMessageId, mentionUserIds: [...value.mentionUserIds] });
      if (!result?.ok) throw new Error(result?.code || "COLLABORATION_UNAVAILABLE");
      if (disposed || epoch !== generation || intents.get(id) !== intent) return;
      intents.delete(id);
      if (editing && editTarget === editing) editTarget = null;
      // Main clears only the complete submitted intent. A newer draft belongs
      // to the user, even when its body is identical and only its reply changed.
      const visibleMatches = conversationId === id && sameIntent(currentIntent(), value);
      if (sameIntent(drafts.get(id), value)) drafts.set(id, draftIntent());
      if (visibleMatches) {
        textarea.value = ""; drafts.set(id, draftIntent()); editVersion += 1; mentions.update(); refreshReply();
      }
      if (active && conversationId === id && selection === selectionVersion) onSent(result, { conversationId: id });
    } catch (error) { if (!disposed && active && epoch === generation && conversationId === id && selection === selectionVersion) onError(error); }
    finally { if (epoch === generation && sending.get(id) === intent) { sending.delete(id); if (!disposed) updateButton(); } }
  };
  // Typing is a hint, so it is throttled to one frame per TYPING_THROTTLE_MS
  // rather than one per keystroke, and never awaited: a failed publish must not
  // affect the draft or the send path.
  let lastTypingAt = 0;
  const publishTyping = () => {
    const id = String(conversationId || "");
    if (!id) return;
    const at = Date.now();
    if (at - lastTypingAt < TYPING_THROTTLE_MS) return;
    lastTypingAt = at;
    try { void window.assistantClient?.collaboration?.typing?.(id)?.catch?.(() => {}); }
    catch { /* hint channel only */ }
  };
  const input = () => {
    if (disposed || !active) return;
    editVersion += 1; saveDraft(conversationId, currentIntent()); refreshReply(); mentions.input();
    if (textarea.value.trim()) publishTyping();
  };
  const keydown = (event) => {
    if (mentions.handleKeydown(event)) return;
    if (event.key !== "Enter" || event.shiftKey || event.isComposing || event.keyCode === 229) return;
    event.preventDefault(); void send();
  };
  const click = () => void send();
  const forgetConversation = (id) => {
    drafts.delete(id); intents.delete(id); sending.delete(id);
    if (id === conversationId) { conversationId = ""; textarea.value = ""; selectionVersion += 1; editVersion += 1; previewVersion += 1; mentions.setContext("", active); updateButton(); paintPreview(); }
  };
  sendButton.addEventListener("click", click); textarea.addEventListener("input", input); textarea.addEventListener("keydown", keydown);
  const unsubscribeLocale = onLocaleChange(() => { textarea.placeholder = t("collaboration.messagePlaceholder"); paintPreview(); });
  paintPreview(); updateButton();
  const controller = {
    setConversation(nextId) {
      const id = String(nextId ?? getConversationId?.() ?? "");
      if (disposed || id === conversationId) return;
      if (conversationId && (drafts.has(conversationId) || textarea.value)) drafts.set(conversationId, currentIntent());
      conversationId = id; selectionVersion += 1; editVersion += 1; previewVersion += 1; editTarget = null;
      textarea.value = drafts.get(id)?.text || ""; previewValue = { status: "unavailable" };
      mentions.setContext(id, active);
      textarea.placeholder = t("collaboration.messagePlaceholder"); updateButton(); paintPreview(); restoreDraft();
    },
    setReply, refreshReply, refreshMentionCandidates: () => mentions.refresh(),
    beginEdit({ conversationId: cid, messageId, baseRevision, bodyText } = {}) {
      if (disposed || !cid || !messageId) return;
      conversationId = String(cid); selectionVersion += 1; editVersion += 1; previewVersion += 1;
      textarea.value = String(bodyText || ""); textarea.placeholder = t("collaboration.edit.placeholder");
      editTarget = { conversationId: String(cid), messageId, baseRevision: Number(baseRevision) || 1 };
      mentions.setContext(conversationId, active); updateButton(); paintPreview(); textarea.focus?.();
    },
    clearEdit() { if (!editTarget) return; editTarget = null; textarea.placeholder = t("collaboration.messagePlaceholder"); },
    setActive(value) {
      if (disposed || active === Boolean(value)) return;
      active = Boolean(value); selectionVersion += 1; editVersion += 1; previewVersion += 1;
      mentions.setContext(conversationId, active);
      updateButton(); paintPreview(); if (active) restoreDraft();
    },
    forgetConversation,
    retainConversations(ids) { const allowed = new Set(ids); for (const id of new Set([...drafts.keys(), ...intents.keys(), ...sending.keys(), conversationId])) if (id && !allowed.has(id)) forgetConversation(id); },
    reset() { generation += 1; selectionVersion += 1; editVersion += 1; previewVersion += 1; drafts.clear(); intents.clear(); sending.clear(); conversationId = ""; editTarget = null; textarea.value = ""; textarea.placeholder = t("collaboration.messagePlaceholder"); mentions.reset(); updateButton(); paintPreview(); },
    destroy() { disposed = true; generation += 1; previewVersion += 1; drafts.clear(); intents.clear(); sending.clear(); mentions.destroy(); preview?.replaceChildren(); if (preview) preview.hidden = true; unsubscribeLocale(); sendButton.removeEventListener("click", click); textarea.removeEventListener("input", input); textarea.removeEventListener("keydown", keydown); if (activeComposerByTextarea.get(textarea) === controller) activeComposerByTextarea.delete(textarea); },
  };
  activeComposerByTextarea.set(textarea, controller);
  return controller;
}
