import { t, onLocaleChange } from "../i18n/index.js";
import { identityName } from "./collaboration-social-ui.js";

// Text is only a search aid. The composer owns explicit, stable recipient IDs.
function queryAtCaret(textarea) {
  const end = textarea.selectionStart;
  if (end !== textarea.selectionEnd) return null;
  const text = textarea.value, match = /(?:^|\s)@([^\s@]*)$/u.exec(text.slice(0, end));
  return match ? { text, start: end - match[1].length - 1, end, query: match[1] } : null;
}

export function initCollaborationMentions({ textarea, getIds, onChange }) {
  // Optional inline DOM must not disable the existing text-only composer.
  if (!textarea.ownerDocument?.createElement || !textarea.before) return { input() {}, handleKeydown: () => false, refresh() {}, update() {}, setContext() {}, reset() {}, destroy() {} };
  const document = textarea.ownerDocument;
  const root = document.createElement("div");
  root.className = "collaboration-mentions";
  textarea.before(root);
  let conversationId = "", active = true, disposed = false, generation = 0, request = 0;
  let opened = false, query = null, queryMode = false, items = [], status = "unknown", selected = 0;
  let button, picker, tags, notice, list, retry, closeButton, hint;
  const visible = () => !disposed && active && Boolean(conversationId) && root.isConnected && !root.closest("[hidden]");
  const identity = (item) => (typeof item?.lilyId === "string" && item.lilyId.trim()) ? item.lilyId.trim() : "";
  const label = (item) => { const name = identityName(item); const lilyId = identity(item); return lilyId && lilyId !== name ? `${name} · ${lilyId}` : name; };
  const filtered = () => {
    const needle = (query?.query || "").toLocaleLowerCase();
    return items.filter((item) => [item.displayName, item.lilyId, item.userId].some((value) => String(value || "").toLocaleLowerCase().includes(needle)));
  };
  const validAction = (element, epoch) => visible() && epoch === generation && element.isConnected && root.contains(element) && !element.closest("[hidden]");
  function close({ focus = false } = {}) {
    opened = false; query = null; queryMode = false; request += 1;
    // A closed picker never retains actionable candidate buttons.
    paintPicker();
    if (focus && visible()) textarea.focus();
  }
  function choose(userId, element, epoch) {
    if (!validAction(element, epoch) || !opened || status !== "complete" || !items.some((item) => item.userId === userId)) return;
    const ids = getIds();
    if (!ids.includes(userId) && ids.length >= 1000) { notice.textContent = t("collaboration.mentions.limit"); return; }
    let text = textarea.value;
    const now = queryAtCaret(textarea);
    const consumes = query && now && now.text === query.text && now.start === query.start && now.end === query.end;
    if (consumes) text = text.slice(0, query.start) + text.slice(query.end);
    const caret = consumes ? query.start : textarea.selectionStart;
    onChange({ text, mentionUserIds: [...new Set([...ids, userId])].sort() });
    textarea.setSelectionRange(caret, caret);
    close({ focus: true });
  }
  function paintTags() {
    tags.replaceChildren();
    tags.setAttribute("aria-label", t("collaboration.mentions.selected"));
    if (!active || !conversationId) return;
    const epoch = generation, profiles = new Map(items.map((item) => [item.userId, item]));
    for (const userId of getIds()) {
      const tag = document.createElement("span"), text = document.createElement("span"), remove = document.createElement("button");
      tag.className = "collaboration-mention-tag"; text.dir = "auto";
      const profile = profiles.get(userId), name = profile ? label(profile) : userId;
      text.textContent = status === "complete" && !profile ? `${name} · ${t("collaboration.mentions.unavailable")}` : name;
      remove.type = "button"; remove.dataset.action = "remove-mention"; remove.dataset.userId = userId;
      remove.textContent = "×"; remove.setAttribute("aria-label", t("collaboration.mentions.remove", { name }));
      remove.onclick = () => {
        if (!validAction(remove, epoch)) return;
        onChange({ text: textarea.value, mentionUserIds: getIds().filter((id) => id !== userId) });
        textarea.focus();
      };
      tag.append(text, remove); tags.append(tag);
    }
  }
  function paintPicker() {
    picker.hidden = !opened || !active || !conversationId;
    button.setAttribute("aria-expanded", String(!picker.hidden));
    textarea.setAttribute("aria-expanded", String(!picker.hidden));
    textarea.removeAttribute("aria-activedescendant");
    list.replaceChildren();
    retry.hidden = true; notice.textContent = "";
    if (picker.hidden) return;
    const matches = filtered();
    notice.textContent = t(`collaboration.mentions.${status === "complete" ? matches.length ? "results" : "noMatch" : status}`, { count: matches.length });
    retry.hidden = status !== "failed";
    if (status !== "complete") return;
    selected = Math.max(0, Math.min(selected, matches.length - 1));
    const epoch = generation;
    for (const [index, item] of matches.entries()) {
      const option = document.createElement("button"); option.type = "button";
      option.id = `collaborationMentionOption-${index}`;
      option.dataset.action = "select-mention"; option.dataset.userId = item.userId;
      option.setAttribute("role", "option"); option.setAttribute("aria-selected", String(index === selected));
      option.textContent = label(item); option.dir = "auto";
      option.onclick = () => choose(item.userId, option, epoch);
      list.append(option);
    }
    if (matches.length) textarea.setAttribute("aria-activedescendant", `collaborationMentionOption-${selected}`);
  }
  function paint() {
    root.hidden = !active || !conversationId;
    button.textContent = t("collaboration.mentions.action"); button.setAttribute("aria-label", t("collaboration.mentions.action"));
    hint.textContent = t("collaboration.mentions.hint");
    closeButton.textContent = t("collaboration.mentions.close"); retry.textContent = t("collaboration.mentions.retry");
    list.setAttribute("aria-label", t("collaboration.mentions.candidates"));
    paintTags(); paintPicker();
  }
  function build() {
    root.replaceChildren();
    const make = (tag, id, parent = root) => { const node = document.createElement(tag); if (id) node.id = id; parent.append(node); return node; };
    button = make("button", "collaborationMentionButton"); button.type = "button"; button.setAttribute("aria-controls", "collaborationMentionPicker");
    button.className = "collaboration-mention-manual-entry";
    tags = make("div", "collaborationMentionTags");
    hint = make("small", "collaborationMentionHint");
    hint.className = "collaboration-mention-permanent-hint";
    picker = make("div", "collaborationMentionPicker");
    closeButton = make("button", "", picker); closeButton.type = "button"; closeButton.dataset.action = "close-mentions";
    notice = make("div", "collaborationMentionStatus", picker); notice.setAttribute("role", "status");
    retry = make("button", "", picker); retry.type = "button"; retry.dataset.action = "retry-mentions";
    list = make("div", "collaborationMentionList", picker); list.setAttribute("role", "listbox");
    const epoch = generation, entry = button, retryAction = retry, closeAction = closeButton;
    button.onclick = () => { if (validAction(entry, epoch)) { open(null); textarea.focus(); } };
    retry.onclick = () => { if (validAction(retryAction, epoch)) refresh(); };
    closeButton.onclick = () => { if (validAction(closeAction, epoch)) close({ focus: true }); };
    paint();
  }
  function refresh() {
    const ticket = ++request, epoch = generation, id = conversationId;
    items = []; status = "unknown";
    if (!visible() || (!opened && !getIds().length)) { paint(); return; }
    status = "loading"; paint();
    const current = () => visible() && id === conversationId && epoch === generation && ticket === request;
    let value;
    try { value = window.assistantClient?.collaboration?.getMentionCandidates?.(id); }
    catch { if (current()) { status = "failed"; paint(); } return; }
    void Promise.resolve(value).then((result) => {
      if (!current()) return;
      if (!result || (result.ok && result.conversationId === id && result.mentionCandidates?.status === "unknown")) status = "unknown";
      else if (result.ok && result.conversationId === id && result.mentionCandidates?.status === "complete" && Array.isArray(result.mentionCandidates.items) && result.mentionCandidates.items.length <= 1000) {
        items = result.mentionCandidates.items; status = "complete";
      } else status = "failed";
      paint();
    }).catch(() => { if (current()) { status = "failed"; paint(); } });
  }
  function open(range) {
    if (!visible()) return;
    opened = true; query = range; queryMode = Boolean(range); selected = 0; refresh();
  }
  function input() {
    if (!visible()) return;
    const range = queryAtCaret(textarea);
    if (!opened && range) open(range);
    else if (opened) {
      if (queryMode && !range) { close(); return; }
      query = range; selected = 0; paintPicker();
    }
  }
  function handleKeydown(event) {
    if (!visible() || !opened || event.isComposing || event.keyCode === 229) return false;
    if (event.key === "Escape" || event.key === "Tab") { if (event.key === "Escape") event.preventDefault(); close(); return true; }
    if (event.key === "Enter") {
      if (!event.shiftKey) {
        event.preventDefault();
        list.children[selected]?.click();
      }
      return true;
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return false;
    event.preventDefault();
    const count = list.children.length;
    if (count) {
      selected = (selected + (event.key === "ArrowDown" ? 1 : -1) + count) % count;
      for (const [index, option] of [...list.children].entries()) option.setAttribute("aria-selected", String(index === selected));
      textarea.setAttribute("aria-activedescendant", list.children[selected].id);
      list.children[selected].scrollIntoView({ block: "nearest" });
    }
    return true;
  }
  const pickerKeydown = (event) => {
    // These controls are native buttons: returning alone still activates them.
    // The textarea is outside this root and retains its normal IME handling.
    if (event.isComposing || event.keyCode === 229) { event.preventDefault(); return; }
    if (!visible() || !opened) return;
    if (event.key === "Escape" || event.key === "Tab") { if (event.key === "Escape") event.preventDefault(); close({ focus: event.key === "Escape" }); }
    else if (["ArrowUp", "ArrowDown"].includes(event.key) && event.target.dataset.action === "select-mention") {
      selected = [...list.children].indexOf(event.target); handleKeydown(event); list.children[selected]?.focus();
    }
  };
  root.addEventListener("keydown", pickerKeydown);
  textarea.setAttribute("aria-controls", "collaborationMentionList");
  const description = textarea.getAttribute("aria-describedby");
  textarea.setAttribute("aria-describedby", [description, "collaborationMentionHint"].filter(Boolean).join(" "));
  const unsubscribe = onLocaleChange(paint);
  build();
  return {
    input, handleKeydown, refresh, update: paintTags,
    setContext(id, enabled) {
      if (disposed || (id === conversationId && active === Boolean(enabled))) return;
      conversationId = id; active = Boolean(enabled); generation += 1; request += 1;
      opened = false; query = null; queryMode = false; items = []; status = "unknown"; build();
    },
    reset() { generation += 1; request += 1; conversationId = ""; opened = false; query = null; items = []; status = "unknown"; build(); },
    destroy() {
      disposed = true; generation += 1; request += 1; items = []; query = null; unsubscribe();
      root.removeEventListener("keydown", pickerKeydown); root.remove();
      for (const attr of ["aria-controls", "aria-expanded", "aria-activedescendant"]) textarea.removeAttribute(attr);
      if (description) textarea.setAttribute("aria-describedby", description); else textarea.removeAttribute("aria-describedby");
    },
  };
}
