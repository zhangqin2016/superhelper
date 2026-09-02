import { t } from "../i18n/index.js";

const label = (key) => t(`collaboration.transfer.${key}`);
const node = (tag, text = "", className = "") => { const value = document.createElement(tag); value.textContent = text; value.className = className; return value; };
const terminal = (state) => ["verified", "bound", "ready", "cancelled"].includes(state);

/** Presentation only: all file paths, authorization, durable send identities
 * and retry decisions remain in the account-scoped main process. */
export function initCollaborationAttachments({ root, attachButton, api = window.assistantClient?.collaboration } = {}) {
  if (!root || !attachButton) return { setConversation() {}, setPolicy() {}, dismiss() {}, reset() {}, destroy() {}, refresh: async () => {}, download: async () => {} };
  let conversation = null, policy = {}, epoch = 0, refreshVersion = 0, disposed = false;
  let transfers = [], selected = new Set(), confirmationIds = null, confirmationOpener = null;
  const busy = new Set();
  const status = node("p", "", "collaboration-status"); status.setAttribute("role", "status");
  const recoveryStatus = node("p", "", "collaboration-status"); recoveryStatus.setAttribute("role", "status"); recoveryStatus.hidden = true;
  const list = node("div", "", "collaboration-transfers");
  const confirmation = node("div", "", "collaboration-confirmation");
  const sendButton = node("button", label("sendSelected")); sendButton.type = "button"; sendButton.dataset.action = "send-selected";
  root.append(status, recoveryStatus, list, sendButton, confirmation);
  const current = (generation) => !disposed && epoch === generation && Boolean(conversation);
  const errorLabel = (result) => result?.code === "COLLAB_MESSAGE_CANCELLATION_REQUIRED" ? "messageCancellation"
    : result?.code === "COLLAB_TRANSFER_DESTINATION_EXISTS" ? "destinationExists"
    : /ACCESS_REVOKED|FORBIDDEN|UNAVAILABLE/.test(result?.code || "") ? "permissionDenied" : "failed";
  const selectable = (item) => item.direction === "upload" && !item.sendState && item.state !== "cancelled" && item.purpose === "attachment";
  function clearConfirmation(restoreFocus = true) {
    const opener = confirmationOpener;
    confirmationIds = null; confirmationOpener = null; confirmation.replaceChildren(); confirmation.removeAttribute("role");
    if (opener && restoreFocus) {
      const target = [opener, attachButton].find((button) => button.isConnected && !button.disabled && !button.hidden && button.getClientRects().length);
      target?.focus();
    }
  }
  function controls() {
    attachButton.hidden = !policy.attachments;
    attachButton.disabled = !conversation || busy.has("pick");
    sendButton.hidden = !policy.attachments || !transfers.some(selectable);
    sendButton.disabled = selected.size === 0 || selected.size > 20 || busy.has("send");
    root.hidden = !policy.attachments && !policy.workspaceShares;
  }
  function action(row, name, key, operation) {
    const button = node("button", label(key)); button.type = "button"; button.dataset.action = name;
    button.disabled = busy.has(row.dataset.transferId);
    button.addEventListener("click", () => { void run(row.dataset.transferId, operation); }); row.append(button);
  }
  function previewAction(row, transferId) {
    const button = node("button", label("preview")); button.type = "button"; button.dataset.action = "preview-download";
    button.addEventListener("click", () => { void openPreview(transferId); });
    row.append(button);
  }
  // Thumbnails in message bubbles ask by objectId, which is what a message
  // carries; only a FINISHED download exposes plaintext, so this returns null
  // until then and the bubble shows its name/size chip instead.
  const previewCache = new Map();
  function readyDownload(objectId) {
    return transfers.find((item) => item.objectId === objectId && item.direction === "download" && item.state === "ready") || null;
  }
  async function resolvePreviewByObject(objectId) {
    if (!objectId || !policy.attachments || disposed) return null;
    if (previewCache.has(objectId)) return previewCache.get(objectId);
    const transfer = readyDownload(objectId);
    // Deliberately NOT cached: the download may finish later, and a cached
    // null here would keep the thumbnail missing for the rest of the session.
    if (!transfer) return null;
    let resolved; try { resolved = await api?.resolveTransferPreview?.(transfer.id); } catch { resolved = null; }
    const value = resolved?.ok === true && typeof resolved.url === "string" && resolved.url
      && String(resolved.mimeType || "").startsWith("image/")
      ? { url: resolved.url, mimeType: String(resolved.mimeType), originalName: String(resolved.originalName || "") }
      : null;
    previewCache.set(objectId, value);
    return value;
  }
  async function openPreview(transferId) {
    let resolved; try { resolved = await api?.resolveTransferPreview?.(transferId); } catch { resolved = null; }
    if (resolved?.ok !== true || !resolved.url) return;
    const mime = String(resolved.mimeType || "");
    if (!mime.startsWith("image/")) return;
    const viewer = await import("./image-viewer.js");
    viewer.openImageViewer?.(resolved.url, resolved.originalName || t("collaboration.transfer.preview"));
  }
  function render() {
    const focused = document.activeElement;
    const focusId = focused?.closest?.("[data-transfer-id]")?.dataset.transferId, focusAction = focused?.dataset.action;
    list.replaceChildren();
    for (const item of transfers) {
      const row = node("article", "", "collaboration-transfer"); row.dataset.transferId = item.id;
      const name = item.originalName || label("attachment");
      row.append(node("strong", name), node("small", label(item.state)));
      if (item.sendState) row.append(node("small", label(["failed", "paused"].includes(item.sendState) ? `message_${item.sendState}` : item.sendState)));
      if (Number.isSafeInteger(item.totalBytes)) row.append(node("small", `${item.totalBytes.toLocaleString()} ${label("bytes")}`));
      if (item.completedParts > 0) row.append(node("small", `${label("completedParts")}: ${item.completedParts}`));
      if (selectable(item)) {
        const wrapper = node("label", label("select"));
        const checkbox = document.createElement("input"); checkbox.type = "checkbox"; checkbox.checked = selected.has(item.id);
        checkbox.dataset.action = "select-transfer";
        checkbox.addEventListener("change", () => { checkbox.checked ? selected.add(item.id) : selected.delete(item.id); clearConfirmation(); controls(); });
        wrapper.prepend(checkbox); row.append(wrapper);
      }
      if (!terminal(item.state)) {
        if (item.automaticRetry) action(row, "pause-transfer", "pause", () => api.pauseTransfer(item.id));
        else action(row, "resume-transfer", "resume", () => api.enqueueTransfer(item.id));
      }
      if (item.state !== "cancelled") action(row, "cancel-transfer", "cancel", () => api.cancelTransfer(item.id));
      if (item.direction === "download" && item.state === "ready") {
        action(row, "save-download", "save", () => api.saveDownload(item.id));
        previewAction(row, item.id);
      }
      if (item.code) row.append(node("small", label(errorLabel(item))));
      list.append(row);
    }
    controls();
    if (focusId && focusAction) [...list.children].find((row) => row.dataset.transferId === focusId)?.querySelector(`[data-action="${focusAction}"]`)?.focus();
  }
  async function refresh() {
    if (!conversation || disposed) return;
    if (!policy.attachments && !policy.workspaceShares) {
      transfers = []; selected.clear(); clearConfirmation(false); status.textContent = ""; recoveryStatus.textContent = ""; recoveryStatus.hidden = true; render(); return;
    }
    const generation = epoch, version = ++refreshVersion;
    let result; try { result = await api?.getTransfers?.(); } catch { result = null; }
    if (!current(generation) || version !== refreshVersion) return;
    const recoveryBlocked = Boolean((policy.attachments || policy.workspaceShares) && result?.ok && (result.recoveryFailureCount > 0 || result.unrecognizedCount > 0));
    recoveryStatus.textContent = recoveryBlocked ? label("recoveryBlocked") : ""; recoveryStatus.hidden = !recoveryBlocked;
    if (!result?.ok) { transfers = []; selected.clear(); clearConfirmation(); render(); status.textContent = label("unavailable"); return; }
    transfers = (result.transfers || []).filter((item) => item.conversationId === conversation.id
      && (item.purpose === "attachment" ? policy.attachments : policy.workspaceShares));
    const eligible = new Set(transfers.filter(selectable).map((item) => item.id));
    selected = new Set([...selected].filter((id) => eligible.has(id)));
    if (confirmationIds?.some((id) => !eligible.has(id))) clearConfirmation();
    render();
  }
  async function run(key, operation) {
    if (!conversation || disposed || busy.has(key)) return;
    const generation = epoch; busy.add(key); controls(); render();
    try {
      const result = await operation();
      if (!current(generation)) return;
      status.textContent = label(!result?.ok ? errorLabel(result) : result.saved ? "saved" : result.cancelled ? "cancelled" : result.state || "updated");
      await refresh();
      return result;
    } catch { if (current(generation)) status.textContent = label("failed"); }
    finally { if (current(generation)) { busy.delete(key); render(); } }
  }
  const pick = async () => {
    if (!conversation || !policy.attachments) return;
    await run("pick", async () => {
      const generation = epoch, result = await api.prepareAttachment(conversation.id);
      if (current(generation) && result?.ok && result.id) selected.add(result.id);
      return result;
    });
  };
  const confirmSend = () => {
    if (!conversation || !policy.attachments || busy.has("send") || !selected.size || selected.size > 20) return;
    clearConfirmation();
    const ids = transfers.filter((item) => selected.has(item.id) && selectable(item)).map((item) => item.id);
    if (!ids.length) return;
    confirmationIds = ids;
    confirmationOpener = sendButton;
    const generation = epoch, conversationId = conversation.id;
    confirmation.setAttribute("role", "dialog"); confirmation.setAttribute("aria-modal", "false"); confirmation.setAttribute("aria-label", label("confirmSend"));
    confirmation.append(node("p", `${label("confirmSend")} · ${conversation.title || conversation.id} · ${conversation.scopeId}`));
    for (const id of ids) confirmation.append(node("p", transfers.find((item) => item.id === id).originalName || label("attachment")));
    const captionLabel = node("label", label("caption")), caption = document.createElement("textarea");
    caption.name = "attachmentCaption"; caption.dir = "auto"; caption.maxLength = 32768; captionLabel.append(caption); confirmation.append(captionLabel);
    const yes = node("button", label("confirmSend")); yes.type = "button"; yes.dataset.action = "confirm-send";
    const no = node("button", label("cancel")); no.type = "button"; no.addEventListener("click", () => clearConfirmation());
    yes.addEventListener("click", async () => {
      if (!current(generation) || busy.has("send") || confirmationIds !== ids) return;
      yes.disabled = true; no.disabled = true;
      const result = await run("send", () => api.sendAttachments({ conversationId, transferIds: ids, bodyText: caption.value }));
      if (!current(generation)) return;
      if (result?.ok) { for (const id of ids) selected.delete(id); clearConfirmation(); }
      else { yes.disabled = false; no.disabled = false; }
      controls();
    });
    confirmation.append(yes, no); caption.focus();
  };
  const escape = (event) => { if (event.key === "Escape" && !busy.has("send")) { event.preventDefault(); clearConfirmation(); } };
  confirmation.addEventListener("keydown", escape);
  attachButton.addEventListener("click", pick); sendButton.addEventListener("click", confirmSend);
  function reset() {
    epoch += 1; refreshVersion += 1; conversation = null; transfers = []; selected.clear(); busy.clear(); clearConfirmation(false); status.textContent = ""; recoveryStatus.textContent = ""; recoveryStatus.hidden = true;
    // Preview URLs are scoped to a conversation's transfers: keeping them
    // across a switch would point a bubble at another conversation's file.
    previewCache.clear();
    render();
  }
  controls();
  return {
    refresh,
    dismiss() { epoch += 1; refreshVersion += 1; busy.clear(); clearConfirmation(false); render(); },
    setPolicy(nextPolicy = {}) {
      if (policy.attachments === nextPolicy.attachments && policy.workspaceShares === nextPolicy.workspaceShares) return;
      const previous = conversation;
      reset(); policy = nextPolicy; conversation = previous; controls(); void refresh();
    },
    setConversation(value, nextPolicy = {}) {
      if (disposed) return;
      if (conversation?.id !== value?.id || conversation?.scopeId !== value?.scopeId || policy.attachments !== nextPolicy.attachments || policy.workspaceShares !== nextPolicy.workspaceShares) reset();
      conversation = value || null; policy = nextPolicy; controls(); void refresh();
    },
    resolvePreview(objectId) { return resolvePreviewByObject(objectId); },
    openPreview(objectId) {
      const transfer = readyDownload(objectId);
      return transfer ? openPreview(transfer.id) : Promise.resolve();
    },
    download(input, purpose = "attachment") {
      if (!conversation || input?.conversationId !== conversation.id || !(purpose === "attachment" ? policy.attachments : purpose === "workspace" && policy.workspaceShares)) return Promise.resolve();
      return run(`download:${input.messageId}:${input.objectId}`, async () => {
        const generation = epoch, prepared = await api.prepareDownload(input);
        if (!current(generation) || !prepared?.ok || !prepared.id) return prepared;
        return prepared.state === "ready" ? prepared : api.enqueueTransfer(prepared.id);
      });
    },
    reset,
    destroy() { reset(); disposed = true; attachButton.removeEventListener("click", pick); sendButton.removeEventListener("click", confirmSend); confirmation.removeEventListener("keydown", escape); },
  };
}
