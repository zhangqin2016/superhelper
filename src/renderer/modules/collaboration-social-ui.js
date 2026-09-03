import { t } from "../i18n/index.js";

export function socialNode(tag, text = "", className = "") {
  const node = document.createElement(tag); node.textContent = String(text); node.className = className; return node;
}
export function socialButton(action, label, handler) {
  const node = socialNode("button", t(`collaboration.social.${label}`)); node.type = "button"; node.dataset.action = action; node.addEventListener("click", handler); return node;
}
export function avatarHue(label = "") {
  const source = String(label || "L");
  let hash = 0;
  for (let i = 0; i < source.length; i += 1) hash = (hash * 31 + source.charCodeAt(i)) >>> 0;
  return hash % 360;
}

function avatarInitial(label = "") {
  const source = String(label || "").trim();
  if (!source) return "L";
  const first = [...source][0];
  return first ? first.toUpperCase() : "L";
}

export function socialAvatar(label = "", kind = "person") {
  const avatar = socialNode("span", avatarInitial(label), `collaboration-row-avatar is-${kind}`);
  avatar.style.setProperty("--avatar-hue", String(avatarHue(label)));
  avatar.setAttribute("aria-hidden", "true");
  return avatar;
}
/**
 * A group's avatar composed from its members, the way desktop chat clients do
 * it. A single initial taken from the title gives every group whose name starts
 * with the same character an identical tile, which is exactly the case in a
 * workspace full of "设计…" and "周会…".
 *
 * Falls back to the title initial whenever there is nothing better: one member,
 * no roster, or a roster whose names have not resolved yet. So this can only
 * improve on the previous tile, never replace it with something blank.
 */
export function mosaicAvatar(title, names = [], kind = "chat") {
  const labels = (Array.isArray(names) ? names : [])
    .map((name) => String(name ?? "").trim())
    .filter(Boolean)
    .slice(0, 9);
  if (labels.length < 2) return socialAvatar(title, kind);
  const tile = socialNode("span", "", `collaboration-row-avatar is-${kind} is-mosaic`);
  tile.setAttribute("aria-hidden", "true");
  // 2x2 up to four members, 3x3 beyond: the same thresholds those clients use,
  // because a 3x3 of five cells reads as a broken grid.
  const columns = labels.length <= 4 ? 2 : 3;
  const cells = Math.min(labels.length, columns * columns);
  tile.style.setProperty("--mosaic-columns", String(columns));
  for (const label of labels.slice(0, cells)) {
    const cell = socialNode("span", avatarInitial(label), "collaboration-mosaic-cell");
    cell.style.setProperty("--avatar-hue", String(avatarHue(label)));
    tile.append(cell);
  }
  return tile;
}

export function socialDisclosure(label, form, { primary = false } = {}) {
  const disclosure = socialNode("details", "", "collaboration-disclosure");
  const summary = socialNode("summary", label, primary ? "collaboration-disclosure-trigger is-primary" : "collaboration-disclosure-trigger");
  disclosure.append(summary, form);
  form.classList.add("collaboration-disclosure-body");
  return disclosure;
}
export function socialField(form, name, label, { multiple = false, options = null } = {}) {
  const wrapper = socialNode("label", t(`collaboration.social.${label}`));
  const input = document.createElement(options ? "select" : "input"); input.name = name;
  if (options) { input.multiple = multiple; for (const [value, text] of options) { const option = socialNode("option", text); option.value = value; input.append(option); } }
  else { input.type = "text"; input.maxLength = 200; input.dir = "auto"; }
  wrapper.append(input); form.append(wrapper); return input;
}
export function selectedIds(select) { return [...select.selectedOptions].map((o) => o.value).filter(Boolean); }

/** Human-facing identity: never expose a raw opaque `usr_…` id to the user. */
export function identityName(person) {
  const displayName = typeof person?.displayName === "string" ? person.displayName.trim() : "";
  const lilyId = typeof person?.lilyId === "string" ? person.lilyId.trim() : "";
  const userId = typeof person?.userId === "string" ? person.userId : "";
  if (displayName) return displayName;
  if (lilyId) return lilyId;
  if (userId) {
    const tail = userId.length > 6 ? userId.slice(-6) : userId;
    return `${t("collaboration.social.unnamedUser")} ${tail}`;
  }
  return t("collaboration.social.unknownUser");
}

export function socialPerson(person) {
  const name = identityName(person);
  const lilyId = typeof person?.lilyId === "string" ? person.lilyId.trim() : "";
  return lilyId && lilyId !== name ? `${name} · ${lilyId}` : name;
}

const SVG_NS = "http://www.w3.org/2000/svg";

/** Line icons, drawn rather than emoji: glyph coverage for the picture/person
 *  emoji differs per platform, and an address book full of emoji reads cheap. */
const ICON_PATHS = Object.freeze({
  chat: ["M20 12a8 8 0 0 1-11.6 7.1L4 20l.9-4.4A8 8 0 1 1 20 12z"],
  remove: ["M9 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7z", "M2.5 20a6.5 6.5 0 0 1 13 0", "M17 12h5"],
  block: ["M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z", "M6 6l12 12"],
  people: ["M8.5 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7z", "M2 20a6.5 6.5 0 0 1 13 0", "M16 4.5a3.5 3.5 0 0 1 0 7", "M17 14.5a6.5 6.5 0 0 1 5 5.5"],
  plus: ["M12 5v14", "M5 12h14"],
  channel: ["M4 9h16", "M4 15h16", "M10 4l-1.5 16", "M16 4l-1.5 16"],
  chevron: ["M9 5l7 7-7 7"],
  request: ["M12 3a4 4 0 1 0 0 8 4 4 0 0 0 0-8z", "M4 21a8 8 0 0 1 12-6.9", "M17 17h5", "M19.5 14.5v5"],
});

export function socialIcon(name, size = 18) {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.6");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  for (const d of ICON_PATHS[name] || ICON_PATHS.chevron) {
    const path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("d", d);
    svg.append(path);
  }
  return svg;
}

/** An action reduced to its icon. The label survives as the accessible name and
 *  the tooltip, so nothing is lost by taking the words off a 56px row. */
export function socialIconButton(action, label, icon, handler, { tone = "" } = {}) {
  const node = document.createElement("button");
  node.type = "button";
  node.className = "collaboration-icon-action";
  node.dataset.action = action;
  if (tone) node.dataset.tone = tone;
  const text = t(`collaboration.social.${label}`);
  node.setAttribute("aria-label", text);
  node.title = text;
  node.append(socialIcon(icon));
  node.addEventListener("click", handler);
  return node;
}

/** Rows are 56px and clickable as a whole; the primary action is the row body,
 *  so it is a real button rather than a div with a click handler. */
export function socialRowButton(label, handler, { icon = null, avatar = null, subtitle = "", trailing = "" } = {}) {
  const node = document.createElement("button");
  node.type = "button";
  node.className = "collaboration-row-open";
  if (avatar) node.append(avatar);
  else if (icon) { const wrap = socialNode("span", "", "collaboration-row-glyph"); wrap.append(socialIcon(icon, 20)); node.append(wrap); }
  const content = socialNode("div", "", "collaboration-row-content");
  content.append(socialNode("strong", label));
  if (subtitle) content.append(socialNode("small", subtitle));
  node.append(content);
  if (trailing) node.append(socialNode("span", trailing, "collaboration-row-trailing"));
  if (handler) node.addEventListener("click", handler);
  return node;
}

/** Resolve a person object for a user id across profile, contacts, and team
 *  members. Falls back to a bare `{ userId }` so `identityName` can still
 *  render a friendly placeholder instead of a raw opaque id. */
export function resolvePerson(directory, userId) {
  const id = String(userId || "");
  if (!id) return { userId: id };
  if (directory?.profile?.userId === id) return directory.profile;
  return directory?.contacts?.find((contact) => contact.userId === id)
    || directory?.teams?.flatMap((team) => team.members || []).find((member) => member.userId === id)
    || { userId: id };
}

/** Shared presentation lifecycle, not a command retry engine. IDs live in main. */
export function createSocialUi(root, { onChanged = async () => {}, getNavigationGeneration = () => 0 } = {}) {
  let epoch = 0, busy = false, cancelConfirmation = null;
  let disabled = [];
  const status = socialNode("p", "", "collaboration-status"); status.setAttribute("role", "status");
  const confirmation = socialNode("div", "", "collaboration-confirmation");
  const pending = socialNode("div", "", "collaboration-pending");
  root.append(status, confirmation, pending);
  const restore = () => { for (const [control, prior] of disabled) control.disabled = prior; disabled = []; };
  return {
    status,
    current: () => epoch,
    reset() { epoch += 1; busy = false; restore(); cancelConfirmation?.(); confirmation.replaceChildren(); pending.replaceChildren(); status.textContent = ""; },
    async confirm(label, target) {
      if (busy) return false;
      cancelConfirmation?.();
      return new Promise((resolve) => {
        const focused = document.activeElement;
        confirmation.replaceChildren(socialNode("p", `${t(`collaboration.social.${label}`)}: ${target}`));
        confirmation.setAttribute("role", "alertdialog"); confirmation.setAttribute("aria-label", t(`collaboration.social.${label}`));
        const finish = (accepted) => { cancelConfirmation = null; confirmation.replaceChildren(); confirmation.removeAttribute("role"); focused?.focus?.(); resolve(accepted); };
        cancelConfirmation = () => finish(false);
        const yes = socialButton("confirm", "confirm", () => finish(true));
        confirmation.append(yes, socialButton("cancel-confirmation", "cancel", () => finish(false))); yes.focus();
      });
    },
    async run(operation, onSuccess = async () => {}) {
      if (busy) return;
      const generation = epoch; busy = true;
      const navigation = getNavigationGeneration();
      disabled = [...root.querySelectorAll("button,input,select")].map((control) => [control, control.disabled]);
      for (const [control] of disabled) control.disabled = true;
      status.textContent = t("collaboration.social.loading");
      let result;
      try { result = await operation(); } catch { result = { ok: true, state: "confirming" }; }
      if (generation !== epoch) return;
      const rejected = result?.ok === false;
      const uncertain = !result || ["confirming", "queued", "submitting"].includes(result.state);
      status.textContent = t(`collaboration.social.${rejected ? /FORBIDDEN|ACCESS_REVOKED|MEMBERSHIP/.test(result.code || "") ? "permissionDenied" : "failed" : uncertain ? "confirming" : "saved"}`);
      if (result?.code === "COLLAB_DEVICE_CHANGED") status.textContent = t("collaboration.social.deviceChanged");
      try {
        await Promise.resolve(onChanged()).catch(() => {});
        if (generation !== epoch) return;
        if (!rejected && !uncertain) await onSuccess(result, { isCurrentNavigation: () => navigation === getNavigationGeneration() });
      } catch { if (generation === epoch) status.textContent = t("collaboration.social.unavailable"); }
      finally { if (generation === epoch) { busy = false; restore(); } }
    },
    renderPending(commands, kind, api, scopeLabel = () => "") {
      pending.replaceChildren();
      for (const command of commands.filter((c) => c.kind === kind)) {
        const row = socialNode("div", "", "collaboration-social-row");
        const input = command.input || {};
        const target = input.lilyId || input.title || "";
        row.append(socialNode("p", `${t("collaboration.social.confirming")} · ${t(`collaboration.social.action.${input.action}`)}${target ? ` · ${target}` : ""} · ${scopeLabel(command.scopeId)}`));
        row.append(socialButton("retry", "retry", () => this.run(() => api.retrySocial(command.clientCommandId)))); pending.append(row);
      }
    },
  };
}
