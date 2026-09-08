import { t, onLocaleChange } from "../i18n/index.js";
import { identityName, resolvePerson, conversationDisplayTitle } from "./collaboration-social-ui.js";

let controller = null, dismissCurrent = null;
const tr = key => t(`collaboration.workspace.${key}`);
const node = (tag, text = "", className = "") => { const el = document.createElement(tag); el.textContent = text; el.className = className; return el; };

/** The project tree passes identity only; the center owns navigation and policy. */
export function registerWorkspaceCollaborationController(value) {
  dismissCurrent?.(); controller = value;
  return {
    invalidate() { if (controller === value) dismissCurrent?.(); },
    destroy() { if (controller === value) { dismissCurrent?.(); controller = null; } },
  };
}

export function openWorkspaceCollaboration({ projectId, name }) {
  dismissCurrent?.();
  const owner = controller, dialog = node("dialog", "", "collaboration-create-dialog workspace-collaboration-dialog");
  const header = node("header"), title = node("h2"), form = node("form", "", "collaboration-social-form");
  const fields = node("div", "", "collaboration-dialog-fields"), project = node("p", name, "collaboration-form-note");
  const label = node("label"), caption = node("span"), select = node("select"); select.name = "collaborationTarget";
  const status = node("p", "", "collaboration-dialog-status"); status.setAttribute("role", "status");
  const footer = node("footer"), cancel = node("button"), retry = node("button"), next = node("button");
  cancel.type = retry.type = "button"; next.type = "submit";
  for (const [button, action] of [[cancel, "cancel"], [retry, "retry"], [next, "continue"]]) button.dataset.action = `workspace-collaboration-${action}`;
  cancel.dataset.dialogDismiss = "true"; retry.dataset.dialogDismiss = "true";
  label.append(caption, select); fields.append(project, label, status); footer.append(retry, cancel, next); header.append(title); form.append(fields, footer); dialog.append(header, form);
  document.body.append(dialog);
  let closed = false, generation = 0, state = "loading", options = [], snapshot = null, busy = false, intent = null;
  const focus = document.activeElement;
  const paint = () => {
    title.textContent = tr("entry"); dialog.setAttribute("aria-label", title.textContent);
    caption.textContent = tr("recipient"); cancel.textContent = t("collaboration.social.cancel"); retry.textContent = tr("retry"); next.textContent = tr("continue");
    for (const group of select.querySelectorAll("optgroup")) group.label = tr(group.dataset.group);
    const placeholder = select.querySelector('option[value=""]'); if (placeholder) placeholder.textContent = tr("choose");
    status.textContent = state === "ready" ? tr("note") : tr(state);
    label.hidden = !options.length; select.disabled = busy || !!intent; retry.hidden = ["ready", "loading", "rejected"].includes(state);
    next.disabled = busy || state !== "ready" || !select.value;
  };
  const dismiss = ({ restoreFocus = true } = {}) => { if (closed) return; closed = true; generation++; unsubscribe(); if (dialog.open) dialog.close(); dialog.remove(); if (dismissCurrent === dismiss) dismissCurrent = null; if (restoreFocus && focus?.isConnected) focus.focus({ preventScroll: true }); };
  const unsubscribe = onLocaleChange(paint); dismissCurrent = dismiss;
  const valid = ticket => !closed && generation === ticket && controller === owner;
  async function load() {
    const ticket = ++generation; state = "loading"; busy = true; paint();
    let result; try { result = await owner?.read(); } catch { result = null; }
    if (!valid(ticket)) return;
    busy = false; snapshot = result;
    if (!result?.ok) { state = result?.reason || "unavailable"; paint(); return; }
    const selected = select.value, directory = result.directory, self = directory.profile.userId;
    options = (result.conversations || []).map(conversation => ({ value: `conversation:${conversation.id}`, conversationId: conversation.id,
      name: conversationDisplayTitle(conversation, { currentUserId: self, resolveName: id => identityName(resolvePerson(directory, id)) }) }));
    for (const person of directory.contacts || []) if (person.relationship === "friend" && !person.ownBlocked && person.userId !== self) options.push({ value: `friend:${person.userId}`, userId: person.userId, name: identityName(person) });
    const blocked = new Set((directory.contacts || []).filter(person => person.ownBlocked).map(person => person.userId));
    for (const team of directory.teams || []) for (const person of team.members || []) if (person.userId !== self && !blocked.has(person.userId)) options.push({ value: `team:${team.id}:${person.userId}`, userId: person.userId, organizationId: team.id, name: `${identityName(person)} · ${team.name}` });
    select.replaceChildren(); const empty = node("option", tr("choose")); empty.value = ""; select.append(empty);
    for (const category of ["conversations", "friends", "teams"]) {
      const group = node("optgroup"); group.dataset.group = category; group.label = tr(category);
      for (const option of options.filter(item => (item.conversationId ? "conversations" : item.organizationId ? "teams" : "friends") === category)) { const el = node("option", option.name); el.value = option.value; group.append(el); }
      if (group.children.length) select.append(group);
    }
    select.value = options.some(option => option.value === selected) ? selected : "";
    state = options.length ? "ready" : "empty"; paint();
  }
  async function proceed() {
    if (busy || !snapshot?.ok) return;
    const target = options.find(option => option.value === select.value); if (!target) return;
    const ticket = ++generation; busy = true; state = "loading"; paint();
    // The same intent survives uncertain responses and explicit retry. Closing
    // abandons navigation only; the durable social journal retains the command.
    intent ||= { ...target, clientCommandId: crypto.randomUUID() };
    let result;
    try { result = await owner.continue({ snapshot, target: intent, projectId, isCurrent: () => valid(ticket) }); } catch { result = null; }
    if (!valid(ticket)) return;
    busy = false;
    if (result?.ok) { dismiss({ restoreFocus: false }); result.focus?.(); return; }
    if (result?.terminal) intent = null;
    state = result?.reason || "unavailable"; paint();
  }
  select.addEventListener("change", () => { if (state === "rejected") state = "ready"; paint(); });
  form.addEventListener("submit", event => { event.preventDefault(); void proceed(); });
  cancel.addEventListener("click", dismiss); dialog.addEventListener("cancel", event => { event.preventDefault(); dismiss(); });
  retry.addEventListener("click", () => { if (intent && snapshot?.ok) void proceed(); else void load(); });
  dialog.addEventListener("keydown", event => {
    if (event.key !== "Tab") return;
    const buttons = [...dialog.querySelectorAll("button:not(:disabled),select:not(:disabled)")].filter(el => el.getClientRects().length);
    if (event.shiftKey && document.activeElement === buttons[0]) { event.preventDefault(); buttons.at(-1)?.focus(); }
    else if (!event.shiftKey && document.activeElement === buttons.at(-1)) { event.preventDefault(); buttons[0]?.focus(); }
  });
  paint(); dialog.showModal(); cancel.focus(); void load();
}
