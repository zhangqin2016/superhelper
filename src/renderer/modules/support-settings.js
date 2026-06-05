/**
 * Settings — feedback and contact forms.
 */

import { $ } from "./dom.js";
import { showToast } from "./toast.js";
import { t } from "../i18n/index.js";

function setFormStatus(el, kind, message) {
  if (!el) return;
  if (!message) {
    el.hidden = true;
    el.textContent = "";
    el.className = "settings-form-status";
    return;
  }
  el.hidden = false;
  el.textContent = message;
  el.className = `settings-form-status settings-form-status--${kind}`;
}

function readValue(id) {
  const el = $(id);
  return el ? String(el.value || "").trim() : "";
}

async function submitFeedback(event) {
  event.preventDefault();
  const submitBtn = $("feedbackSubmitBtn");
  const statusEl = $("feedbackFormStatus");
  const email = readValue("feedbackEmail");
  const message = readValue("feedbackMessage");
  const category = readValue("feedbackCategory");

  if (!email || message.length < 8) {
    setFormStatus(statusEl, "error", t("settings.feedback.required"));
    return;
  }

  setFormStatus(statusEl, null, "");
  if (submitBtn) submitBtn.disabled = true;

  const result = await window.assistantClient.submitFeedback({
    name: readValue("feedbackName") || t("settings.feedback.defaultName"),
    email,
    category,
    subject: category ? `${t("settings.feedback.subjectPrefix")}: ${category}` : t("settings.feedback.subjectPrefix"),
    message,
  });

  if (submitBtn) submitBtn.disabled = false;

  if (!result?.ok) {
    setFormStatus(statusEl, "error", t("settings.feedback.failed"));
    return;
  }

  $("feedbackForm")?.reset();
  setFormStatus(statusEl, "success", t("settings.feedback.success"));
  showToast(t("settings.feedback.success"), "success");
}

async function submitContact(event) {
  event.preventDefault();
  const submitBtn = $("contactSubmitBtn");
  const statusEl = $("contactFormStatus");
  const name = readValue("contactName");
  const email = readValue("contactEmail");
  const message = readValue("contactMessage");

  if (!name || !email || message.length < 8) {
    setFormStatus(statusEl, "error", t("settings.contact.required"));
    return;
  }

  setFormStatus(statusEl, null, "");
  if (submitBtn) submitBtn.disabled = true;

  const result = await window.assistantClient.submitContact({
    name,
    email,
    company: readValue("contactCompany") || null,
    phone: readValue("contactPhone") || null,
    subject: readValue("contactSubject") || null,
    message,
  });

  if (submitBtn) submitBtn.disabled = false;

  if (!result?.ok) {
    setFormStatus(statusEl, "error", t("settings.contact.failed"));
    return;
  }

  $("contactForm")?.reset();
  setFormStatus(statusEl, "success", t("settings.contact.success"));
  showToast(t("settings.contact.success"), "success");
}

export function initSupportSettings() {
  $("feedbackForm")?.addEventListener("submit", (event) => {
    void submitFeedback(event);
  });
  $("contactForm")?.addEventListener("submit", (event) => {
    void submitContact(event);
  });
}
