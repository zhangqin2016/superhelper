import { t } from "../i18n/index.js";
import { openContextMenu } from "./context-menu.js";
import { formatBytes } from "./format-bytes.js";
import { replyDisplay } from "./collaboration-reply-view.js";
import { avatarHue } from "./collaboration-social-ui.js";

function messageFingerprint(message) {
  const text = String(message.bodyText || "");
  let hash = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `${text.length}:${hash >>> 0}`;
}

function messageKeys(message) {
  const keys = [];
  const seq = Number(message.seq);
  const hasSeq = Number.isSafeInteger(seq) && seq > 0;
  const createdAt = Number(message.createdAt || message.clientCreatedAt || 0);
  const createdBucket = Number.isSafeInteger(createdAt) ? Math.max(0, Math.floor(createdAt / 1000)) : 0;
  const conversationId = String(message.conversationId || "");
  const sender = String(message.senderUserId || "");
  const replyTo = String(message.replyToMessageId || "");
  const mentionKey = Array.isArray(message.mentionUserIds) ? message.mentionUserIds.slice(0, 8).join(",") : "";
  const attachmentKey = Array.isArray(message.attachmentIds) ? message.attachmentIds.length : 0;
  const revision = Number(message.revision || 1);
  const id = String(message.id || "");
  const cc = String(message.clientCommandId || "");
  if (hasSeq) keys.push(`seq:${seq}`);
  if (id) keys.push(`id:${id}`);
  if (cc) keys.push(`cc:${cc}`);
  if (!keys.length) keys.push(`meta:${conversationId}:${sender}:${replyTo}:${mentionKey}:${createdBucket}:r${revision}:a${attachmentKey}:${messageFingerprint(message)}`);
  return keys;
}

function indexTimelineRows(rows = []) {
  const index = new Map();
  const set = new Set(rows);
  for (const row of rows) {
    for (const key of String(row.dataset.messageKeys || "").split(" ").filter(Boolean)) {
      if (!index.has(key)) index.set(key, row);
    }
  }
  return { index, set };
}

function resolveTimelineRow(rows = {}, message) {
  const messageRowKeys = messageKeys(message);
  const index = rows?.index || new Map();
  for (const key of messageRowKeys) {
    const row = index.get(key);
    if (row) return row;
  }
  return null;
}

function deliveryLabel(message) {
  if (message.state === "delivery_unknown") return { text: t("collaboration.deliveryUnknown"), tone: "warn" };
  if (message.state === "confirming" || message.state === "submitting") return { text: t("collaboration.confirming"), tone: "pending" };
  if (message.state === "failed" || message.state === "paused") return { text: t("collaboration.sendFailed"), tone: "error" };
  return null;
}

function dayKey(epoch) {
  const date = new Date(Number(epoch) || 0);
  if (Number.isNaN(date.getTime())) return "";
  return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
}

function timeLabel(epoch) {
  const at = new Date(Number(epoch) || 0);
  if (Number.isNaN(at.getTime())) return "";
  return new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" }).format(at);
}

function dayLabel(epoch) {
  const at = new Date(Number(epoch) || 0);
  if (Number.isNaN(at.getTime())) return "";
  const now = new Date();
  const start = (value) => new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime();
  const daySpan = 24 * 60 * 60 * 1000;
  const delta = start(now) - start(at);
  if (delta === 0) return t("collaboration.today");
  if (delta === daySpan) return t("collaboration.yesterday");
  if (at.getFullYear() === now.getFullYear()) return new Intl.DateTimeFormat(undefined, { month: "long", day: "numeric" }).format(at);
  return new Intl.DateTimeFormat(undefined, { year: "numeric", month: "long", day: "numeric" }).format(at);
}

// A small fixed set, like every mainstream messenger's default row.
/** Split `text` around every case-insensitive literal occurrence of `needle`. */
function highlightRuns(text, needle) {
  const haystack = String(text);
  const lowerHay = haystack.toLocaleLowerCase();
  const lowerNeedle = needle.toLocaleLowerCase();
  if (!lowerNeedle || !lowerHay.includes(lowerNeedle)) return null;
  const nodes = [];
  let cursor = 0;
  for (;;) {
    const hit = lowerHay.indexOf(lowerNeedle, cursor);
    if (hit < 0 || nodes.length > 200) break;
    if (hit > cursor) nodes.push(document.createTextNode(haystack.slice(cursor, hit)));
    const mark = document.createElement("mark");
    mark.className = "collaboration-search-hit";
    mark.textContent = haystack.slice(hit, hit + lowerNeedle.length);
    nodes.push(mark);
    cursor = hit + lowerNeedle.length;
  }
  if (cursor < haystack.length) nodes.push(document.createTextNode(haystack.slice(cursor)));
  return nodes;
}

const QUICK_REACTIONS = Object.freeze(["👍", "❤️", "😂", "🎉", "🙏"]);

const isDelivered = (message) => Boolean(message.id) && Number.isSafeInteger(Number(message.seq)) && Number(message.seq) > 0;

function sequence(message) {
  const value = Number(message.seq);
  return message.seq != null && Number.isSafeInteger(value) && value > 0 ? value : Infinity;
}

const SVG_NS = "http://www.w3.org/2000/svg";

/** A file or picture mark, drawn so it is the same on macOS and Windows. */
function attachmentGlyph(isImage) {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", "18");
  svg.setAttribute("height", "18");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.6");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  const path = (d) => { const node = document.createElementNS(SVG_NS, "path"); node.setAttribute("d", d); svg.append(node); };
  if (isImage) {
    path("M4 5.5h16v13H4z");
    // A horizon and a sun: reads as a picture at 18px, where a detailed mark does not.
    path("M4 15l4.5-4 3.5 3 3-2.5L20 15.5");
    const sun = document.createElementNS(SVG_NS, "circle");
    sun.setAttribute("cx", "9"); sun.setAttribute("cy", "9.5"); sun.setAttribute("r", "1.6");
    svg.append(sun);
  } else {
    path("M6 3.5h7l5 5v12H6z");
    path("M13 3.5v5h5");
  }
  return svg;
}

export function renderCollaborationTimeline(node, messages = [], { onDownload, canDownload = () => true, onReply, canReply = () => true, onEdit, canEdit = () => true, onRevoke, canRevoke = () => true, currentUserId = "", resolveSender = (id) => id, showSenderNames = true, peerReadSeq = 0, onReact, canReact = () => true, unreadFromSeq = 0, highlight = "", resolveAttachmentPreview = null, onPreview = null, onForward = null, selection = null, onDeleteLocal = null } = {}) {
  if (!node) return;
  node.classList.toggle("is-selecting", Boolean(selection?.isActive?.()));
  node.querySelectorAll(":scope > .collaboration-date-separator").forEach((el) => el.remove());
  const prior = indexTimelineRows([...node.children]);
  const atBottom = node.scrollHeight - node.scrollTop - node.clientHeight < 40;
  const viewportTop = node.getBoundingClientRect().top + node.clientTop;
  const anchor = [...node.children].find((child) => child.getBoundingClientRect().bottom > viewportTop);
  const anchorOffset = anchor ? anchor.getBoundingClientRect().top - viewportTop : 0;
  let index = 0;
  const ordered = [...messages].sort((a, b) => sequence(a) - sequence(b) || Number(a.createdAt || 0) - Number(b.createdAt || 0));
  let previous = null;
  for (const message of ordered) {
    const keyList = messageKeys(message);
    if (!keyList.length) continue;
    const createdAt = Number(message.createdAt || message.clientCreatedAt || 0);
    const previousAt = Number(previous?.createdAt || previous?.clientCreatedAt || 0);
    const seq = Number(message.seq);
    const crossesUnread = Number(unreadFromSeq) > 0 && Number.isSafeInteger(seq) && seq > 0
      && seq > Number(unreadFromSeq)
      && !(Number.isSafeInteger(Number(previous?.seq)) && Number(previous?.seq) > Number(unreadFromSeq));
    // A separator carries the time context, WeChat-style, so the bubbles do not
    // each repeat it: the day when the day changes, otherwise a bare HH:MM when
    // more than five minutes have passed since the previous message.
    const dayChanged = createdAt > 0 && previousAt > 0 && dayKey(createdAt) !== dayKey(previousAt);
    const bigGap = createdAt > 0 && previousAt > 0 && !dayChanged && createdAt - previousAt >= 5 * 60 * 1000;
    if (dayChanged || bigGap) {
      const separator = document.createElement("div");
      separator.className = "collaboration-date-separator";
      separator.setAttribute("role", "separator");
      const label = document.createElement("time");
      label.dateTime = new Date(createdAt).toISOString();
      label.textContent = dayChanged ? dayLabel(createdAt) : timeLabel(createdAt);
      separator.append(label);
      node.insertBefore(separator, node.children[index] || null);
      index += 1;
    }
    if (crossesUnread) {
      const marker = document.createElement("div");
      marker.className = "collaboration-unread-divider";
      marker.setAttribute("role", "separator");
      marker.textContent = t("collaboration.unreadDivider");
      node.insertBefore(marker, node.children[index] || null);
      index += 1;
    }
    const row = resolveTimelineRow(prior, message) || document.createElement("article");
    row.className = "collaboration-message";
    const outgoing = typeof message.isOwn === "boolean" ? message.isOwn : Boolean(currentUserId && message.senderUserId === currentUserId);
    row.classList.toggle("is-outgoing", outgoing);
    const previousOutgoing = typeof previous?.isOwn === "boolean" ? previous.isOwn : Boolean(currentUserId && previous?.senderUserId === currentUserId);
    const grouped = Boolean(previous && previousOutgoing === outgoing
      && (outgoing || previous.senderUserId === message.senderUserId) && createdAt > 0 && previousAt > 0 && createdAt - previousAt < 5 * 60 * 1000);
    row.classList.toggle("is-grouped", grouped);
    // 多选: while selecting, a row is a checkbox target and its own actions
    // stand down, so a click cannot both select and reply.
    const selecting = Boolean(selection?.isActive?.());
    row.classList.toggle("is-selectable", selecting);
    row.classList.toggle("is-selected", selecting && Boolean(message.id) && selection.has(message.id));
    row.onclick = selecting && message.id ? (event) => { event.preventDefault(); selection.toggle(message.id); } : null;
    row.dataset.messageKey = String(message.clientCommandId || message.id || keyList[0] || "");
    row.dataset.messageKeys = keyList.join(" ");
    row.dataset.clientCommandId = String(message.clientCommandId || "");
    const resolvedSender = String(resolveSender(message.senderUserId || "") || "");
    const senderName = /^usr_[a-z0-9]+$/i.test(resolvedSender) ? "" : resolvedSender;
    let avatar = row.querySelector(".collaboration-message-avatar");
    if (!avatar) { avatar = document.createElement("span"); avatar.className = "collaboration-message-avatar"; avatar.setAttribute("aria-hidden", "true"); row.prepend(avatar); }
    avatar.textContent = senderName.trim().slice(0, 1).toUpperCase() || "·";
    avatar.style.setProperty("--avatar-hue", String(avatarHue(senderName)));
    let bubble = row.querySelector(".collaboration-message-bubble");
    if (!bubble) { bubble = document.createElement("div"); bubble.className = "collaboration-message-bubble"; row.append(bubble); }
    let header = bubble.querySelector(".collaboration-message-header");
    if (!outgoing && showSenderNames && senderName && !grouped) {
      if (!header) { header = document.createElement("header"); header.className = "collaboration-message-header"; bubble.prepend(header); }
      let author = header.querySelector(".collaboration-message-author");
      if (!author) { author = document.createElement("strong"); author.className = "collaboration-message-author"; header.append(author); }
      author.textContent = senderName;
    } else header?.remove();
    // One meta line per bubble, bottom-right: time first, delivery tick after.
    // Anything the row used to position absolutely is removed on sight so an
    // upgraded session cannot keep a stale floating timestamp.
    row.querySelector(":scope > time.collaboration-message-time")?.remove();
    let meta = bubble.querySelector(":scope > .collaboration-message-meta");
    if (!meta) { meta = document.createElement("div"); meta.className = "collaboration-message-meta"; bubble.append(meta); }
    let time = meta.querySelector("time.collaboration-message-time");
    if (createdAt > 0) {
      if (!time) { time = document.createElement("time"); time.className = "collaboration-message-time"; meta.prepend(time); }
      time.dateTime = new Date(createdAt).toISOString();
      time.textContent = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" }).format(createdAt);
    } else time?.remove();
    let body = row.querySelector(".collaboration-message-body");
    if (!body) { body = document.createElement("p"); body.className = "collaboration-message-body"; bubble.append(body); }
    const hiddenSource = message.revokedAt || message.visibilityMask;
    const text = message.visibilityMask === "unavailable" ? t("collaboration.messageUnavailable") : hiddenSource ? t("collaboration.messageRevoked") : String(message.bodyText || "");
    // Search HIGHLIGHT, not just filtering: the list already hides non-matches,
    // but without marking the run the user cannot see why a message matched.
    // Built from text nodes plus <mark> elements only — no markup parsing at
    // all (the locale guard greps this file for such APIs) — so a body cannot
    // inject markup through the search box.
    const needle = String(highlight || "").trim();
    const marks = needle ? highlightRuns(text, needle) : null;
    if (marks) {
      if (body.dataset.highlighted !== `${needle}\u0000${text}`) {
        body.replaceChildren(...marks);
        body.dataset.highlighted = `${needle}\u0000${text}`;
      }
    } else {
      delete body.dataset.highlighted;
      if (body.textContent !== text) body.textContent = text;
    }
    const mentionIds = Array.isArray(message.mentionUserIds) ? [...new Set(message.mentionUserIds.filter((id) => typeof id === "string" && id))] : [];
    let mentions = row.querySelector(".collaboration-message-mentions");
    if (!hiddenSource && mentionIds.length) {
      if (!mentions) { mentions = document.createElement("small"); mentions.className = "collaboration-message-mentions"; bubble.append(mentions); }
      const label = currentUserId && mentionIds.includes(currentUserId) ? t("collaboration.mentions.you") : t("collaboration.mentions.count", { count: mentionIds.length });
      if (mentions.textContent !== label) mentions.textContent = label;
    } else mentions?.remove();
    let quote = row.querySelector(".collaboration-reply-quote");
    if (!hiddenSource && (message.replyToMessageId || message.replySnapshot)) {
      if (!quote) { quote = document.createElement("blockquote"); quote.className = "collaboration-reply-quote"; quote.dir = "auto"; bubble.insertBefore(quote, body); }
      const quoteText = replyDisplay(message.replySnapshot || { status: "unavailable", reason: "legacy" });
      if (quote.textContent !== quoteText) quote.textContent = quoteText;
    } else quote?.remove();
    let replyButton = row.querySelector('[data-action="reply-message"]');
    const reactionList = Array.isArray(message.reactions) ? message.reactions : [];
    let actions = row.querySelector(".collaboration-message-actions");
    if (!actions) { actions = document.createElement("div"); actions.className = "collaboration-message-actions"; row.append(actions); }
    let reactPicker = row.querySelector(".collaboration-reaction-picker");
    if (onReact && message.id && sequence(message) !== Infinity && !hiddenSource && canReact(message)) {
      if (!reactPicker) {
        reactPicker = document.createElement("div");
        reactPicker.className = "collaboration-reaction-picker";
        for (const emoji of QUICK_REACTIONS) {
          const button = document.createElement("button");
          button.type = "button";
          button.dataset.action = "add-reaction";
          button.dataset.emoji = emoji;
          button.textContent = emoji;
          button.setAttribute("aria-label", emoji);
          reactPicker.append(button);
        }
        actions.prepend(reactPicker);
      }
      for (const button of reactPicker.querySelectorAll("[data-emoji]")) {
        const emoji = button.dataset.emoji;
        const mine = reactionList.some((entry) => entry?.emoji === emoji && entry.mine === true);
        button.classList.toggle("is-mine", mine);
        button.onclick = () => {
          if (!node.isConnected || node.closest("[hidden]") || row.parentElement !== node) return;
          if (button.closest(".collaboration-message") !== row || !canReact(message)) return;
          onReact(message, emoji, !mine);
        };
      }
    } else reactPicker?.remove();
    if (onReply && message.id && sequence(message) !== Infinity && !hiddenSource && canReply(message)) {
      if (!replyButton) { replyButton = document.createElement("button"); replyButton.type = "button"; replyButton.dataset.action = "reply-message"; actions.append(replyButton); }
      replyButton.textContent = t("collaboration.reply.action");
      replyButton.setAttribute("aria-label", t("collaboration.reply.action"));
      replyButton.onclick = () => {
        if (node.isConnected && !node.closest("[hidden]") && row.parentElement === node && replyButton.closest(".collaboration-message") === row && canReply(message)) onReply(message);
      };
    } else replyButton?.remove();
    let editButton = row.querySelector('[data-action="edit-message"]');
    let revokeButton = row.querySelector('[data-action="revoke-message"]');
    const mutable = outgoing && !hiddenSource && message.id && sequence(message) !== Infinity;
    if (onRevoke && mutable && canRevoke(message)) {
      if (!revokeButton) { revokeButton = document.createElement("button"); revokeButton.type = "button"; revokeButton.dataset.action = "revoke-message"; actions.append(revokeButton); }
      revokeButton.textContent = t("collaboration.revoke.action");
      revokeButton.setAttribute("aria-label", t("collaboration.revoke.action"));
      revokeButton.onclick = () => { if (node.isConnected && row.parentElement === node && revokeButton.closest(".collaboration-message") === row && canRevoke(message)) onRevoke(message); };
    } else revokeButton?.remove();
    if (onEdit && mutable && canEdit(message)) {
      if (!editButton) { editButton = document.createElement("button"); editButton.type = "button"; editButton.dataset.action = "edit-message"; actions.append(editButton); }
      editButton.textContent = t("collaboration.edit.action");
      editButton.setAttribute("aria-label", t("collaboration.edit.action"));
      editButton.onclick = () => { if (node.isConnected && row.parentElement === node && editButton.closest(".collaboration-message") === row && canEdit(message)) onEdit(message); };
    } else editButton?.remove();
    // Right-click a message for WeChat's action menu: copy / quote / edit /
    // recall. It surfaces the very same guarded handlers as the hover chips, so
    // nothing here can act where a chip could not.
    row.oncontextmenu = (event) => {
      const bodyText = message.visibilityMask === "unavailable" || hiddenSource ? "" : String(message.bodyText || "");
      const menu = [];
      // WeChat's order: read actions first, destructive last, 多选 at the end.
      if (bodyText) menu.push({ label: t("collaboration.copy"), onSelect: () => { navigator.clipboard?.writeText?.(bodyText).catch(() => {}); } });
      if (onReply && message.id && sequence(message) !== Infinity && !hiddenSource && canReply(message)) menu.push({ label: t("collaboration.reply.action"), onSelect: () => { if (canReply(message)) onReply(message); } });
      if (onForward && bodyText && message.id && sequence(message) !== Infinity) menu.push({ label: t("collaboration.forward"), onSelect: () => onForward(message) });
      if (onEdit && mutable && canEdit(message)) menu.push({ label: t("collaboration.edit.action"), onSelect: () => { if (canEdit(message)) onEdit(message); } });
      if (onRevoke && mutable && canRevoke(message)) menu.push({ label: t("collaboration.revoke.action"), danger: true, onSelect: () => { if (canRevoke(message)) onRevoke(message); } });
      // 删除 removes it from THIS device only — a recall is the action above,
      // and only for your own message.
      if (onDeleteLocal && message.id) menu.push({ label: t("collaboration.deleteMessage"), danger: true, onSelect: () => onDeleteLocal(message) });
      if (selection && message.id && sequence(message) !== Infinity) menu.push({ label: t("collaboration.multiSelect"), onSelect: () => selection.enter(message.id) });
      if (!menu.length) return;
      event.preventDefault();
      openContextMenu({ x: event.clientX, y: event.clientY, items: menu });
    };
    let attachments = row.querySelector(".collaboration-message-attachments");
    const purpose = message.kind === "workspace_share" ? "workspace" : "attachment";
    if (!hiddenSource && message.attachmentIds?.length && onDownload && canDownload(purpose)) {
      if (!attachments) { attachments = document.createElement("div"); attachments.className = "collaboration-message-attachments"; bubble.append(attachments); }
      const existing = new Map([...attachments.children].map((button) => [button.dataset.objectId, button]));
      // Metadata is keyed by objectId and is OPTIONAL — an older server, or a
      // revoked message, simply yields none, and the card degrades to the bare
      // download action this used to be.
      const meta = new Map((Array.isArray(message.attachments) ? message.attachments : [])
        .map((entry) => [entry?.objectId, entry]).filter(([key]) => typeof key === "string"));
      for (const objectId of message.attachmentIds) {
        const info = meta.get(objectId) || {};
        const card = existing.get(objectId) || document.createElement("button"); card.type = "button";
        card.className = "collaboration-attachment";
        card.dataset.action = "download-attachment"; card.dataset.objectId = objectId;
        const name = typeof info.originalName === "string" && info.originalName ? info.originalName : "";
        const mimeType = typeof info.mimeType === "string" ? info.mimeType : "";
        const isImage = mimeType.startsWith("image/") || /\.(?:png|jpe?g|webp|gif|bmp)$/i.test(name);
        let thumb = card.querySelector(".collaboration-attachment-thumb");
        if (!thumb) { thumb = document.createElement("span"); thumb.className = "collaboration-attachment-thumb"; card.append(thumb); }
        let text = card.querySelector(".collaboration-attachment-text");
        if (!text) { text = document.createElement("span"); text.className = "collaboration-attachment-text"; card.append(text); }
        let title = text.querySelector("strong");
        if (!title) { title = document.createElement("strong"); text.append(title); }
        let detail = text.querySelector("small");
        if (!detail) { detail = document.createElement("small"); text.append(detail); }
        const titleText = name || t("collaboration.transfer.attachment");
        if (title.textContent !== titleText) title.textContent = titleText;
        // Size and type are the two things that decide whether a person wants
        // the download at all, so they are the subtitle rather than a tooltip.
        const detailText = [Number.isSafeInteger(info.sizeBytes) ? formatBytes(info.sizeBytes) : "",
          isImage ? t("collaboration.transfer.image") : name.includes(".") ? name.split(".").pop().toUpperCase().slice(0, 12) : ""].filter(Boolean).join(" · ")
          || t("collaboration.transfer.download");
        if (detail.textContent !== detailText) detail.textContent = detailText;
        card.dataset.kind = isImage ? "image" : "file";
        // Drawn, not an emoji: U+1F5BB rendered as a thin bar here, and glyph
        // coverage for the picture/document emoji is worse still on Windows.
        // An inline SVG is identical on every platform and inherits currentColor.
        if (!thumb.querySelector("img") && thumb.dataset.glyph !== card.dataset.kind) {
          thumb.replaceChildren(attachmentGlyph(isImage));
          thumb.dataset.glyph = card.dataset.kind;
        }
        card.onclick = () => {
          // A resolved thumbnail means the bytes are already local: open the
          // viewer instead of starting a download that would only re-fetch.
          if (card.dataset.previewed === "1" && onPreview) { void onPreview(objectId); return; }
          onDownload({ conversationId: message.conversationId, messageId: message.id, objectId }, purpose, isImage);
        };
        attachments.append(card); existing.delete(objectId);
        if (isImage && resolveAttachmentPreview && card.dataset.previewPending !== "1" && card.dataset.previewed !== "1") {
          card.dataset.previewPending = "1";
          void Promise.resolve(resolveAttachmentPreview(objectId)).then((preview) => {
            card.dataset.previewPending = "";
            // The row may have been re-rendered, reused for another message, or
            // detached while the main process was resolving the path.
            if (!preview?.url || !card.isConnected || card.dataset.objectId !== objectId) return;
            let image = thumb.querySelector("img");
            if (!image) { image = document.createElement("img"); image.alt = ""; image.loading = "lazy"; image.decoding = "async"; thumb.replaceChildren(image); }
            if (image.getAttribute("src") !== preview.url) image.setAttribute("src", preview.url);
            card.dataset.previewed = "1";
          }).catch(() => { card.dataset.previewPending = ""; });
        }
      }
      for (const button of existing.values()) button.remove();
    } else attachments?.remove();
    const status = deliveryLabel(message);
    const delivered = outgoing && isDelivered(message) && !hiddenSource;
    // Double tick means read BY EVERYONE expected to read it: the watermark is
    // the slowest peer, so a group never claims "read" from its fastest member.
    const readByPeers = delivered && Number(peerReadSeq) > 0 && Number(message.seq) <= Number(peerReadSeq);
    // The meta line is built early (it owns the timestamp) but must END the
    // bubble: appending it before the body existed put the tick to the LEFT of
    // the text. `append` on an existing child moves it, so this is idempotent.
    // Reaction chips: one per emoji with its count, "mine" highlighted. They sit
    // under the body and before the meta line so the time/tick stay last.
    let reactionRow = bubble.querySelector(".collaboration-message-reactions");
    if (reactionList.length) {
      if (!reactionRow) { reactionRow = document.createElement("div"); reactionRow.className = "collaboration-message-reactions"; bubble.append(reactionRow); }
      const seen = new Set();
      for (const entry of reactionList) {
        const emoji = String(entry?.emoji || "");
        if (!emoji) continue;
        seen.add(emoji);
        let chip = reactionRow.querySelector(`[data-emoji="${CSS.escape(emoji)}"]`);
        if (!chip) {
          chip = document.createElement("button");
          chip.type = "button";
          chip.className = "collaboration-reaction-chip";
          chip.dataset.action = "toggle-reaction";
          chip.dataset.emoji = emoji;
          reactionRow.append(chip);
        }
        chip.dataset.messageId = String(message.id || "");
        chip.classList.toggle("is-mine", entry?.mine === true);
        chip.setAttribute("aria-pressed", String(entry?.mine === true));
        const label = `${emoji} ${Number(entry?.count) || 0}`;
        if (chip.textContent !== label) chip.textContent = label;
        chip.disabled = !onReact || !canReact(message);
        chip.onclick = () => {
          if (!onReact || !node.isConnected || node.closest("[hidden]") || row.parentElement !== node) return;
          if (chip.closest(".collaboration-message") !== row || !canReact(message)) return;
          // Toggle: my own chip turns the reaction off, anyone else's adds mine.
          onReact(message, emoji, !(entry?.mine === true));
        };
      }
      for (const chip of [...reactionRow.querySelectorAll("[data-emoji]")]) {
        if (!seen.has(chip.dataset.emoji)) chip.remove();
      }
    } else reactionRow?.remove();
    // Where the meta line lives depends on whether there are reactions. With
    // none it stays a direct child so the time/tick sit INLINE at the end of a
    // short message (the Telegram trait). With reactions it moves INTO the chip
    // row: the row is full-width, so leaving the meta outside pushed it onto a
    // third line and left an L-shaped void beside the chips. Chips left, time
    // right, one row — the meta's auto inline-start margin does the pushing.
    const metaHost = reactionList.length && reactionRow ? reactionRow : bubble;
    const metaLine = bubble.querySelector(".collaboration-message-meta");
    if (metaLine && metaLine !== metaHost.lastElementChild) metaHost.append(metaLine);
    let statusChip = bubble.querySelector(".collaboration-message-status");
    if (status || delivered) {
      const metaText = status ? status.text : t(readByPeers ? "collaboration.read" : "collaboration.delivered");
      if (!statusChip) { statusChip = document.createElement("small"); statusChip.className = "collaboration-message-status"; }
      if (statusChip.parentElement !== metaLine) metaLine?.append(statusChip);
      statusChip.dataset.tone = delivered && !status
        ? (readByPeers ? "read" : "delivered")
        : (status?.tone || "delivered");
      if (statusChip.textContent !== metaText) statusChip.textContent = metaText;
      statusChip.setAttribute("aria-live", "polite");
    } else {
      statusChip?.remove();
    }
    if (node.children[index] !== row) node.insertBefore(row, node.children[index] || null);
    index += 1;
    if (prior.set.has(row)) prior.set.delete(row);
    for (const [indexedKey, indexedRow] of prior.index.entries()) if (indexedRow === row) prior.index.delete(indexedKey);
    for (const key of keyList) prior.index.set(key, row);
    previous = message;
  }
  for (const child of prior.set) child.remove();
  if (atBottom) node.scrollTop = node.scrollHeight;
  else if (anchor?.parentElement === node) node.scrollTop += anchor.getBoundingClientRect().top - viewportTop - anchorOffset;
}
