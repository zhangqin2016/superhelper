import { adminLoadFailures, recordAdminLoadFailure } from "./admin-load-ledger.js";
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
  if (!response.ok) throw Object.assign(new Error(`API ${path} failed: ${response.status}`), { status: response.status });
  return response.json();
}

/** The raw response, for a download the caller streams back unchanged. */
export async function apiGetRaw(path) {
  return fetch(`${API_BASE}${path}`, {
    cache: "no-store",
    headers: await adminHeaders(),
  });
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
    throw new Error(json.message || json.code || `API ${path} failed: ${response.status}`);
  }
  return json;
}

// Non-throwing POST: returns { ok, status, json } so callers can surface the
// server's structured validation body (code / field / issues) instead of a
// flattened message. Additive — apiPost keeps its throwing contract.
export async function apiPostResult(path, body) {
  const response = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    cache: "no-store",
    headers: await adminHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify(body),
  });
  const json = await response.json().catch(() => ({}));
  return { ok: response.ok, status: response.status, json };
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
    throw new Error(json.message || json.code || `API ${path} failed: ${response.status}`);
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
    throw new Error(json.message || json.code || `API ${path} failed: ${response.status}`);
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
    throw new Error(json.message || json.code || `API ${path} failed: ${response.status}`);
  }
  return json;
}

/**
 * Admin reads that must never lie about failure.
 *
 * `loadAdmin` swallowed the error and returned an empty fallback, so a console
 * whose API was down looked exactly like a console with nothing configured —
 * 30 of the 81 read sites rendered "no data" for "could not ask". The fallback
 * still keeps a page rendering (half a console beats a stack trace), but the
 * failure is recorded in a per-request ledger that AdminShell shows on every
 * page. React's `cache` gives that ledger request scope, so one operator's
 * outage never bleeds into another's page.
 */
export async function loadAdmin(path, fallback) {
  try {
    return await apiGet(path);
  } catch (error) {
    recordAdminLoadFailure(adminLoadFailures(), path, error);
    return fallback;
  }
}

export { adminLoadFailures };

export { API_BASE };
