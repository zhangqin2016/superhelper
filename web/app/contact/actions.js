"use server";

import { API_BASE } from "../../lib/api";

function text(formData, key) {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

export async function submitContactAction(_previousState, formData) {
  const payload = {
    name: text(formData, "name"),
    email: text(formData, "email"),
    company: text(formData, "company") || null,
    phone: text(formData, "phone") || null,
    subject: text(formData, "subject") || null,
    message: text(formData, "message"),
    source: text(formData, "source") || "website",
  };
  if (!payload.name || !payload.email || !payload.message) {
    return { ok: false, code: "required" };
  }
  if (payload.message.length < 8) {
    return { ok: false, code: "required" };
  }
  const response = await fetch(`${API_BASE}/api/contact-requests`, {
    method: "POST",
    cache: "no-store",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  }).catch(() => null);
  if (!response?.ok) {
    const json = await response?.json().catch(() => ({}));
    return { ok: false, code: json?.code === "VALIDATION_ERROR" ? "required" : "failed" };
  }
  return { ok: true, code: "success" };
}
