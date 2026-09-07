import { t, onLocaleChange } from "../i18n/index.js";

/** Native top-layer modal: list entries remain navigation, never a form column. */
export function enhanceCreateDisclosure(disclosure, summary, form) {
  if (!["channel", "group", "contact"].includes(form.dataset.form)) return;
  const dialog = document.createElement("dialog");
  if (typeof dialog.showModal !== "function") return;
  dialog.className = "collaboration-create-dialog";
  dialog.dataset.kind = form.dataset.form;
  const titleKey = `collaboration.social.${{ contact: "addContact", group: "createGroup", channel: "createChannel" }[form.dataset.form]}`;
  const header = document.createElement("header"), title = document.createElement("h2");
  title.dataset.i18n = titleKey; dialog.dataset.i18nAriaLabel = titleKey;
  title.textContent = t(titleKey);
  dialog.setAttribute("aria-label", title.textContent);
  const close = document.createElement("button"); close.type = "button";
  close.textContent = "×"; close.dataset.dialogDismiss = "true"; close.setAttribute("aria-label", t("common.close"));
  close.dataset.i18nAriaLabel = "common.close";
  header.append(title, close);
  const fields = document.createElement("div"); fields.className = "collaboration-dialog-fields";
  const picker = form.querySelector(".collaboration-member-picker");
  const submit = form.dataset.form === "contact" ? null : form.querySelector('button[type="submit"]');
  for (const child of [...form.children]) if (child !== picker && child !== submit) fields.append(child);
  const footer = document.createElement("footer"), cancel = document.createElement("button");
  cancel.type = "button"; cancel.dataset.dialogDismiss = "true"; cancel.textContent = t("collaboration.social.cancel");
  cancel.dataset.i18n = "collaboration.social.cancel";
  const status = document.createElement("p"); status.className = "collaboration-dialog-status";
  footer.append(status, cancel); if (submit) footer.append(submit);
  form.replaceChildren(fields); if (picker) form.append(picker); form.append(footer);
  dialog.append(header, form); disclosure.append(dialog);
  let observer = null, opening = false, unsubscribeLocale = null;
  const refreshLocale = () => {
    for (const count of form.querySelectorAll('.collaboration-picker-count')) {
      count.textContent = t("collaboration.social.selectedCount", { count: count.parentElement.querySelectorAll('.collaboration-picker-chip').length });
    }
    for (const chip of form.querySelectorAll('.collaboration-picker-chip')) {
      const label = chip.querySelector('span:last-child')?.textContent || "";
      chip.setAttribute("aria-label", `${t("collaboration.social.deselect")}: ${label}`); chip.title = chip.getAttribute("aria-label");
    }
    form.dispatchEvent(new Event("dialog-locale"));
  };
  const invalidate = () => { form.dataset.dialogEpoch = String(Number(form.dataset.dialogEpoch || 0) + 1); };
  const dismiss = () => { if (dialog.open) { invalidate(); dialog.close(); } disclosure.open = false; };
  dialog.addEventListener("cancel", invalidate);
  close.addEventListener("click", dismiss); cancel.addEventListener("click", dismiss);
  dialog.addEventListener("close", () => {
    status.removeAttribute("role");
    observer?.disconnect(); observer = null; disclosure.open = false;
    unsubscribeLocale?.(); unsubscribeLocale = null;
    form.dataset.dialogEpoch = String(Number(form.dataset.dialogEpoch || 0) + 1);
    if (summary.isConnected) summary.focus({ preventScroll: true });
  });
  disclosure.addEventListener("toggle", () => {
    if (!disclosure.open) { dismiss(); return; }
    if (dialog.open || opening || !dialog.isConnected) return;
    opening = true;
    dialog.showModal(); opening = false;
    unsubscribeLocale = onLocaleChange(refreshLocale); refreshLocale();
    title.textContent = t(titleKey); dialog.setAttribute("aria-label", title.textContent);
    status.textContent = ""; status.setAttribute("role", "status");
    let parent = disclosure.parentElement, source = null;
    while (parent && !source) { source = parent.querySelector(":scope > .collaboration-status"); parent = parent.parentElement; }
    if (source) { observer = new MutationObserver(() => { status.textContent = source.textContent; }); observer.observe(source, { childList: true, characterData: true, subtree: true }); }
    (form.querySelector('[name="title"], [name="lilyId"]') || picker?.querySelector("input"))?.focus();
  });
}
