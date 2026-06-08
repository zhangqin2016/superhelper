/**
 * Settings — feedback and contact forms.
 */

import { $ } from "./dom.js";
import { showToast } from "./toast.js";
import { t } from "../i18n/index.js";

const MAX_FEEDBACK_ATTACHMENTS = 5;
const MAX_FEEDBACK_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const FEEDBACK_ATTACHMENT_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);
const feedbackAttachments = [];

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

function revokeAttachmentUrls() {
  for (const attachment of feedbackAttachments) {
    if (attachment.previewUrl) URL.revokeObjectURL(attachment.previewUrl);
  }
}

function renderFeedbackAttachments() {
  const list = $("feedbackAttachmentList");
  if (!list) return;
  list.innerHTML = "";
  list.hidden = feedbackAttachments.length === 0;
  feedbackAttachments.forEach((attachment, index) => {
    const item = document.createElement("div");
    item.className = "feedback-attachment-item";

    const img = document.createElement("img");
    img.className = "feedback-attachment-preview";
    img.src = attachment.previewUrl;
    img.alt = attachment.file.name;
    item.appendChild(img);

    const name = document.createElement("div");
    name.className = "feedback-attachment-name";
    name.textContent = attachment.file.name;
    item.appendChild(name);

    const remove = document.createElement("button");
    remove.className = "feedback-attachment-remove";
    remove.type = "button";
    remove.textContent = "×";
    remove.addEventListener("click", () => {
      URL.revokeObjectURL(attachment.previewUrl);
      feedbackAttachments.splice(index, 1);
      renderFeedbackAttachments();
    });
    item.appendChild(remove);
    list.appendChild(item);
  });
}

function clearFeedbackAttachments() {
  revokeAttachmentUrls();
  feedbackAttachments.length = 0;
  renderFeedbackAttachments();
}

function readImageSize(file) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      const size = { width: image.naturalWidth || null, height: image.naturalHeight || null };
      URL.revokeObjectURL(url);
      resolve(size);
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      resolve({ width: null, height: null });
    };
    image.src = url;
  });
}

async function addFeedbackFiles(files, statusEl) {
  for (const file of Array.from(files || [])) {
    if (feedbackAttachments.length >= MAX_FEEDBACK_ATTACHMENTS) {
      setFormStatus(statusEl, "error", t("settings.feedbackAttachment.max"));
      break;
    }
    if (!FEEDBACK_ATTACHMENT_TYPES.has(file.type)) {
      setFormStatus(statusEl, "error", t("settings.feedbackAttachment.type"));
      continue;
    }
    if (file.size > MAX_FEEDBACK_ATTACHMENT_BYTES) {
      setFormStatus(statusEl, "error", t("settings.feedbackAttachment.size"));
      continue;
    }
    const size = await readImageSize(file);
    feedbackAttachments.push({
      file,
      previewUrl: URL.createObjectURL(file),
      width: size.width,
      height: size.height,
    });
  }
  renderFeedbackAttachments();
}

async function serializeFeedbackAttachments() {
  const serialized = [];
  for (const attachment of feedbackAttachments) {
    const data = await attachment.file.arrayBuffer();
    serialized.push({
      name: attachment.file.name,
      mimeType: attachment.file.type,
      sizeBytes: attachment.file.size,
      width: attachment.width,
      height: attachment.height,
      data,
    });
  }
  return serialized;
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
    attachments: await serializeFeedbackAttachments(),
  });

  if (submitBtn) submitBtn.disabled = false;

  if (!result?.ok) {
    setFormStatus(statusEl, "error", t("settings.feedback.failed"));
    return;
  }

  $("feedbackForm")?.reset();
  clearFeedbackAttachments();
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
  $("feedbackAttachmentBtn")?.addEventListener("click", () => {
    $("feedbackAttachmentInput")?.click();
  });
  $("feedbackAttachmentInput")?.addEventListener("change", (event) => {
    void addFeedbackFiles(event.target.files, $("feedbackFormStatus"));
    event.target.value = "";
  });
  $("feedbackForm")?.addEventListener("paste", (event) => {
    const imageFiles = Array.from(event.clipboardData?.files || []).filter((file) => file.type?.startsWith("image/"));
    if (imageFiles.length) {
      void addFeedbackFiles(imageFiles, $("feedbackFormStatus"));
    }
  });
  $("feedbackForm")?.addEventListener("submit", (event) => {
    void submitFeedback(event);
  });
  $("contactForm")?.addEventListener("submit", (event) => {
    void submitContact(event);
  });
}
