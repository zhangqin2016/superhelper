import { cookies } from "next/headers";
import { adminCredentialHeaders } from "./admin-auth-shared.mjs";

const API_BASE = process.env.API_BASE_URL || process.env.NEXT_PUBLIC_API_BASE_URL || "https://lilych.lilywb.cn";

async function adminHeaders(extra = {}) {
  const store = await cookies().catch(() => null);
  const token = store?.get("lily_admin_token")?.value || "";
  const session = store?.get("lily_admin_session")?.value || "";
  const credentials = adminCredentialHeaders({ token, session }) || {};
  return {
    ...extra,
    ...credentials,
  };
}

export async function apiGet(path) {
  const response = await fetch(`${API_BASE}${path}`, {
    cache: "no-store",
    headers: await adminHeaders(),
  });
  if (!response.ok) throw new Error(`API ${path} failed: ${response.status}`);
  return response.json();
}

export async function apiPost(path, body) {
  const response = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    cache: "no-store",
    headers: await adminHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify(body),
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(json.code || `API ${path} failed: ${response.status}`);
  }
  return json;
}

export async function apiPostForm(path, formData) {
  const response = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    cache: "no-store",
    headers: await adminHeaders(),
    body: formData,
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(json.code || `API ${path} failed: ${response.status}`);
  }
  return json;
}

export async function apiPatch(path, body) {
  const response = await fetch(`${API_BASE}${path}`, {
    method: "PATCH",
    cache: "no-store",
    headers: await adminHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify(body),
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(json.code || `API ${path} failed: ${response.status}`);
  }
  return json;
}

export async function apiDelete(path) {
  const response = await fetch(`${API_BASE}${path}`, {
    method: "DELETE",
    cache: "no-store",
    headers: await adminHeaders(),
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(json.code || `API ${path} failed: ${response.status}`);
  }
  return json;
}

export async function safeApiGet(path, fallback) {
  try {
    return await apiGet(path);
  } catch {
    return fallback;
  }
}

export { API_BASE };
