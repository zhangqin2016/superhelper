import { t } from "../i18n/index.js";

export function socialNode(tag, text = "", className = "") {
  const node = document.createElement(tag); node.textContent = String(text); node.className = className; return node;
}
export function socialButton(action, label, handler) {
  const node = socialNode("button", t(`collaboration.social.${label}`)); node.type = "button"; node.dataset.action = action; node.addEventListener("click", handler); return node;
}
export function socialAvatar(label = "", kind = "person") {
  const avatar = socialNode("span", String(label).trim().slice(0, 1).toUpperCase() || "L", `collaboration-row-avatar is-${kind}`);
  avatar.setAttribute("aria-hidden", "true");
  return avatar;
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
export function socialPerson(person) { return `${person.displayName || person.lilyId || person.userId} · ${person.lilyId || person.userId}`; }

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
        row.append(socialNode("p", `${t("collaboration.social.confirming")} · ${t(`collaboration.social.action.${input.action}`)} · ${input.lilyId || input.peerUserId || input.requestId || input.title || input.conversationId || ""} · ${scopeLabel(command.scopeId)}`));
        row.append(socialButton("retry", "retry", () => this.run(() => api.retrySocial(command.clientCommandId)))); pending.append(row);
      }
    },
  };
}
