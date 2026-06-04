import { cookies } from "next/headers";

const API_BASE = process.env.API_BASE_URL || process.env.NEXT_PUBLIC_API_BASE_URL || "https://lily.lanrensoft.cn";

async function adminHeaders(extra = {}) {
  const store = await cookies().catch(() => null);
  const token = process.env.ADMIN_TOKEN || store?.get("lily_admin_token")?.value || "";
  const session = store?.get("lily_admin_session")?.value || "";
  return {
    ...extra,
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(!token && session ? { Cookie: `lily_admin_session=${encodeURIComponent(session)}` } : {}),
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
