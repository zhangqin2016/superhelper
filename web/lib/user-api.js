import { cookies } from "next/headers";

export const API_BASE = process.env.API_BASE_URL || process.env.NEXT_PUBLIC_API_BASE_URL || "https://lilych.lilywb.cn";

async function userHeaders(extra = {}) {
  const store = await cookies().catch(() => null);
  const session = store?.get("lily_user_session")?.value || "";
  return {
    ...extra,
    ...(session ? { Cookie: `lily_user_session=${encodeURIComponent(session)}` } : {}),
  };
}

export async function userApiGet(path, fallback = null) {
  try {
    const response = await fetch(`${API_BASE}${path}`, {
      cache: "no-store",
      headers: await userHeaders(),
    });
    if (!response.ok) return fallback;
    return response.json();
  } catch {
    return fallback;
  }
}

export async function userApiGetResult(path) {
  try {
    const response = await fetch(`${API_BASE}${path}`, {
      cache: "no-store",
      headers: await userHeaders(),
    });
    const json = await response.json().catch(() => ({}));
    if (!response.ok || json?.ok === false) {
      return {
        ok: false,
        status: response.status,
        code: json?.code || "",
        message: json?.message || json?.error || json?.code || `API ${path} failed: ${response.status}`,
        data: null,
      };
    }
    return { ok: true, status: response.status, data: json };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      code: "NETWORK_ERROR",
      message: error instanceof Error ? error.message : "Network request failed.",
      data: null,
    };
  }
}

export async function userApiPost(path, body) {
  const response = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    cache: "no-store",
    headers: await userHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify(body || {}),
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok || json?.ok === false) {
    const code = json?.code || "";
    const message = json?.message || json?.error || code || `API ${path} failed: ${response.status}`;
    throw new Error(code && message !== code ? `${code}: ${message}` : message);
  }
  return json;
}
